from __future__ import annotations

from datetime import datetime, timezone
import json

from app.config import ACTIVE_NAMESPACE
from app.db.backup_settings_sql import fetch_backup_settings_row, upsert_backup_settings_row
from app.db.session import begin_writer
from app.models.database import SafeSession
from app.security.encryption import get_encryption_service
from app.security.encryption import get_encryption_service_with_token
from app.security.encryption import is_encryption_required
from app.server_runtime import validate_namespace


_DEFAULT_RETENTION_COUNT = 30


def _default_backup_settings() -> dict[str, object]:
    return {
        "retention_count": _DEFAULT_RETENTION_COUNT,
        "folder_path": "",
        "selected_namespaces": [ACTIVE_NAMESPACE],
    }


def _serialize_settings_payload(settings: dict[str, object]) -> str:
    validated = _validate_backup_settings(settings)
    return json.dumps(validated, separators=(",", ":"), sort_keys=True)


def _deserialize_settings_payload(payload_json: str) -> dict[str, object]:
    if not isinstance(payload_json, str) or payload_json == "":
        raise RuntimeError("backup settings payload must be a non-empty string")
    parsed = json.loads(payload_json)
    if not isinstance(parsed, dict):
        raise RuntimeError("backup settings payload must be an object")
    return _validate_backup_settings(parsed)


def _validate_backup_settings(settings: dict[str, object]) -> dict[str, object]:
    if "retention_count" not in settings:
        raise RuntimeError("backup settings missing retention_count")
    retention_count = settings["retention_count"]
    if not isinstance(retention_count, int) or retention_count <= 0:
        raise RuntimeError("backup settings retention_count must be a positive integer")

    folder_path = ""
    if "folder_path" in settings:
        folder_path = settings["folder_path"]
        if not isinstance(folder_path, str):
            raise RuntimeError("backup settings folder_path must be a string")

    selected_namespaces: list[str] = [ACTIVE_NAMESPACE]
    if "selected_namespaces" in settings:
        raw_selected_namespaces = settings["selected_namespaces"]
        if not isinstance(raw_selected_namespaces, list):
            raise RuntimeError("backup settings selected_namespaces must be a list")
        if len(raw_selected_namespaces) == 0:
            raise RuntimeError("backup settings selected_namespaces must not be empty")
        selected_namespaces = []
        seen_namespaces: set[str] = set()
        for raw_namespace in raw_selected_namespaces:
            if not isinstance(raw_namespace, str):
                raise RuntimeError("backup settings selected_namespaces entries must be strings")
            normalized_namespace = validate_namespace(namespace=raw_namespace)
            if normalized_namespace in seen_namespaces:
                raise RuntimeError(f"backup settings selected_namespaces duplicate: {normalized_namespace}")
            seen_namespaces.add(normalized_namespace)
            selected_namespaces.append(normalized_namespace)

    return {
        "retention_count": retention_count,
        "folder_path": folder_path,
        "selected_namespaces": selected_namespaces,
    }


def _resolve_encryption_service(*, token: str):
    if token:
        return get_encryption_service_with_token(token)
    return get_encryption_service()


def load_backup_settings(*, token: str) -> dict[str, object]:
    if not isinstance(token, str):
        raise TypeError("token must be a string")
    session = SafeSession()
    try:
        with SafeSession.allow_reads("backup_settings:load"):
            row = fetch_backup_settings_row(session.connection())
        if row is None:
            raise RuntimeError("app_settings row missing while loading backup settings")

        stored_json = row["backup_settings_json"]
        if stored_json is None:
            return _default_backup_settings()
        if not isinstance(stored_json, str):
            raise RuntimeError("backup_settings_json must be a string")

        nonce = row["backup_settings_encryption_nonce"]
        tag = row["backup_settings_encryption_tag"]
        if (nonce is None) != (tag is None):
            raise RuntimeError(
                "backup settings row has incomplete encryption metadata: "
                f"nonce={nonce is not None} tag={tag is not None}"
            )

        if nonce is None:
            return _deserialize_settings_payload(stored_json)

        service = _resolve_encryption_service(token=token)
        if service is None:
            raise RuntimeError("backup settings decryption requires an active DEK")
        plaintext = service.decrypt_from_storage(stored_json, nonce, tag)
        if not isinstance(plaintext, str):
            raise TypeError("decrypted backup settings payload must be a string")
        return _deserialize_settings_payload(plaintext)
    finally:
        session.close()


def save_backup_settings(*, token: str, settings: dict[str, object]) -> dict[str, object]:
    if not isinstance(token, str):
        raise TypeError("token must be a string")
    normalized_settings = _validate_backup_settings(settings)
    plaintext_json = _serialize_settings_payload(normalized_settings)
    stored_json = plaintext_json
    nonce: bytes | None = None
    tag: bytes | None = None

    service = _resolve_encryption_service(token=token)
    if service is not None:
        stored_json, nonce, tag = service.encrypt_for_storage(plaintext_json)
    elif is_encryption_required():
        raise RuntimeError("backup settings persistence requires an active DEK")

    with begin_writer() as connection:
        upsert_backup_settings_row(
            connection,
            backup_settings_json=stored_json,
            backup_settings_encryption_nonce=nonce,
            backup_settings_encryption_tag=tag,
            updated_at=datetime.now(timezone.utc),
        )
    return normalized_settings


def update_backup_settings(
    *,
    token: str,
    folder_path: str,
    selected_namespaces: list[str],
    retention_count: int,
) -> dict[str, object]:
    if not isinstance(folder_path, str):
        raise TypeError("folder_path must be a string")
    if not isinstance(selected_namespaces, list):
        raise TypeError("selected_namespaces must be a list")
    if not isinstance(retention_count, int) or retention_count <= 0:
        raise ValueError("retention_count must be a positive integer")

    settings = load_backup_settings(token=token)
    settings["folder_path"] = folder_path
    settings["selected_namespaces"] = selected_namespaces
    settings["retention_count"] = retention_count
    return save_backup_settings(token=token, settings=settings)
