from __future__ import annotations

import json
from pathlib import Path
import re
import uuid

from app.server_runtime import resolve_namespace_delete_jobs_directory
from app.services.input_errors import NamespaceInputRejected


_JOB_ID_PATTERN = re.compile(r"^[a-f0-9-]{36}$")


def create_namespace_deletion_job(
    *,
    deleted_namespace: str,
    redirect_namespace: str,
) -> dict[str, str]:
    if not isinstance(deleted_namespace, str) or deleted_namespace == "":
        raise TypeError("deleted_namespace must be a non-empty string")
    if not isinstance(redirect_namespace, str) or redirect_namespace == "":
        raise TypeError("redirect_namespace must be a non-empty string")

    job_id = str(uuid.uuid4())
    job_record = {
        "job_id": job_id,
        "status": "pending",
        "deleted_namespace": deleted_namespace,
        "redirect_namespace": redirect_namespace,
        "error": "",
    }
    _write_job_record(job_id=job_id, job_record=job_record)
    return job_record


def load_namespace_deletion_job(*, job_id: str) -> dict[str, str] | None:
    normalized_job_id = _validate_job_id(job_id=job_id)
    job_path = _resolve_job_path(job_id=normalized_job_id)
    if not job_path.is_file():
        return None
    payload = json.loads(job_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"Namespace deletion job is not an object: {job_path}")
    return _coerce_job_record(payload=payload, job_id=normalized_job_id)


def mark_namespace_deletion_job_succeeded(*, job_id: str) -> None:
    job_record = _require_existing_job(job_id=job_id)
    job_record["status"] = "succeeded"
    job_record["error"] = ""
    _write_job_record(job_id=job_id, job_record=job_record)


def mark_namespace_deletion_job_failed(*, job_id: str, error: str) -> None:
    if not isinstance(error, str) or error.strip() == "":
        raise TypeError("error must be a non-empty string")
    job_record = _require_existing_job(job_id=job_id)
    job_record["status"] = "failed"
    job_record["error"] = error.strip()
    _write_job_record(job_id=job_id, job_record=job_record)


def _require_existing_job(*, job_id: str) -> dict[str, str]:
    job_record = load_namespace_deletion_job(job_id=job_id)
    if job_record is None:
        raise RuntimeError(f"Namespace deletion job not found: {job_id}")
    return job_record


def _validate_job_id(*, job_id: str) -> str:
    if not isinstance(job_id, str):
        raise TypeError(f"job_id must be a string, got {type(job_id)}")
    normalized_job_id = job_id.strip()
    if _JOB_ID_PATTERN.fullmatch(normalized_job_id) is None:
        raise NamespaceInputRejected(f"Invalid namespace deletion job id: {job_id!r}")
    return normalized_job_id


def _resolve_job_path(*, job_id: str) -> Path:
    jobs_directory = resolve_namespace_delete_jobs_directory()
    jobs_directory.mkdir(parents=True, exist_ok=True)
    return jobs_directory / f"{job_id}.json"


def _coerce_job_record(*, payload: dict[str, object], job_id: str) -> dict[str, str]:
    if "status" not in payload:
        raise RuntimeError(f"Namespace deletion job is missing status: {payload}")
    if "deleted_namespace" not in payload:
        raise RuntimeError(f"Namespace deletion job is missing deleted_namespace: {payload}")
    if "redirect_namespace" not in payload:
        raise RuntimeError(f"Namespace deletion job is missing redirect_namespace: {payload}")
    if "error" not in payload:
        raise RuntimeError(f"Namespace deletion job is missing error: {payload}")
    status = payload["status"]
    deleted_namespace = payload["deleted_namespace"]
    redirect_namespace = payload["redirect_namespace"]
    error = payload["error"]
    if status not in {"pending", "succeeded", "failed"}:
        raise RuntimeError(f"Namespace deletion job has invalid status: {payload}")
    if not isinstance(deleted_namespace, str) or deleted_namespace == "":
        raise RuntimeError(f"Namespace deletion job is missing deleted_namespace: {payload}")
    if not isinstance(redirect_namespace, str) or redirect_namespace == "":
        raise RuntimeError(f"Namespace deletion job is missing redirect_namespace: {payload}")
    if not isinstance(error, str):
        raise RuntimeError(f"Namespace deletion job has invalid error field: {payload}")
    return {
        "job_id": job_id,
        "status": status,
        "deleted_namespace": deleted_namespace,
        "redirect_namespace": redirect_namespace,
        "error": error,
    }


def _write_job_record(*, job_id: str, job_record: dict[str, str]) -> None:
    normalized_job_id = _validate_job_id(job_id=job_id)
    serialized = json.dumps(job_record, indent=2, sort_keys=True)
    job_path = _resolve_job_path(job_id=normalized_job_id)
    job_path.write_text(serialized, encoding="utf-8")
