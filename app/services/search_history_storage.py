from __future__ import annotations

from datetime import date
import json
import uuid


SEARCH_HISTORY_PAYLOAD_VERSION = 2
MAX_TAG_ACTIVITY_RETENTION_DAYS = 365
_AAD_PREFIX = "MetaList|tag_activity_history|payload|v2|"


def new_search_history_storage_id() -> str:
    storage_id = str(uuid.uuid4())
    assert_search_history_storage_id(storage_id)
    return storage_id


def assert_search_history_storage_id(storage_id: str) -> None:
    if not isinstance(storage_id, str) or storage_id == "":
        raise TypeError("tag activity storage_id must be a non-empty string")
    parsed = uuid.UUID(storage_id)
    if parsed.version != 4 or str(parsed) != storage_id:
        raise ValueError("tag activity storage_id must be a canonical UUIDv4")


def search_history_payload_aad(*, storage_id: str) -> bytes:
    assert_search_history_storage_id(storage_id)
    return f"{_AAD_PREFIX}{storage_id}".encode("utf-8")


def _validate_counts_by_date(counts_by_date: dict[str, dict[str, int]]) -> None:
    if not isinstance(counts_by_date, dict):
        raise TypeError("counts_by_date must be a dict")
    if len(counts_by_date) > MAX_TAG_ACTIVITY_RETENTION_DAYS:
        raise ValueError(
            f"counts_by_date cannot exceed {MAX_TAG_ACTIVITY_RETENTION_DAYS} daily buckets"
        )
    for day_text, tag_counts in counts_by_date.items():
        if not isinstance(day_text, str) or day_text == "":
            raise TypeError("tag activity dates must be non-empty strings")
        parsed_day = date.fromisoformat(day_text)
        if parsed_day.isoformat() != day_text:
            raise ValueError("tag activity dates must be canonical ISO dates")
        if not isinstance(tag_counts, dict) or not tag_counts:
            raise TypeError("each tag activity date must contain a non-empty count map")
        seen_casefold: set[str] = set()
        for tag_name, count in tag_counts.items():
            if not isinstance(tag_name, str) or tag_name == "":
                raise TypeError("tag activity names must be non-empty strings")
            tag_casefold = tag_name.casefold()
            if tag_casefold in seen_casefold:
                raise RuntimeError("tag activity date contains duplicate case-insensitive tags")
            seen_casefold.add(tag_casefold)
            if not isinstance(count, int) or isinstance(count, bool) or count <= 0:
                raise TypeError("tag activity counts must be positive integers")


def serialize_search_history_payload(*, counts_by_date: dict[str, dict[str, int]]) -> str:
    _validate_counts_by_date(counts_by_date)
    return json.dumps(
        {
            "version": SEARCH_HISTORY_PAYLOAD_VERSION,
            "counts_by_date": counts_by_date,
        },
        separators=(",", ":"),
        ensure_ascii=False,
        sort_keys=True,
    )


def deserialize_search_history_payload(payload_json: str) -> dict[str, dict[str, int]]:
    if not isinstance(payload_json, str) or payload_json == "":
        raise TypeError("tag activity payload_json must be a non-empty string")
    payload = json.loads(payload_json)
    if not isinstance(payload, dict):
        raise TypeError("tag activity payload must decode to an object")
    if set(payload.keys()) != {"version", "counts_by_date"}:
        raise RuntimeError("tag activity payload has unexpected fields")
    if payload["version"] != SEARCH_HISTORY_PAYLOAD_VERSION:
        raise RuntimeError(f"unsupported tag activity payload version: {payload['version']!r}")
    raw_counts = payload["counts_by_date"]
    if not isinstance(raw_counts, dict):
        raise TypeError("tag activity counts_by_date must decode to an object")
    counts_by_date: dict[str, dict[str, int]] = {}
    for day_text, raw_tag_counts in raw_counts.items():
        if not isinstance(day_text, str):
            raise TypeError("tag activity date keys must be strings")
        if not isinstance(raw_tag_counts, dict):
            raise TypeError("tag activity daily counts must decode to objects")
        tag_counts: dict[str, int] = {}
        for tag_name, count in raw_tag_counts.items():
            if not isinstance(tag_name, str):
                raise TypeError("tag activity tag keys must be strings")
            if not isinstance(count, int) or isinstance(count, bool):
                raise TypeError("tag activity counts must decode to integers")
            tag_counts[tag_name] = count
        counts_by_date[day_text] = tag_counts
    _validate_counts_by_date(counts_by_date)
    return counts_by_date


def encode_search_history_payload(
    *,
    storage_id: str,
    payload_json: str,
    encryption_service: object,
) -> tuple[str, bytes | None, bytes | None]:
    assert_search_history_storage_id(storage_id)
    if not isinstance(payload_json, str) or payload_json == "":
        raise TypeError("payload_json must be a non-empty string")
    service = coerce_search_history_encryption_service(encryption_service)
    if service is None:
        return payload_json, None, None
    return service.encrypt_with_aad(
        payload_json,
        search_history_payload_aad(storage_id=storage_id),
    )


def decode_search_history_payload(
    *,
    storage_id: str,
    stored_payload: object,
    nonce: object,
    tag: object,
    encryption_service: object,
) -> str:
    assert_search_history_storage_id(storage_id)
    if not isinstance(stored_payload, str) or stored_payload == "":
        raise TypeError("tag activity stored payload must be a non-empty string")
    if nonce is None and tag is None:
        return stored_payload
    if not isinstance(nonce, bytes) or not isinstance(tag, bytes):
        raise RuntimeError("tag activity payload has invalid encryption metadata")
    service = coerce_search_history_encryption_service(encryption_service)
    if service is None:
        raise RuntimeError("encrypted tag activity requires an active DEK")
    return service.decrypt_with_aad(
        stored_payload,
        nonce,
        tag,
        search_history_payload_aad(storage_id=storage_id),
    )


def coerce_search_history_encryption_service(encryption_service: object):
    if encryption_service is None:
        return None
    dek = encryption_service.dek
    if not isinstance(dek, bytes) or len(dek) != 32:
        return None
    return encryption_service
