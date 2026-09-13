from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
import re
from threading import Lock
from typing import Dict, List, Optional
from uuid import uuid4

from app.db.session import begin_writer
from app.db.tab_state_sql import delete_tab_state_row, fetch_tab_state_row, upsert_tab_state_row
from app.security.encryption import (
    get_encryption_service,
    get_encryption_service_with_token,
    is_encryption_required,
)
from app.services.root_sorting import SORT_MODE_NORMAL, normalize_sort_mode
from app.services.input_errors import InputRejected


_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{12}$"
)


def _is_uuid_string(value: str) -> bool:
    if not isinstance(value, str):
        return False
    if not value:
        return False
    if _UUID_RE.match(value) is None:
        return False
    return True


class TabStateStore:
    """Server-owned tab state with namespace-scoped persistence in SQLite."""

    _MAX_TABS = 1000

    def __init__(self) -> None:
        self._lock = Lock()
        self._encrypted_state_json: Optional[str] = None
        self._encrypted_state_nonce: Optional[bytes] = None
        self._encrypted_state_tag: Optional[bytes] = None
        self._install_default_state_locked(version=0)

    def bootstrap(self, *, connection) -> None:
        row = fetch_tab_state_row(connection)
        with self._lock:
            if row is None:
                self._clear_encrypted_state_locked()
                self._install_default_state_locked(version=0)
                return

            state_json = row["state_json"]
            nonce = row["state_encryption_nonce"]
            tag = row["state_encryption_tag"]
            if not isinstance(state_json, str):
                raise TypeError("tab_state.state_json must be a string")
            if (nonce is None) != (tag is None):
                raise RuntimeError(
                    "tab_state row has incomplete encryption metadata: "
                    f"nonce={nonce is not None} tag={tag is not None}"
                )

            if nonce is None:
                snapshot = self._deserialize_snapshot_json(state_json)
                self._apply_snapshot_locked(snapshot)
                self._clear_encrypted_state_locked()
                return

            self._encrypted_state_json = state_json
            self._encrypted_state_nonce = nonce
            self._encrypted_state_tag = tag
            self._install_default_state_locked(version=0)
            self._try_decrypt_locked(token="", require_success=False)

    def ensure_decrypted(self, *, token: str) -> None:
        if not isinstance(token, str):
            raise TypeError("token must be a string")
        with self._lock:
            self._try_decrypt_locked(token=token, require_success=True)

    def snapshot(self) -> Dict[str, object]:
        with self._lock:
            self._try_decrypt_locked(token="", require_success=False)
            return self._snapshot_locked()

    def reset(self) -> None:
        with self._lock:
            next_version = self._version + 1
            self._clear_encrypted_state_locked()
            self._install_default_state_locked(version=next_version)

    def clear_persisted_state_for_tests(self) -> None:
        with begin_writer() as connection:
            delete_tab_state_row(connection)
        with self._lock:
            self._clear_encrypted_state_locked()
            self._install_default_state_locked(version=0)

    def create_tab(self, *, copy_from_tab_id: str) -> Dict[str, object]:
        if not isinstance(copy_from_tab_id, str) or not copy_from_tab_id:
            raise InputRejected("copyFromTabId must be a non-empty string")
        if not _is_uuid_string(copy_from_tab_id):
            raise InputRejected("copyFromTabId must be a UUID string")

        with self._lock:
            self._try_decrypt_locked(token="", require_success=True)
            if copy_from_tab_id not in self._tabs:
                raise InputRejected("copyFromTabId must reference an existing tab")
            if len(self._tabs) >= self._MAX_TABS:
                raise InputRejected(f"max tabs reached ({self._MAX_TABS})")

            new_tab_id = self._new_tab_id()
            while new_tab_id in self._tabs:
                new_tab_id = self._new_tab_id()

            source = deepcopy(self._tabs[copy_from_tab_id])
            self._tabs[new_tab_id] = source
            self._tab_order.append(new_tab_id)
            self._version += 1
            self._persist_locked(connection=None, encryption_service=None, force_plaintext=False)
            snapshot = self._snapshot_locked()
            snapshot["newTabId"] = new_tab_id
            return snapshot

    def delete_tab(self, *, tab_id: str) -> Dict[str, object]:
        if not isinstance(tab_id, str) or not tab_id:
            raise InputRejected("tabId must be a non-empty string")
        if not _is_uuid_string(tab_id):
            raise InputRejected("tabId must be a UUID string")

        with self._lock:
            self._try_decrypt_locked(token="", require_success=True)
            if tab_id not in self._tabs:
                raise InputRejected("tabId must reference an existing tab")
            if len(self._tabs) <= 1:
                raise InputRejected("cannot delete the last remaining tab")

            was_active = tab_id == self._active_tab_id
            order = list(self._tab_order)
            idx = order.index(tab_id)
            order.pop(idx)
            del self._tabs[tab_id]

            if was_active:
                if idx < len(order):
                    next_active = order[idx]
                else:
                    next_active = order[idx - 1]
                self._active_tab_id = next_active

            self._tab_order = order
            self._version += 1
            self._persist_locked(connection=None, encryption_service=None, force_plaintext=False)
            return self._snapshot_locked()

    def update(
        self,
        *,
        active_tab_id: str,
        tabs: Dict[str, Dict[str, object]],
        tab_order: List[str],
    ) -> Dict[str, object]:
        normalized_tabs = self._normalize_tabs(tabs)
        normalized_order = self._normalize_tab_order(tab_order, normalized_tabs)
        if active_tab_id not in normalized_tabs:
            raise InputRejected("activeTabId must reference an existing tab")
        with self._lock:
            self._try_decrypt_locked(token="", require_success=True)
            existing_ids = set(self._tabs.keys())
            incoming_ids = set(normalized_tabs.keys())
            if incoming_ids != existing_ids:
                raise InputRejected("tab ids mismatch; use tab-state new/delete endpoints")
            self._tabs = normalized_tabs
            self._active_tab_id = active_tab_id
            self._tab_order = normalized_order
            self._version += 1
            self._persist_locked(connection=None, encryption_service=None, force_plaintext=False)
            return self._snapshot_locked()

    def get_sort_mode(self, *, tab_id: Optional[str]) -> str:
        with self._lock:
            self._try_decrypt_locked(token="", require_success=True)
            if tab_id is None:
                target_tab_id = self._active_tab_id
            else:
                target_tab_id = tab_id
            if target_tab_id not in self._tabs:
                raise InputRejected("tab_id must reference an existing tab")
            value = self._tabs[target_tab_id]["sortMode"]
            return normalize_sort_mode(value)

    def get_active_tab_id(self) -> str:
        with self._lock:
            self._try_decrypt_locked(token="", require_success=True)
            if self._active_tab_id not in self._tabs:
                raise RuntimeError("Active tab id is missing from tab state")
            return self._active_tab_id

    def get_search_query(self, *, tab_id: Optional[str]) -> str:
        with self._lock:
            self._try_decrypt_locked(token="", require_success=True)
            if tab_id is None:
                target_tab_id = self._active_tab_id
            else:
                target_tab_id = tab_id
            if target_tab_id not in self._tabs:
                raise InputRejected("tab_id must reference an existing tab")
            value = self._tabs[target_tab_id]["searchQuery"]
            if not isinstance(value, str):
                raise RuntimeError("Tab searchQuery must be a string")
            return value

    def set_sort_mode(self, *, tab_id: str, sort_mode: str) -> Dict[str, object]:
        if not isinstance(tab_id, str) or not tab_id:
            raise InputRejected("tabId must be a non-empty string")
        normalized_sort_mode = normalize_sort_mode(sort_mode)

        with self._lock:
            self._try_decrypt_locked(token="", require_success=True)
            if tab_id not in self._tabs:
                raise InputRejected("tabId must reference an existing tab")

            entry = self._tabs[tab_id]
            changed = entry["sortMode"] != normalized_sort_mode
            if changed:
                entry["sortMode"] = normalized_sort_mode
                entry["scrollY"] = 0
                entry["scrollAnchor"] = None
                entry["anchorRootId"] = None
                self._version += 1
                self._persist_locked(connection=None, encryption_service=None, force_plaintext=False)

            snapshot = self._snapshot_locked()
            snapshot["changed"] = changed
            return snapshot

    def rewrite_persisted_state(
        self,
        *,
        encryption_service: object | None,
        force_plaintext: bool,
        connection,
    ) -> None:
        if not isinstance(force_plaintext, bool):
            raise TypeError("force_plaintext must be a bool")
        with self._lock:
            self._try_decrypt_locked(token="", require_success=True)
            self._persist_locked(
                connection=connection,
                encryption_service=encryption_service,
                force_plaintext=force_plaintext,
            )

    def _install_default_state_locked(self, *, version: int) -> None:
        if not isinstance(version, int) or version < 0:
            raise TypeError("version must be a non-negative int")
        default_tab_id = self._new_tab_id()
        self._active_tab_id = default_tab_id
        self._tabs: Dict[str, Dict[str, object]] = {
            default_tab_id: {
                "searchQuery": "",
                "scrollY": 0,
                "anchorRootId": None,
                "scrollAnchor": None,
                "sortMode": SORT_MODE_NORMAL,
            }
        }
        self._tab_order = [default_tab_id]
        self._version = version

    def _snapshot_locked(self) -> Dict[str, object]:
        return {
            "activeTabId": self._active_tab_id,
            "tabs": deepcopy(self._tabs),
            "tabOrder": list(self._tab_order),
            "version": self._version,
        }

    def _serialize_snapshot_locked(self) -> str:
        return json.dumps(self._snapshot_locked(), separators=(",", ":"), sort_keys=True)

    def _deserialize_snapshot_json(self, payload: str) -> Dict[str, object]:
        if not isinstance(payload, str) or payload == "":
            raise InputRejected("tab-state payload must be a non-empty string")
        parsed = json.loads(payload)
        if not isinstance(parsed, dict):
            raise RuntimeError("tab-state JSON payload must be an object")
        if "activeTabId" not in parsed or "tabs" not in parsed or "tabOrder" not in parsed or "version" not in parsed:
            raise RuntimeError("tab-state JSON payload missing required keys")
        active_tab_id = parsed["activeTabId"]
        tabs = parsed["tabs"]
        tab_order = parsed["tabOrder"]
        version = parsed["version"]
        if not isinstance(active_tab_id, str) or active_tab_id == "":
            raise RuntimeError("tab-state JSON activeTabId must be a non-empty string")
        if not isinstance(version, int) or version < 0:
            raise RuntimeError("tab-state JSON version must be a non-negative integer")
        if not isinstance(tab_order, list):
            raise RuntimeError("tab-state JSON tabOrder must be a list")
        return {
            "activeTabId": active_tab_id,
            "tabs": self._normalize_tabs(tabs),
            "tabOrder": [str(entry) for entry in tab_order],
            "version": version,
        }

    def _apply_snapshot_locked(self, snapshot: Dict[str, object]) -> None:
        if not isinstance(snapshot, dict):
            raise TypeError("snapshot must be an object")
        active_tab_id = snapshot["activeTabId"]
        tabs = snapshot["tabs"]
        tab_order = snapshot["tabOrder"]
        version = snapshot["version"]
        if not isinstance(active_tab_id, str) or active_tab_id == "":
            raise RuntimeError("snapshot activeTabId must be a non-empty string")
        if not isinstance(version, int) or version < 0:
            raise RuntimeError("snapshot version must be a non-negative integer")
        if not isinstance(tabs, dict):
            raise RuntimeError("snapshot tabs must be an object")
        if not isinstance(tab_order, list):
            raise RuntimeError("snapshot tabOrder must be a list")
        normalized_tabs = self._normalize_tabs(tabs)
        normalized_order = self._normalize_tab_order(tab_order, normalized_tabs)
        if active_tab_id not in normalized_tabs:
            raise RuntimeError("snapshot activeTabId must reference an existing tab")
        self._tabs = normalized_tabs
        self._tab_order = normalized_order
        self._active_tab_id = active_tab_id
        self._version = version

    def _try_decrypt_locked(self, *, token: str, require_success: bool) -> None:
        if self._encrypted_state_json is None:
            return
        if self._encrypted_state_nonce is None or self._encrypted_state_tag is None:
            raise RuntimeError("encrypted tab-state payload missing nonce/tag")
        service = self._resolve_encryption_service(token=token, explicit_service=None)
        if service is None:
            if require_success:
                raise RuntimeError("tab-state decryption requires an active DEK")
            return
        decrypt_fn = getattr(service, "decrypt_from_storage", None)
        if not callable(decrypt_fn):
            raise TypeError("encryption service must expose decrypt_from_storage")
        plaintext = decrypt_fn(
            self._encrypted_state_json,
            self._encrypted_state_nonce,
            self._encrypted_state_tag,
        )
        if not isinstance(plaintext, str):
            raise TypeError("decrypted tab-state payload must be a string")
        snapshot = self._deserialize_snapshot_json(plaintext)
        self._apply_snapshot_locked(snapshot)
        self._clear_encrypted_state_locked()

    def _persist_locked(
        self,
        *,
        connection,
        encryption_service: object | None,
        force_plaintext: bool,
    ) -> None:
        if not isinstance(force_plaintext, bool):
            raise TypeError("force_plaintext must be a bool")
        snapshot_json = self._serialize_snapshot_locked()
        stored_json = snapshot_json
        nonce: Optional[bytes] = None
        tag: Optional[bytes] = None

        if not force_plaintext:
            service = self._resolve_encryption_service(
                token="",
                explicit_service=encryption_service,
            )
            if service is not None:
                encrypt_fn = getattr(service, "encrypt_for_storage", None)
                if not callable(encrypt_fn):
                    raise TypeError("encryption service must expose encrypt_for_storage")
                stored_json, nonce, tag = encrypt_fn(snapshot_json)
            elif is_encryption_required():
                raise RuntimeError("tab-state persistence requires an active DEK")

        now = datetime.now(timezone.utc)
        if connection is not None:
            upsert_tab_state_row(
                connection,
                state_json=stored_json,
                state_encryption_nonce=nonce,
                state_encryption_tag=tag,
                updated_at=now,
            )
            return
        with begin_writer() as writer_connection:
            upsert_tab_state_row(
                writer_connection,
                state_json=stored_json,
                state_encryption_nonce=nonce,
                state_encryption_tag=tag,
                updated_at=now,
            )

    def _resolve_encryption_service(self, *, token: str, explicit_service: object | None):
        if explicit_service is not None:
            dek = getattr(explicit_service, "dek", None)
            if dek is None:
                raise RuntimeError("explicit encryption service must have an active DEK")
            return explicit_service
        if token:
            return get_encryption_service_with_token(token)
        return get_encryption_service()

    def _clear_encrypted_state_locked(self) -> None:
        self._encrypted_state_json = None
        self._encrypted_state_nonce = None
        self._encrypted_state_tag = None

    def _new_tab_id(self) -> str:
        return str(uuid4())

    def _normalize_tab_order(self, incoming_order: List[str], tabs: Dict[str, Dict[str, object]]) -> List[str]:
        if not incoming_order:
            raise InputRejected("tabOrder must be a non-empty list")
        if len(incoming_order) != len(tabs):
            raise InputRejected("tabOrder must match tabs length")
        if len(incoming_order) > self._MAX_TABS:
            raise InputRejected(f"tabOrder exceeds max tabs ({self._MAX_TABS})")

        normalized: List[str] = []
        seen = set()
        for raw in incoming_order:
            tab_id = str(raw)
            if tab_id in seen:
                raise InputRejected("tabOrder contains duplicates")
            if tab_id not in tabs:
                raise InputRejected("tabOrder references unknown tab")
            seen.add(tab_id)
            normalized.append(tab_id)
        return normalized

    def _normalize_tabs(self, tabs: Dict[str, Dict[str, object]]) -> Dict[str, Dict[str, object]]:
        if not isinstance(tabs, dict) or not tabs:
            raise InputRejected("tabs must be a non-empty object")
        if len(tabs) > self._MAX_TABS:
            raise InputRejected(f"tabs must contain at most {self._MAX_TABS} entries")
        normalized: Dict[str, Dict[str, object]] = {}
        for key, value in tabs.items():
            tab_id = str(key)
            if not tab_id:
                raise InputRejected("tab ids must be non-empty strings")
            if not _is_uuid_string(tab_id):
                raise InputRejected("tab ids must be UUID strings")
            if not isinstance(value, dict):
                raise InputRejected("tab payload must be an object")
            if "searchQuery" not in value or "scrollY" not in value or "sortMode" not in value:
                raise InputRejected("tab payload missing required keys")
            search_query = value["searchQuery"]
            scroll_y = value["scrollY"]
            sort_mode = value["sortMode"]
            if not isinstance(search_query, str):
                raise InputRejected("searchQuery must be a string")
            if not isinstance(scroll_y, int) or scroll_y < 0:
                raise InputRejected("scrollY must be a non-negative integer")
            normalized_sort_mode = normalize_sort_mode(sort_mode)

            normalized_anchor_root_id: Optional[str] = None
            if "anchorRootId" in value:
                anchor_root_id = value["anchorRootId"]
            else:
                anchor_root_id = None
            if anchor_root_id is not None:
                if not isinstance(anchor_root_id, str) or anchor_root_id == "":
                    raise InputRejected("anchorRootId must be a non-empty string or null")
                normalized_anchor_root_id = anchor_root_id

            normalized_scroll_anchor: Optional[Dict[str, object]] = None
            if "scrollAnchor" in value:
                scroll_anchor = value["scrollAnchor"]
            else:
                scroll_anchor = None
            if scroll_anchor is not None:
                if not isinstance(scroll_anchor, dict):
                    raise InputRejected("scrollAnchor must be an object or null")

                if "anchorId" in scroll_anchor:
                    anchor_id = scroll_anchor["anchorId"]
                else:
                    anchor_id = None
                if "anchorBias" in scroll_anchor:
                    anchor_bias = scroll_anchor["anchorBias"]
                else:
                    anchor_bias = None
                if "intraOffset" in scroll_anchor:
                    intra_offset = scroll_anchor["intraOffset"]
                else:
                    intra_offset = None
                if "beltPrev" in scroll_anchor:
                    belt_prev = scroll_anchor["beltPrev"]
                else:
                    belt_prev = None
                if "beltNext" in scroll_anchor:
                    belt_next = scroll_anchor["beltNext"]
                else:
                    belt_next = None
                if "anchorSortKey" in scroll_anchor:
                    anchor_sort_key = scroll_anchor["anchorSortKey"]
                else:
                    anchor_sort_key = None

                if not isinstance(anchor_id, str) or not anchor_id:
                    raise InputRejected("scrollAnchor.anchorId must be a non-empty string")
                if anchor_bias not in ("center", "top"):
                    raise InputRejected("scrollAnchor.anchorBias must be 'center' or 'top'")
                if not isinstance(intra_offset, int) or intra_offset < 0:
                    raise InputRejected("scrollAnchor.intraOffset must be a non-negative integer")
                if not isinstance(belt_prev, list) or not isinstance(belt_next, list):
                    raise InputRejected("scrollAnchor belt arrays must be lists")

                def _normalize_belt(payload: List[object]) -> List[str]:
                    return [entry for entry in payload if isinstance(entry, str) and entry]

                normalized_prev = _normalize_belt(belt_prev)
                normalized_next = _normalize_belt(belt_next)

                if not isinstance(anchor_sort_key, dict):
                    raise InputRejected("scrollAnchor.anchorSortKey must be an object")
                if "domIndex" in anchor_sort_key:
                    dom_index = anchor_sort_key["domIndex"]
                else:
                    dom_index = None
                if not isinstance(dom_index, int) or dom_index < 0:
                    raise InputRejected("scrollAnchor.anchorSortKey.domIndex must be a non-negative integer")

                normalized_scroll_anchor = {
                    "anchorId": anchor_id,
                    "anchorBias": anchor_bias,
                    "intraOffset": intra_offset,
                    "beltPrev": normalized_prev,
                    "beltNext": normalized_next,
                    "anchorSortKey": {"domIndex": dom_index},
                }
            # Persist only the current tab contract; fields from older payloads are
            # intentionally accepted but omitted from the normalized snapshot.
            normalized[tab_id] = {
                "searchQuery": search_query,
                "scrollY": scroll_y,
                "anchorRootId": normalized_anchor_root_id,
                "scrollAnchor": normalized_scroll_anchor,
                "sortMode": normalized_sort_mode,
            }
        return normalized


tab_state_store = TabStateStore()
