"""SQLite schema helpers for MetaList."""

from __future__ import annotations

from sqlite3 import Connection

NOTES_TABLE = "notes"
APP_SETTINGS_TABLE = "app_settings"
ONTOLOGY_RULES_TABLE = "ontology_rules"
TAB_STATE_TABLE = "tab_state"
LINK_TITLES_TABLE = "link_titles"
REMINDERS_TABLE = "reminders"
SEARCH_HISTORY_TABLE = "search_interaction_history"
NAMESPACE_LAUNCH_PROFILE_TABLE = "namespace_launch_profile"
NAMESPACE_CONTENT_MIGRATIONS_TABLE = "namespace_content_migrations"

_CREATE_NOTES_TABLE = f"""
CREATE TABLE IF NOT EXISTS {NOTES_TABLE} (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    proposed_tags TEXT NOT NULL DEFAULT '',
    is_collapsed INTEGER NOT NULL DEFAULT 0,
    encryption_nonce BLOB,
    encryption_tag BLOB,
    tags_encryption_nonce BLOB,
    tags_encryption_tag BLOB,
    proposed_tags_encryption_nonce BLOB,
    proposed_tags_encryption_tag BLOB,
    parent_id TEXT,
    prev_id TEXT,
    next_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

_CREATE_NOTES_PARENT_INDEX = f"""
CREATE INDEX IF NOT EXISTS idx_{NOTES_TABLE}_parent ON {NOTES_TABLE}(parent_id);
"""

_CREATE_NOTES_PREV_INDEX = f"""
CREATE INDEX IF NOT EXISTS idx_{NOTES_TABLE}_prev ON {NOTES_TABLE}(prev_id);
"""

_CREATE_NOTES_NEXT_INDEX = f"""
CREATE INDEX IF NOT EXISTS idx_{NOTES_TABLE}_next ON {NOTES_TABLE}(next_id);
"""

_CREATE_APP_SETTINGS_TABLE = f"""
CREATE TABLE IF NOT EXISTS {APP_SETTINGS_TABLE} (
    id INTEGER PRIMARY KEY,
    auth_verifier TEXT,
    auth_salt BLOB,
    auth_iterations INTEGER,
    kek_salt BLOB,
    kek_iterations INTEGER,
    vault_version INTEGER,
    kdf_algorithm TEXT,
    kdf_memory_cost_kib INTEGER,
    kdf_parallelism INTEGER,
    encryption_enabled INTEGER NOT NULL DEFAULT 0,
    encryption_algorithm TEXT,
    encrypted_dek BLOB,
    dek_nonce BLOB,
    dek_tag BLOB,
    backup_settings_json TEXT,
    backup_settings_encryption_nonce BLOB,
    backup_settings_encryption_tag BLOB,
    client_preferences_json TEXT,
    client_preferences_encryption_nonce BLOB,
    client_preferences_encryption_tag BLOB,
    command_palette_usage_json TEXT,
    command_palette_usage_encryption_nonce BLOB,
    command_palette_usage_encryption_tag BLOB,
    tag_prefix_settings_json TEXT,
    tag_prefix_settings_encryption_nonce BLOB,
    tag_prefix_settings_encryption_tag BLOB,
    openai_api_key_ciphertext TEXT,
    openai_api_key_encryption_nonce BLOB,
    openai_api_key_encryption_tag BLOB,
    session_timeout_minutes INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

_CREATE_ONTOLOGY_RULES_TABLE = f"""
CREATE TABLE IF NOT EXISTS {ONTOLOGY_RULES_TABLE} (
    id INTEGER PRIMARY KEY,
    rule_text TEXT NOT NULL,
    rule_encryption_nonce BLOB,
    rule_encryption_tag BLOB,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

_CREATE_TAB_STATE_TABLE = f"""
CREATE TABLE IF NOT EXISTS {TAB_STATE_TABLE} (
    id INTEGER PRIMARY KEY,
    state_json TEXT NOT NULL,
    state_encryption_nonce BLOB,
    state_encryption_tag BLOB,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

_CREATE_LINK_TITLES_TABLE = f"""
CREATE TABLE IF NOT EXISTS {LINK_TITLES_TABLE} (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL,
    url_encryption_nonce BLOB,
    url_encryption_tag BLOB,
    title TEXT,
    title_encryption_nonce BLOB,
    title_encryption_tag BLOB,
    status TEXT NOT NULL,
    last_error_kind TEXT,
    last_checked_at TEXT NOT NULL,
    last_success_at TEXT,
    last_failure_at TEXT,
    next_check_after TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

_CREATE_REMINDERS_TABLE = f"""
CREATE TABLE IF NOT EXISTS {REMINDERS_TABLE} (
    id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    payload_encryption_nonce BLOB,
    payload_encryption_tag BLOB,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

_CREATE_SEARCH_HISTORY_TABLE = f"""
CREATE TABLE IF NOT EXISTS {SEARCH_HISTORY_TABLE} (
    storage_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    payload_encryption_nonce BLOB,
    payload_encryption_tag BLOB
);
"""

_CREATE_NAMESPACE_LAUNCH_PROFILE_TABLE = f"""
CREATE TABLE IF NOT EXISTS {NAMESPACE_LAUNCH_PROFILE_TABLE} (
    namespace TEXT PRIMARY KEY,
    port INTEGER,
    https_port INTEGER,
    mcp_port INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

_CREATE_NAMESPACE_CONTENT_MIGRATIONS_TABLE = f"""
CREATE TABLE IF NOT EXISTS {NAMESPACE_CONTENT_MIGRATIONS_TABLE} (
    migration_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    converted_count INTEGER NOT NULL,
    unresolved_count INTEGER NOT NULL,
    last_attempt_at TEXT NOT NULL,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (status IN ('pending', 'running', 'complete', 'error')),
    CHECK (converted_count >= 0),
    CHECK (unresolved_count >= 0)
);
"""


def create_namespace_content_migrations_table(connection: Connection) -> None:
    """Create the v2 content-migration ledger inside the active namespace DB."""
    connection.execute(_CREATE_NAMESPACE_CONTENT_MIGRATIONS_TABLE)


def _ensure_columns(connection: Connection, table: str, columns: dict[str, str]) -> None:
    existing = {
        row[1]
        for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
        if row and len(row) > 1
    }

    for name, col_type in columns.items():
        if name in existing:
            continue
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {col_type}")


def initialize_schema(connection: Connection) -> None:
    """Create tables and indexes if they do not already exist."""

    connection.execute(_CREATE_NOTES_TABLE)
    connection.execute(_CREATE_APP_SETTINGS_TABLE)
    connection.execute(_CREATE_ONTOLOGY_RULES_TABLE)
    connection.execute(_CREATE_TAB_STATE_TABLE)
    connection.execute(_CREATE_LINK_TITLES_TABLE)
    connection.execute(_CREATE_REMINDERS_TABLE)
    connection.execute(_CREATE_SEARCH_HISTORY_TABLE)
    connection.execute(_CREATE_NAMESPACE_LAUNCH_PROFILE_TABLE)
    connection.execute(_CREATE_NAMESPACE_CONTENT_MIGRATIONS_TABLE)
    _ensure_columns(
        connection,
        NOTES_TABLE,
        {
            "tags": "TEXT NOT NULL DEFAULT ''",
            "tags_encryption_nonce": "BLOB",
            "tags_encryption_tag": "BLOB",
            "proposed_tags": "TEXT NOT NULL DEFAULT ''",
            "proposed_tags_encryption_nonce": "BLOB",
            "proposed_tags_encryption_tag": "BLOB",
        },
    )
    _ensure_columns(
        connection,
        APP_SETTINGS_TABLE,
        {
            "auth_verifier": "TEXT",
            "auth_salt": "BLOB",
            "auth_iterations": "INTEGER",
            "kek_salt": "BLOB",
            "kek_iterations": "INTEGER",
            "vault_version": "INTEGER",
            "kdf_algorithm": "TEXT",
            "kdf_memory_cost_kib": "INTEGER",
            "kdf_parallelism": "INTEGER",
            "backup_settings_json": "TEXT",
            "backup_settings_encryption_nonce": "BLOB",
            "backup_settings_encryption_tag": "BLOB",
            "client_preferences_json": "TEXT",
            "client_preferences_encryption_nonce": "BLOB",
            "client_preferences_encryption_tag": "BLOB",
            "command_palette_usage_json": "TEXT",
            "command_palette_usage_encryption_nonce": "BLOB",
            "command_palette_usage_encryption_tag": "BLOB",
            "tag_prefix_settings_json": "TEXT",
            "tag_prefix_settings_encryption_nonce": "BLOB",
            "tag_prefix_settings_encryption_tag": "BLOB",
            "openai_api_key_ciphertext": "TEXT",
            "openai_api_key_encryption_nonce": "BLOB",
            "openai_api_key_encryption_tag": "BLOB",
            "session_timeout_minutes": "INTEGER",
        },
    )
    connection.execute(_CREATE_NOTES_PARENT_INDEX)
    connection.execute(_CREATE_NOTES_PREV_INDEX)
    connection.execute(_CREATE_NOTES_NEXT_INDEX)
