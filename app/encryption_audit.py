"""Read-only audit of encrypted payload storage across MetaList namespaces."""

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
from pathlib import Path
import re
import sqlite3
import sys

from app.db.version import CURRENT_DATABASE_VERSION


_NONCE_BYTES = 12
_TAG_BYTES = 16
_DEFAULT_NAMESPACES_DIRECTORY = Path.home() / "MetaList" / "namespaces"
_CANONICAL_BASE64_PATTERN = re.compile(
    r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
)


@dataclass(frozen=True, slots=True)
class _PayloadSpec:
    table: str
    value_column: str
    nonce_column: str
    tag_column: str
    storage_kind: str
    is_nullable: bool = False


@dataclass(frozen=True, slots=True)
class AuditFinding:
    namespace: str
    database_path: Path
    table: str
    field: str
    message: str
    is_migration_deferred: bool
    occurrences: int = 1


@dataclass(frozen=True, slots=True)
class NamespaceAuditResult:
    namespace: str
    database_path: Path
    is_encrypted: bool
    checked_payload_count: int
    findings: tuple[AuditFinding, ...]


@dataclass(frozen=True, slots=True)
class EncryptionAuditReport:
    namespaces_directory: Path
    results: tuple[NamespaceAuditResult, ...]
    scan_findings: tuple[AuditFinding, ...]

    @property
    def findings(self) -> tuple[AuditFinding, ...]:
        namespace_findings = tuple(
            finding
            for result in self.results
            for finding in result.findings
        )
        return self.scan_findings + namespace_findings

    @property
    def namespace_count(self) -> int:
        return len(self.results)

    @property
    def migration_findings(self) -> tuple[AuditFinding, ...]:
        return tuple(finding for finding in self.findings if finding.is_migration_deferred)

    @property
    def fatal_findings(self) -> tuple[AuditFinding, ...]:
        return tuple(finding for finding in self.findings if not finding.is_migration_deferred)

    @property
    def encrypted_namespace_count(self) -> int:
        return sum(result.is_encrypted for result in self.results)

    @property
    def checked_payload_count(self) -> int:
        return sum(result.checked_payload_count for result in self.results)

    @property
    def passed(self) -> bool:
        return self.namespace_count > 0 and len(self.findings) == 0

    @property
    def startup_allowed(self) -> bool:
        return self.namespace_count > 0 and len(self.fatal_findings) == 0

    def render_text(self) -> str:
        status = "FAIL"
        if self.passed:
            status = "PASS"
        elif self.startup_allowed:
            status = "MIGRATION REQUIRED"
        lines = [
            f"Encrypted namespace audit: {status}",
            f"Namespace directory: {self.namespaces_directory}",
            (
                f"Namespaces: {self.namespace_count} "
                f"(encrypted={self.encrypted_namespace_count}, "
                f"plaintext={self.namespace_count - self.encrypted_namespace_count})"
            ),
            f"Sensitive payloads checked: {self.checked_payload_count}",
        ]
        for result in self.results:
            result_status = "SKIPPED (not encrypted)"
            if result.is_encrypted:
                result_status = "PASS"
                if result.findings:
                    result_status = "MIGRATION REQUIRED"
                    if any(not finding.is_migration_deferred for finding in result.findings):
                        result_status = "FAIL"
            lines.append(f"- {result.namespace}: {result_status}")
        if self.findings:
            lines.append("Findings:")
            for finding in self.findings:
                disposition = "FATAL"
                if finding.is_migration_deferred:
                    disposition = "MIGRATION"
                count_suffix = ""
                if finding.occurrences > 1:
                    count_suffix = f" ({finding.occurrences} occurrences)"
                lines.append(
                    f"- [{disposition}] {finding.namespace} | {finding.database_path.name} | "
                    f"{finding.table}.{finding.field}: {finding.message}{count_suffix}"
                )
        return "\n".join(lines)


class _AuditState:
    def __init__(self, *, namespace: str, database_path: Path) -> None:
        self.namespace = namespace
        self.database_path = database_path
        self.checked_payload_count = 0
        self._finding_counts: dict[tuple[Path, str, str, str, bool], int] = {}
        self._used_nonces: dict[bytes, tuple[Path, str, str]] = {}

    def add_finding(
        self,
        *,
        database_path: Path,
        table: str,
        field: str,
        message: str,
    ) -> None:
        key = (database_path, table, field, message, False)
        self._finding_counts[key] = self._finding_counts.get(key, 0) + 1

    def add_migration_finding(
        self,
        *,
        database_path: Path,
        table: str,
        field: str,
        message: str,
    ) -> None:
        key = (database_path, table, field, message, True)
        self._finding_counts[key] = self._finding_counts.get(key, 0) + 1

    def record_nonce(
        self,
        *,
        nonce: bytes,
        database_path: Path,
        table: str,
        field: str,
    ) -> None:
        previous = self._used_nonces.get(nonce)
        if previous is None:
            self._used_nonces[nonce] = (database_path, table, field)
            return
        previous_database_path, previous_table, previous_field = previous
        self.add_finding(
            database_path=database_path,
            table=table,
            field=field,
            message=(
                "AES-GCM nonce is reused by "
                f"{previous_database_path.name}:{previous_table}.{previous_field}"
            ),
        )

    def findings(self) -> tuple[AuditFinding, ...]:
        return tuple(
            AuditFinding(
                namespace=self.namespace,
                database_path=database_path,
                table=table,
                field=field,
                message=message,
                is_migration_deferred=is_migration_deferred,
                occurrences=count,
            )
            for (database_path, table, field, message, is_migration_deferred), count in sorted(
                self._finding_counts.items(),
                key=lambda entry: tuple(str(part) for part in entry[0]),
            )
        )


_LEGACY_SEARCH_HISTORY_COLUMNS = frozenset(
    {
        "query_hash", "query_key", "query_key_encryption_nonce",
        "query_key_encryption_tag", "root_tag", "root_tag_encryption_nonce",
        "root_tag_encryption_tag", "tags_json", "tags_json_encryption_nonce",
        "tags_json_encryption_tag", "score", "created_at", "last_interacted_at",
        "updated_at",
    }
)
_OPAQUE_SEARCH_HISTORY_COLUMNS = frozenset(
    {
        "storage_id", "payload_json", "payload_encryption_nonce",
        "payload_encryption_tag",
    }
)


_OPENAI_CREDENTIAL_COLUMNS = frozenset(
    {
        "openai_api_key_ciphertext",
        "openai_api_key_encryption_nonce",
        "openai_api_key_encryption_tag",
    }
)

_PROPOSED_TAG_COLUMNS = frozenset(
    {
        "proposed_tags",
        "proposed_tags_encryption_nonce",
        "proposed_tags_encryption_tag",
    }
)


_MAIN_SCHEMA_BEFORE_CONTENT_MIGRATIONS = {
    "notes": frozenset(
        {
            "id", "content", "tags", "is_collapsed", "encryption_nonce",
            "encryption_tag", "tags_encryption_nonce", "tags_encryption_tag",
            *_PROPOSED_TAG_COLUMNS,
            "parent_id", "prev_id", "next_id", "created_at", "updated_at",
        }
    ),
    "app_settings": frozenset(
        {
            "id", "auth_verifier", "auth_salt", "auth_iterations", "kek_salt",
            "kek_iterations", "vault_version", "kdf_algorithm",
            "kdf_memory_cost_kib", "kdf_parallelism", "encryption_enabled",
            "encryption_algorithm", "encrypted_dek", "dek_nonce", "dek_tag",
            "backup_settings_json", "backup_settings_encryption_nonce",
            "backup_settings_encryption_tag", "client_preferences_json",
            "client_preferences_encryption_nonce", "client_preferences_encryption_tag",
            "command_palette_usage_json", "command_palette_usage_encryption_nonce",
            "command_palette_usage_encryption_tag", "tag_prefix_settings_json",
            "tag_prefix_settings_encryption_nonce", "tag_prefix_settings_encryption_tag",
            *_OPENAI_CREDENTIAL_COLUMNS,
            "session_timeout_minutes", "created_at", "updated_at",
        }
    ),
    "ontology_rules": frozenset(
        {
            "id", "rule_text", "rule_encryption_nonce", "rule_encryption_tag",
            "created_at", "updated_at",
        }
    ),
    "tab_state": frozenset(
        {
            "id", "state_json", "state_encryption_nonce", "state_encryption_tag",
            "created_at", "updated_at",
        }
    ),
    "link_titles": frozenset(
        {
            "id", "url", "url_encryption_nonce", "url_encryption_tag", "title",
            "title_encryption_nonce", "title_encryption_tag", "status",
            "last_error_kind", "last_checked_at", "last_success_at", "last_failure_at",
            "next_check_after", "failure_count", "created_at", "updated_at",
        }
    ),
    "reminders": frozenset(
        {
            "id", "payload_json", "payload_encryption_nonce", "payload_encryption_tag",
            "created_at", "updated_at",
        }
    ),
    "search_interaction_history": _LEGACY_SEARCH_HISTORY_COLUMNS,
    "namespace_launch_profile": frozenset(
        {"namespace", "port", "https_port", "mcp_port", "created_at", "updated_at"}
    ),
}

_MAIN_SCHEMA = {
    **_MAIN_SCHEMA_BEFORE_CONTENT_MIGRATIONS,
    "namespace_content_migrations": frozenset(
        {
            "migration_id", "status", "converted_count", "unresolved_count",
            "last_attempt_at", "completed_at", "created_at", "updated_at",
        }
    ),
}

_OPAQUE_MAIN_SCHEMA_BEFORE_CONTENT_MIGRATIONS = {
    **_MAIN_SCHEMA_BEFORE_CONTENT_MIGRATIONS,
    "search_interaction_history": _OPAQUE_SEARCH_HISTORY_COLUMNS,
}

_OPAQUE_MAIN_SCHEMA = {
    **_MAIN_SCHEMA,
    "search_interaction_history": _OPAQUE_SEARCH_HISTORY_COLUMNS,
}

_FILE_SCHEMA = {
    table: frozenset(
        {
            "id", "title", "title_encryption_nonce", "title_encryption_tag",
            "metadata_json", "metadata_encryption_nonce", "metadata_encryption_tag",
            "blob_data", "blob_encryption_nonce", "blob_encryption_tag", "created_at",
            "updated_at",
        }
    )
    for table in ("files", "sounds")
}

_MAIN_PAYLOADS_WITHOUT_SEARCH_HISTORY = (
    _PayloadSpec("notes", "content", "encryption_nonce", "encryption_tag", "text"),
    _PayloadSpec("notes", "tags", "tags_encryption_nonce", "tags_encryption_tag", "text"),
    _PayloadSpec(
        "notes",
        "proposed_tags",
        "proposed_tags_encryption_nonce",
        "proposed_tags_encryption_tag",
        "text",
    ),
    _PayloadSpec(
        "app_settings", "backup_settings_json", "backup_settings_encryption_nonce",
        "backup_settings_encryption_tag", "text", is_nullable=True,
    ),
    _PayloadSpec(
        "app_settings", "client_preferences_json", "client_preferences_encryption_nonce",
        "client_preferences_encryption_tag", "text", is_nullable=True,
    ),
    _PayloadSpec(
        "app_settings", "command_palette_usage_json",
        "command_palette_usage_encryption_nonce", "command_palette_usage_encryption_tag",
        "text", is_nullable=True,
    ),
    _PayloadSpec(
        "app_settings", "tag_prefix_settings_json", "tag_prefix_settings_encryption_nonce",
        "tag_prefix_settings_encryption_tag", "text", is_nullable=True,
    ),
    _PayloadSpec(
        "app_settings", "openai_api_key_ciphertext",
        "openai_api_key_encryption_nonce", "openai_api_key_encryption_tag",
        "text", is_nullable=True,
    ),
    _PayloadSpec(
        "ontology_rules", "rule_text", "rule_encryption_nonce", "rule_encryption_tag", "text"
    ),
    _PayloadSpec("tab_state", "state_json", "state_encryption_nonce", "state_encryption_tag", "text"),
    _PayloadSpec("link_titles", "url", "url_encryption_nonce", "url_encryption_tag", "text"),
    _PayloadSpec(
        "link_titles", "title", "title_encryption_nonce", "title_encryption_tag", "text",
        is_nullable=True,
    ),
    _PayloadSpec(
        "reminders", "payload_json", "payload_encryption_nonce", "payload_encryption_tag", "text"
    ),
)

_LEGACY_SEARCH_HISTORY_PAYLOADS = (
    _PayloadSpec(
        "search_interaction_history", "query_key", "query_key_encryption_nonce",
        "query_key_encryption_tag", "text",
    ),
    _PayloadSpec(
        "search_interaction_history", "root_tag", "root_tag_encryption_nonce",
        "root_tag_encryption_tag", "text",
    ),
    _PayloadSpec(
        "search_interaction_history", "tags_json", "tags_json_encryption_nonce",
        "tags_json_encryption_tag", "text",
    ),
)

_OPAQUE_SEARCH_HISTORY_PAYLOADS = (
    _PayloadSpec(
        "search_interaction_history", "payload_json", "payload_encryption_nonce",
        "payload_encryption_tag", "text",
    ),
)

_FILE_PAYLOADS = tuple(
    _PayloadSpec(table, value, f"{prefix}_encryption_nonce", f"{prefix}_encryption_tag", kind)
    for table in ("files", "sounds")
    for value, prefix, kind in (
        ("title", "title", "text"),
        ("metadata_json", "metadata", "text"),
        ("blob_data", "blob", "bytes"),
    )
)

_MIGRATION_DEFERRED_PLAINTEXT_FIELDS_BY_DATABASE_VERSION = {
    0: frozenset(
        {
            ("app_settings", "client_preferences_json"),
            ("app_settings", "command_palette_usage_json"),
            ("app_settings", "tag_prefix_settings_json"),
            ("notes", "proposed_tags"),
        }
    ),
    1: frozenset({("notes", "proposed_tags")}),
    2: frozenset({("notes", "proposed_tags")}),
    3: frozenset({("notes", "proposed_tags")}),
    4: frozenset({("notes", "proposed_tags")}),
    5: frozenset({("notes", "proposed_tags")}),
}


def _migration_deferred_plaintext_fields(
    *,
    database_version: int,
) -> frozenset[tuple[str, str]]:
    if not isinstance(database_version, int) or database_version < 0:
        raise ValueError("database_version must be a non-negative integer")
    if database_version in _MIGRATION_DEFERRED_PLAINTEXT_FIELDS_BY_DATABASE_VERSION:
        return _MIGRATION_DEFERRED_PLAINTEXT_FIELDS_BY_DATABASE_VERSION[database_version]
    if database_version == CURRENT_DATABASE_VERSION:
        return frozenset()
    raise RuntimeError(
        f"No encryption-audit migration classification for database version {database_version}"
    )


def _main_schema_for_database_version(
    *,
    expected_schema: dict[str, frozenset[str]],
    database_version: int,
    actual_app_settings_columns: frozenset[str],
    actual_notes_columns: frozenset[str],
) -> dict[str, frozenset[str]]:
    if database_version < 0 or database_version > CURRENT_DATABASE_VERSION:
        raise ValueError("database_version is outside the supported audit range")
    resolved_schema = expected_schema
    if database_version < 6 and _PROPOSED_TAG_COLUMNS.isdisjoint(actual_notes_columns):
        note_columns = resolved_schema["notes"]
        if not _PROPOSED_TAG_COLUMNS.issubset(note_columns):
            raise RuntimeError("Current audit schema is missing proposed-tag columns")
        resolved_schema = {
            **resolved_schema,
            "notes": note_columns - _PROPOSED_TAG_COLUMNS,
        }
    if database_version >= 5 or not _OPENAI_CREDENTIAL_COLUMNS.isdisjoint(
        actual_app_settings_columns
    ):
        return resolved_schema
    app_settings_columns = resolved_schema["app_settings"]
    if not _OPENAI_CREDENTIAL_COLUMNS.issubset(app_settings_columns):
        raise RuntimeError("Current audit schema is missing OpenAI credential columns")
    return {
        **resolved_schema,
        "app_settings": app_settings_columns - _OPENAI_CREDENTIAL_COLUMNS,
    }


def _connect_read_only(database_path: Path) -> sqlite3.Connection:
    uri = f"{database_path.resolve().as_uri()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    return connection


def _table_names(connection: sqlite3.Connection) -> set[str]:
    rows = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return {str(row[0]) for row in rows}


def _column_names(connection: sqlite3.Connection, *, table: str) -> set[str]:
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}


def _audit_schema(
    *,
    connection: sqlite3.Connection,
    database_path: Path,
    expected_schema: dict[str, frozenset[str]],
    state: _AuditState,
) -> set[str]:
    actual_tables = _table_names(connection)
    for table in sorted(actual_tables - expected_schema.keys()):
        state.add_finding(
            database_path=database_path,
            table=table,
            field="*",
            message="unknown table; no encryption policy exists for its columns",
        )
    for table in sorted(expected_schema.keys() - actual_tables):
        state.add_finding(
            database_path=database_path,
            table=table,
            field="*",
            message="expected table is missing",
        )
    for table in sorted(actual_tables & expected_schema.keys()):
        actual_columns = _column_names(connection, table=table)
        for column in sorted(actual_columns - expected_schema[table]):
            state.add_finding(
                database_path=database_path,
                table=table,
                field=column,
                message="unknown column; no encryption policy exists for it",
            )
        for column in sorted(expected_schema[table] - actual_columns):
            state.add_finding(
                database_path=database_path,
                table=table,
                field=column,
                message="expected column is missing",
            )
    return actual_tables


def _audit_integrity(
    *,
    connection: sqlite3.Connection,
    database_path: Path,
    state: _AuditState,
) -> None:
    rows = connection.execute("PRAGMA quick_check").fetchall()
    messages = [str(row[0]) for row in rows]
    if messages != ["ok"]:
        state.add_finding(
            database_path=database_path,
            table="<database>",
            field="integrity",
            message="SQLite quick_check failed",
        )


def _is_valid_base64_ciphertext(value: object) -> bool:
    if not isinstance(value, str):
        return False
    if _CANONICAL_BASE64_PATTERN.fullmatch(value) is None:
        return False
    decoded = base64.b64decode(value)
    return base64.b64encode(decoded).decode("ascii") == value


def _audit_payload_row(
    *,
    row: sqlite3.Row,
    spec: _PayloadSpec,
    database_path: Path,
    state: _AuditState,
    migration_deferred_plaintext_fields: frozenset[tuple[str, str]],
) -> None:
    value = row[spec.value_column]
    nonce = row[spec.nonce_column]
    tag = row[spec.tag_column]
    if value in (None, "") and spec.is_nullable and nonce is None and tag is None:
        return
    state.checked_payload_count += 1
    if nonce is None and tag is None:
        field_key = (spec.table, spec.value_column)
        if field_key in migration_deferred_plaintext_fields:
            state.add_migration_finding(
                database_path=database_path,
                table=spec.table,
                field=spec.value_column,
                message="plaintext payload requires authenticated database migration",
            )
            return
        state.add_finding(
            database_path=database_path,
            table=spec.table,
            field=spec.value_column,
            message="sensitive value has no encryption metadata",
        )
        return
    if nonce is None or tag is None:
        state.add_finding(
            database_path=database_path,
            table=spec.table,
            field=spec.value_column,
            message="sensitive value has incomplete encryption metadata",
        )
        return
    if not isinstance(nonce, bytes) or len(nonce) != _NONCE_BYTES:
        state.add_finding(
            database_path=database_path,
            table=spec.table,
            field=spec.nonce_column,
            message=f"AES-GCM nonce must be a {_NONCE_BYTES}-byte BLOB",
        )
    else:
        state.record_nonce(
            nonce=nonce,
            database_path=database_path,
            table=spec.table,
            field=spec.value_column,
        )
    if not isinstance(tag, bytes) or len(tag) != _TAG_BYTES:
        state.add_finding(
            database_path=database_path,
            table=spec.table,
            field=spec.tag_column,
            message=f"AES-GCM tag must be a {_TAG_BYTES}-byte BLOB",
        )
    if spec.storage_kind == "text" and not _is_valid_base64_ciphertext(value):
        state.add_finding(
            database_path=database_path,
            table=spec.table,
            field=spec.value_column,
            message="encrypted text must be canonical Base64 ciphertext",
        )
    if spec.storage_kind == "bytes" and not isinstance(value, bytes):
        state.add_finding(
            database_path=database_path,
            table=spec.table,
            field=spec.value_column,
            message="encrypted binary payload must be stored as a BLOB",
        )


def _audit_payloads(
    *,
    connection: sqlite3.Connection,
    database_path: Path,
    specs: tuple[_PayloadSpec, ...],
    actual_tables: set[str],
    state: _AuditState,
    migration_deferred_plaintext_fields: frozenset[tuple[str, str]],
) -> None:
    for spec in specs:
        if spec.table not in actual_tables:
            continue
        actual_columns = _column_names(connection, table=spec.table)
        needed_columns = {spec.value_column, spec.nonce_column, spec.tag_column}
        if not needed_columns.issubset(actual_columns):
            continue
        rows = connection.execute(
            f"SELECT {spec.value_column}, {spec.nonce_column}, {spec.tag_column} FROM {spec.table}"
        ).fetchall()
        for row in rows:
            _audit_payload_row(
                row=row,
                spec=spec,
                database_path=database_path,
                state=state,
                migration_deferred_plaintext_fields=migration_deferred_plaintext_fields,
            )


def _audit_vault_settings(
    *,
    connection: sqlite3.Connection,
    database_path: Path,
    state: _AuditState,
) -> None:
    required_columns = {
        "id", "auth_verifier", "auth_salt", "auth_iterations", "kek_salt",
        "kek_iterations", "vault_version", "kdf_algorithm", "kdf_memory_cost_kib",
        "kdf_parallelism", "encryption_algorithm", "encrypted_dek", "dek_nonce",
        "dek_tag",
    }
    if not required_columns.issubset(_column_names(connection, table="app_settings")):
        return
    rows = connection.execute("SELECT * FROM app_settings ORDER BY id").fetchall()
    if len(rows) != 1 or rows[0]["id"] != 1:
        state.add_finding(
            database_path=database_path,
            table="app_settings",
            field="id",
            message="encrypted namespace must have exactly one settings row with id=1",
        )
        return
    row = rows[0]
    required_values = {
        "auth_verifier": str,
        "auth_salt": bytes,
        "auth_iterations": int,
        "kek_salt": bytes,
        "kek_iterations": int,
        "vault_version": int,
        "kdf_algorithm": str,
        "kdf_memory_cost_kib": int,
        "kdf_parallelism": int,
        "encryption_algorithm": str,
        "encrypted_dek": bytes,
        "dek_nonce": bytes,
        "dek_tag": bytes,
    }
    for field, expected_type in required_values.items():
        if not isinstance(row[field], expected_type):
            state.add_finding(
                database_path=database_path,
                table="app_settings",
                field=field,
                message=f"encrypted vault metadata must be stored as {expected_type.__name__}",
            )
    _audit_vault_metadata_values(row=row, database_path=database_path, state=state)


def _audit_vault_metadata_values(
    *,
    row: sqlite3.Row,
    database_path: Path,
    state: _AuditState,
) -> None:
    exact_values = {
        "vault_version": 3,
        "kdf_algorithm": "ARGON2ID",
        "encryption_algorithm": "AES-256-GCM",
    }
    for field, expected in exact_values.items():
        if row[field] != expected:
            state.add_finding(
                database_path=database_path,
                table="app_settings",
                field=field,
                message=f"expected current encrypted-vault value {expected!r}",
            )
    byte_lengths = {
        "auth_salt": 32,
        "kek_salt": 32,
        "encrypted_dek": 32,
        "dek_nonce": _NONCE_BYTES,
        "dek_tag": _TAG_BYTES,
    }
    for field, expected_length in byte_lengths.items():
        value = row[field]
        if isinstance(value, bytes) and len(value) != expected_length:
            state.add_finding(
                database_path=database_path,
                table="app_settings",
                field=field,
                message=f"must be a {expected_length}-byte BLOB",
            )
    for field in (
        "auth_iterations", "kek_iterations", "kdf_memory_cost_kib", "kdf_parallelism"
    ):
        value = row[field]
        if isinstance(value, int) and value <= 0:
            state.add_finding(
                database_path=database_path,
                table="app_settings",
                field=field,
                message="must be a positive integer",
            )


def _encryption_enabled(connection: sqlite3.Connection) -> bool:
    tables = _table_names(connection)
    if "app_settings" not in tables:
        raise sqlite3.DatabaseError("app_settings table is missing")
    columns = _column_names(connection, table="app_settings")
    if "encryption_enabled" not in columns:
        raise sqlite3.DatabaseError("app_settings.encryption_enabled is missing")
    rows = connection.execute(
        "SELECT encryption_enabled FROM app_settings WHERE id = 1"
    ).fetchall()
    if len(rows) != 1:
        raise sqlite3.DatabaseError("app_settings row id=1 is missing")
    value = rows[0][0]
    if value not in (0, 1):
        raise sqlite3.DatabaseError("app_settings.encryption_enabled must be 0 or 1")
    return bool(value)


def _database_version(connection: sqlite3.Connection) -> int:
    row = connection.execute("PRAGMA user_version").fetchone()
    if row is None:
        raise sqlite3.DatabaseError("Database user_version PRAGMA returned no row")
    version = row[0]
    if not isinstance(version, int) or version < 0:
        raise sqlite3.DatabaseError("Database user_version must be a non-negative integer")
    return version


def _audit_database(
    *,
    database_path: Path,
    expected_schema: dict[str, frozenset[str]],
    payload_specs: tuple[_PayloadSpec, ...],
    state: _AuditState,
    is_main_database: bool,
    migration_deferred_plaintext_fields: frozenset[tuple[str, str]],
) -> None:
    connection = _connect_read_only(database_path)
    try:
        _audit_integrity(connection=connection, database_path=database_path, state=state)
        tables = _audit_schema(
            connection=connection,
            database_path=database_path,
            expected_schema=expected_schema,
            state=state,
        )
        _audit_payloads(
            connection=connection,
            database_path=database_path,
            specs=payload_specs,
            actual_tables=tables,
            state=state,
            migration_deferred_plaintext_fields=migration_deferred_plaintext_fields,
        )
        if is_main_database:
            if "app_settings" in tables:
                _audit_vault_settings(
                    connection=connection,
                    database_path=database_path,
                    state=state,
                )
    finally:
        connection.close()


def _resolve_file_database_path(note_database_path: Path) -> Path:
    suffix = note_database_path.suffix
    stem = note_database_path.stem
    if suffix == "":
        return note_database_path.with_name(f"{stem}.files")
    return note_database_path.with_name(f"{stem}.files{suffix}")


def _audit_namespace(*, namespace: str, database_path: Path) -> NamespaceAuditResult:
    state = _AuditState(namespace=namespace, database_path=database_path)
    main_connection = _connect_read_only(database_path)
    try:
        is_encrypted = _encryption_enabled(main_connection)
        database_version = _database_version(main_connection)
        main_table_names = _table_names(main_connection)
        app_settings_columns = frozenset(
            _column_names(main_connection, table="app_settings")
        )
        notes_columns = frozenset(_column_names(main_connection, table="notes"))
        search_history_columns = frozenset()
        if "search_interaction_history" in main_table_names:
            search_history_columns = frozenset(
                _column_names(main_connection, table="search_interaction_history")
            )
    finally:
        main_connection.close()
    if not is_encrypted:
        return NamespaceAuditResult(
            namespace=namespace,
            database_path=database_path,
            is_encrypted=False,
            checked_payload_count=0,
            findings=(),
        )
    uses_legacy_search_history = (
        database_version < 3
        and search_history_columns == _LEGACY_SEARCH_HISTORY_COLUMNS
    )
    expected_main_schema = _OPAQUE_MAIN_SCHEMA_BEFORE_CONTENT_MIGRATIONS
    payload_specs = (
        _MAIN_PAYLOADS_WITHOUT_SEARCH_HISTORY + _OPAQUE_SEARCH_HISTORY_PAYLOADS
    )
    if uses_legacy_search_history:
        expected_main_schema = _MAIN_SCHEMA_BEFORE_CONTENT_MIGRATIONS
        payload_specs = (
            _MAIN_PAYLOADS_WITHOUT_SEARCH_HISTORY + _LEGACY_SEARCH_HISTORY_PAYLOADS
        )
        state.add_migration_finding(
            database_path=database_path,
            table="search_interaction_history",
            field="*",
            message=(
                "legacy deterministic search-history metadata requires authenticated "
                "database migration"
            ),
        )
    elif database_version in (2, 3) and search_history_columns == _OPAQUE_SEARCH_HISTORY_COLUMNS:
        state.add_migration_finding(
            database_path=database_path,
            table="search_interaction_history",
            field="*",
            message="authenticated live-database tag-activity reset has not completed",
        )
    if database_version >= 2 or "namespace_content_migrations" in main_table_names:
        if uses_legacy_search_history:
            expected_main_schema = _MAIN_SCHEMA
        else:
            expected_main_schema = _OPAQUE_MAIN_SCHEMA
    expected_main_schema = _main_schema_for_database_version(
        expected_schema=expected_main_schema,
        database_version=database_version,
        actual_app_settings_columns=app_settings_columns,
        actual_notes_columns=notes_columns,
    )
    _audit_database(
        database_path=database_path,
        expected_schema=expected_main_schema,
        payload_specs=payload_specs,
        state=state,
        is_main_database=True,
        migration_deferred_plaintext_fields=_migration_deferred_plaintext_fields(
            database_version=database_version,
        ),
    )
    file_database_path = _resolve_file_database_path(database_path)
    if file_database_path.exists():
        _audit_database(
            database_path=file_database_path,
            expected_schema=_FILE_SCHEMA,
            payload_specs=_FILE_PAYLOADS,
            state=state,
            is_main_database=False,
            migration_deferred_plaintext_fields=frozenset(),
        )
    return NamespaceAuditResult(
        namespace=namespace,
        database_path=database_path,
        is_encrypted=True,
        checked_payload_count=state.checked_payload_count,
        findings=state.findings(),
    )


def _scan_finding(*, namespaces_directory: Path, message: str) -> AuditFinding:
    return AuditFinding(
        namespace="<scan>",
        database_path=namespaces_directory,
        table="<discovery>",
        field="path",
        message=message,
        is_migration_deferred=False,
    )


def _discover_namespace_databases(
    *,
    namespaces_directory: Path,
) -> tuple[list[tuple[str, Path]], list[AuditFinding]]:
    if not namespaces_directory.exists():
        return [], [
            _scan_finding(
                namespaces_directory=namespaces_directory,
                message="namespace directory does not exist",
            )
        ]
    if not namespaces_directory.is_dir():
        return [], [
            _scan_finding(
                namespaces_directory=namespaces_directory,
                message="namespace path is not a directory",
            )
        ]
    discovered: list[tuple[str, Path]] = []
    findings: list[AuditFinding] = []
    for namespace_directory in sorted(namespaces_directory.iterdir(), key=lambda path: path.name):
        if not namespace_directory.is_dir():
            continue
        namespace = namespace_directory.name
        database_path = namespace_directory / f"{namespace}.metalist.db"
        if not database_path.is_file():
            findings.append(
                _scan_finding(
                    namespaces_directory=namespaces_directory,
                    message=f"namespace {namespace!r} has no canonical database file",
                )
            )
            continue
        discovered.append((namespace, database_path))
    if not discovered and not findings:
        findings.append(
            _scan_finding(
                namespaces_directory=namespaces_directory,
                message="no namespace databases were discovered",
            )
        )
    return discovered, findings


def audit_all_namespaces(*, namespaces_directory: Path) -> EncryptionAuditReport:
    if not isinstance(namespaces_directory, Path):
        raise TypeError("namespaces_directory must be a Path")
    databases, scan_findings = _discover_namespace_databases(
        namespaces_directory=namespaces_directory,
    )
    results: list[NamespaceAuditResult] = []
    for namespace, database_path in databases:
        result = _audit_namespace(namespace=namespace, database_path=database_path)
        results.append(result)
    return EncryptionAuditReport(
        namespaces_directory=namespaces_directory,
        results=tuple(results),
        scan_findings=tuple(scan_findings),
    )


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Read-only, fail-closed audit of sensitive payload encryption in every MetaList namespace"
        )
    )
    parser.add_argument(
        "--namespaces-dir",
        type=Path,
        default=_DEFAULT_NAMESPACES_DIRECTORY,
        help=f"namespace root (default: {_DEFAULT_NAMESPACES_DIRECTORY})",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = _parse_args(argv)
    report = audit_all_namespaces(namespaces_directory=args.namespaces_dir)
    print(report.render_text())
    if report.passed:
        return 0
    return 1


def cli() -> int:
    return main(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(cli())
