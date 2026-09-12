from __future__ import annotations

import secrets
from datetime import datetime, timezone
from functools import wraps
from types import SimpleNamespace
from typing import Optional, Tuple

from zxcvbn import zxcvbn

from app.models.database import SafeSession
from app.config import (
    KDF_ALGORITHM,
    KDF_MAX_MEMORY_COST_KIB,
    KDF_MAX_PARALLELISM,
    KDF_MAX_TIME_COST,
    KDF_MEMORY_COST_KIB,
    KDF_MIN_MEMORY_COST_KIB,
    KDF_MIN_PARALLELISM,
    KDF_MIN_TIME_COST,
    KDF_PARALLELISM,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    PASSWORD_MIN_ZXCVBN_SCORE,
    VAULT_VERSION,
)
from app.db.session import begin_writer, recoverable_database_change, get_request_session
from app.db.migrations import CURRENT_DATABASE_VERSION
from app.db.migrations import MigrationResult
from app.db.migrations import purge_migration_residue
from app.db.migrations import read_database_version
from app.db.migrations import run_database_migrations
from app.db.notes_sql import fetch_all_for_cache
from app.db.notes_sql import update_note_fields_preserving_updated_at
from app.db.ontology_rules_sql import fetch_all_rules as fetch_all_ontology_rules
from app.db.ontology_rules_sql import update_rule as update_ontology_rule
from app.db.settings_sql import (
    clear_password_settings,
    fetch_settings,
    insert_default_settings,
    update_password_settings,
)
from app.services.content_cache import (
    cache_note,
    cache_note_proposed_tags,
    cache_note_tags,
    cache_note_text,
)
from app.services.file_storage import decrypt_all_files_for_plaintext, encrypt_all_files_for_active_dek
from app.services.search_history import (
    decrypt_all_search_history_for_plaintext,
    encrypt_all_search_history_for_active_dek,
)
from app.services.sound_storage import decrypt_all_sounds_for_plaintext
from app.services.sound_storage import encrypt_all_sounds_for_active_dek
from app.services.link_titles import rewrite_persisted_link_titles
from app.services.reminders import reminder_store
from app.utils.text_utils import strip_html
from app.services.encryption import EncryptionService
from app.services.maintenance_mode import maintenance_service
from app.services.note_store import store as note_store
from app.services.tab_state import tab_state_store
from app.services.backup_service import create_timestamped_backup
from app.services.client_state_service import rewrite_client_state_storage
from app.security.encryption import set_encryption_required
from app.security.note_html import sanitize_note_html


def migrate_restored_database_if_unlocked(
    *,
    connection,
    password_required: bool,
) -> int:
    if not isinstance(password_required, bool):
        raise TypeError("password_required must be a bool")
    database_version = read_database_version(connection)
    if database_version > CURRENT_DATABASE_VERSION:
        raise RuntimeError(
            f"Restored database version {database_version} is newer than supported version "
            f"{CURRENT_DATABASE_VERSION}"
        )
    if password_required or database_version == CURRENT_DATABASE_VERSION:
        return database_version
    with connection:
        run_database_migrations(
            connection=connection,
            encryption_enabled=False,
            encryption_service=None,
        )
    purge_migration_residue(connection)
    return CURRENT_DATABASE_VERSION


def _recoverable_password_transition(function):
    @wraps(function)
    def wrapped(self, *args, **kwargs):
        with recoverable_database_change(SafeSession._db_path):
            previous_session = self.db
            self.db = get_request_session()
            try:
                return function(self, *args, **kwargs)
            finally:
                self.db = previous_session
    return wrapped


class AuthService:
    """Service for managing passwords and authentication."""

    def __init__(self, db: SafeSession):
        self.db = db
        self.encryption = EncryptionService()

    def get_settings(self) -> Optional[SimpleNamespace]:
        """Fetch application settings from the database."""
        with SafeSession.allow_reads("auth:get_settings"):
            row = fetch_settings(self.db.connection())
        if not row:
            set_encryption_required(False)
            return None
        settings = SimpleNamespace(**row)
        set_encryption_required(bool(settings.encryption_enabled))
        return settings

    def initialize_settings(self) -> SimpleNamespace:
        """Ensure settings exist before continuing."""
        settings = self.get_settings()
        if settings:
            return settings

        with begin_writer() as connection:
            insert_default_settings(connection)
        settings = self.get_settings()
        if not settings:
            raise RuntimeError("App settings initialization failed")
        return settings

    def hash_password(
        self,
        password: str,
        salt: bytes,
        time_cost: int,
        memory_cost_kib: int,
        parallelism: int,
    ) -> str:
        """Return Argon2id digest used for password verifier storage."""
        key = self.encryption.derive_master_key(
            password,
            salt,
            time_cost,
            memory_cost_kib,
            parallelism,
        )
        return key.hex()

    def verify_password(self, password: str) -> bool:
        """Return True if supplied password matches stored hash."""
        settings = self.get_settings()
        if not settings or not settings.encryption_enabled:
            return False

        self._assert_supported_vault_profile(settings)
        if settings.auth_verifier is None:
            raise RuntimeError("Encryption enabled but auth_verifier is missing")
        if settings.auth_salt is None:
            raise RuntimeError("auth_verifier set but auth_salt is NULL")
        if settings.auth_iterations is None:
            raise RuntimeError("auth_verifier set but auth_iterations is NULL")
        if settings.kdf_memory_cost_kib is None:
            raise RuntimeError("auth_verifier set but kdf_memory_cost_kib is NULL")
        if settings.kdf_parallelism is None:
            raise RuntimeError("auth_verifier set but kdf_parallelism is NULL")
        candidate = self.hash_password(
            password,
            settings.auth_salt,
            settings.auth_iterations,
            settings.kdf_memory_cost_kib,
            settings.kdf_parallelism,
        )
        return secrets.compare_digest(candidate, settings.auth_verifier)

    def check_password_strength(self, password: str) -> bool:
        """Return True when a new password meets the current policy."""
        return self.password_policy_error(password) is None

    def password_policy_error(self, password: str) -> str | None:
        """Return a user-facing policy error for a new password, if any."""
        if not isinstance(password, str):
            raise TypeError("password must be a string")
        if len(password) < PASSWORD_MIN_LENGTH:
            return f"Password must be at least {PASSWORD_MIN_LENGTH} characters"
        if len(password) > PASSWORD_MAX_LENGTH:
            return f"Password must be no more than {PASSWORD_MAX_LENGTH} characters"

        strength = zxcvbn(password, user_inputs=["metalist"])
        if "score" not in strength:
            raise RuntimeError("zxcvbn result is missing score")
        score = strength["score"]
        if not isinstance(score, int):
            raise RuntimeError("zxcvbn score must be an integer")
        if score < PASSWORD_MIN_ZXCVBN_SCORE:
            return (
                "Password is too common or predictable. "
                "Use a longer passphrase or a less predictable password."
            )
        return None

    def has_password(self) -> bool:
        """Return True if password protection is enabled."""
        settings = self.get_settings()
        return settings is not None and bool(settings.encryption_enabled)

    def _assert_supported_vault_profile(self, settings: SimpleNamespace) -> None:
        if settings.vault_version is None:
            raise RuntimeError("Encryption enabled but vault_version is NULL")
        if settings.vault_version != VAULT_VERSION:
            raise RuntimeError(f"Unsupported vault version: {settings.vault_version}")
        if settings.kdf_algorithm is None:
            raise RuntimeError("Encryption enabled but kdf_algorithm is NULL")
        if settings.kdf_algorithm != KDF_ALGORITHM:
            raise RuntimeError(f"Unsupported kdf_algorithm: {settings.kdf_algorithm}")
        if settings.auth_iterations is None:
            raise RuntimeError("Encryption enabled but auth_iterations is NULL")
        if not (KDF_MIN_TIME_COST <= settings.auth_iterations <= KDF_MAX_TIME_COST):
            raise RuntimeError(f"auth_iterations out of range: {settings.auth_iterations}")
        if settings.kek_iterations is None:
            raise RuntimeError("Encryption enabled but kek_iterations is NULL")
        if not (KDF_MIN_TIME_COST <= settings.kek_iterations <= KDF_MAX_TIME_COST):
            raise RuntimeError(f"kek_iterations out of range: {settings.kek_iterations}")
        if settings.kdf_memory_cost_kib is None:
            raise RuntimeError("Encryption enabled but kdf_memory_cost_kib is NULL")
        if not (KDF_MIN_MEMORY_COST_KIB <= settings.kdf_memory_cost_kib <= KDF_MAX_MEMORY_COST_KIB):
            raise RuntimeError(
                f"kdf_memory_cost_kib out of range: {settings.kdf_memory_cost_kib}"
            )
        if settings.kdf_parallelism is None:
            raise RuntimeError("Encryption enabled but kdf_parallelism is NULL")
        if not (KDF_MIN_PARALLELISM <= settings.kdf_parallelism <= KDF_MAX_PARALLELISM):
            raise RuntimeError(f"kdf_parallelism out of range: {settings.kdf_parallelism}")

    def _derive_kek_from_settings(self, password: str, settings: SimpleNamespace) -> bytes:
        self._assert_supported_vault_profile(settings)
        if settings.kek_salt is None:
            raise RuntimeError("Encryption enabled but kek_salt is NULL")
        if settings.kek_iterations is None:
            raise RuntimeError("Encryption enabled but kek_iterations is NULL")
        if settings.kdf_memory_cost_kib is None:
            raise RuntimeError("Encryption enabled but kdf_memory_cost_kib is NULL")
        if settings.kdf_parallelism is None:
            raise RuntimeError("Encryption enabled but kdf_parallelism is NULL")
        return self.encryption.derive_master_key(
            password,
            settings.kek_salt,
            settings.kek_iterations,
            settings.kdf_memory_cost_kib,
            settings.kdf_parallelism,
        )

    def unwrap_dek_for_password(self, password: str) -> bytes:
        """Return the decrypted DEK for a verified password."""
        settings = self.get_settings()
        if not settings:
            raise RuntimeError("Failed to retrieve settings")
        if not settings.encryption_enabled:
            raise RuntimeError("Encryption is not enabled")

        self._assert_supported_vault_profile(settings)
        if settings.encrypted_dek is None or settings.dek_nonce is None or settings.dek_tag is None:
            raise RuntimeError("Encryption enabled but DEK metadata is missing")

        kek = self._derive_kek_from_settings(password, settings)
        return self.encryption.decrypt_dek(
            settings.encrypted_dek,
            settings.dek_nonce,
            settings.dek_tag,
            kek,
        )

    def run_authenticated_database_migrations(self, *, dek: bytes) -> MigrationResult:
        if not isinstance(dek, bytes) or len(dek) == 0:
            raise ValueError("Database migrations require a non-empty DEK")
        connection = self.db.connection()
        initial_version = read_database_version(connection)
        if initial_version > CURRENT_DATABASE_VERSION:
            raise RuntimeError(
                f"Database version {initial_version} is newer than supported version "
                f"{CURRENT_DATABASE_VERSION}"
            )
        if initial_version == CURRENT_DATABASE_VERSION:
            return MigrationResult(
                initial_version=initial_version,
                final_version=initial_version,
                applied_versions=(),
                rewritten_payload_count=0,
            )
        maintenance_service.enter_maintenance("Upgrading namespace database")
        try:
            create_timestamped_backup()
            migration_encryption = EncryptionService()
            migration_encryption.dek = dek
            with SafeSession.allow_reads("auth:database_migrations"):
                with connection:
                    migration_result = run_database_migrations(
                        connection=connection,
                        encryption_enabled=True,
                        encryption_service=migration_encryption,
                    )
            if migration_result.applied_versions:
                connection.execute(f"PRAGMA user_version = {initial_version}")
                connection.commit()
                purge_migration_residue(connection)
                connection.execute(f"PRAGMA user_version = {CURRENT_DATABASE_VERSION}")
                connection.commit()
            return migration_result
        finally:
            maintenance_service.exit_maintenance()

    @_recoverable_password_transition
    def set_password(self, password: str, time_cost: int) -> Tuple[bool, str]:
        """Enable password protection by encrypting all existing content."""
        if self.has_password():
            return False, "Password already exists. Use change_password instead."
        password_policy_error = self.password_policy_error(password)
        if password_policy_error is not None:
            return False, password_policy_error
        if not (KDF_MIN_TIME_COST <= time_cost <= KDF_MAX_TIME_COST):
            return (
                False,
                f"KDF time cost must be between {KDF_MIN_TIME_COST} and {KDF_MAX_TIME_COST}",
            )

        self.initialize_settings()
        auth_salt = self.encryption.generate_salt()
        kek_salt = self.encryption.generate_salt()
        auth_iterations = time_cost
        kek_iterations = time_cost
        kdf_memory_cost_kib = KDF_MEMORY_COST_KIB
        kdf_parallelism = KDF_PARALLELISM

        auth_verifier = self.hash_password(
            password,
            auth_salt,
            auth_iterations,
            kdf_memory_cost_kib,
            kdf_parallelism,
        )

        dek = self.encryption.generate_dek()
        kek = self.encryption.derive_master_key(
            password,
            kek_salt,
            kek_iterations,
            kdf_memory_cost_kib,
            kdf_parallelism,
        )
        encrypted_dek, dek_nonce, dek_tag = self.encryption.encrypt_dek(dek, kek)

        self.encryption.master_key = None
        self.encryption.dek = dek

        maintenance_service.enter_maintenance("Encrypting all notes with new password")
        encrypted_count = 0
        encrypted_rule_count = 0
        encrypted_file_count = 0
        encrypted_sound_count = 0
        encrypted_search_history_count = 0
        encrypted_reminder_count = 0
        try:
            with begin_writer() as connection:
                with SafeSession.allow_reads("auth:set_password:fetch_notes"):
                    notes = fetch_all_for_cache(connection)

                for note in notes:
                    note_id = note["id"]
                    content = note["content"]
                    tags = note["tags"]
                    proposed_tags = note["proposed_tags"]
                    if content is None:
                        raise RuntimeError(
                            f"Password setup failed: Note {note_id} has NULL content."
                        )
                    if tags is None:
                        raise RuntimeError(
                            f"Password setup failed: Note {note_id} has NULL tags."
                        )
                    if proposed_tags is None:
                        raise RuntimeError(
                            f"Password setup failed: Note {note_id} has NULL proposed_tags."
                        )

                    content_encrypted = note["encryption_nonce"] is not None
                    if not content_encrypted:
                        content_encrypted = note["encryption_tag"] is not None
                    tags_encrypted = note["tags_encryption_nonce"] is not None
                    if not tags_encrypted:
                        tags_encrypted = note["tags_encryption_tag"] is not None
                    proposed_tags_encrypted = (
                        note["proposed_tags_encryption_nonce"] is not None
                    )
                    if not proposed_tags_encrypted:
                        proposed_tags_encrypted = (
                            note["proposed_tags_encryption_tag"] is not None
                        )
                    if proposed_tags_encrypted and (
                        note["proposed_tags_encryption_nonce"] is None
                        or note["proposed_tags_encryption_tag"] is None
                    ):
                        raise RuntimeError(
                            "Password setup failed: proposed tags have incomplete encryption metadata: "
                            f"note_id={note_id}"
                        )

                    if content_encrypted and tags_encrypted and proposed_tags_encrypted:
                        continue

                    update_payload: dict[str, object] = {}

                    if not content_encrypted:
                        sanitized_content = sanitize_note_html(content)
                        ciphertext_base64, nonce_bytes, tag_bytes = self.encryption.encrypt_for_storage(
                            sanitized_content
                        )
                        cache_note(note_id, sanitized_content)
                        cache_note_text(note_id, strip_html(sanitized_content))
                        update_payload.update(
                            {
                                "content": ciphertext_base64,
                                "encryption_nonce": nonce_bytes,
                                "encryption_tag": tag_bytes,
                            }
                        )

                    if not tags_encrypted:
                        tags_ciphertext, tags_nonce, tags_tag = self.encryption.encrypt_for_storage(tags)
                        cache_note_tags(note_id, tags)
                        update_payload.update(
                            {
                                "tags": tags_ciphertext,
                                "tags_encryption_nonce": tags_nonce,
                                "tags_encryption_tag": tags_tag,
                            }
                        )

                    if not proposed_tags_encrypted:
                        proposed_ciphertext, proposed_nonce, proposed_tag = (
                            self.encryption.encrypt_for_storage(proposed_tags)
                        )
                        cache_note_proposed_tags(note_id, proposed_tags)
                        update_payload.update(
                            {
                                "proposed_tags": proposed_ciphertext,
                                "proposed_tags_encryption_nonce": proposed_nonce,
                                "proposed_tags_encryption_tag": proposed_tag,
                            }
                        )

                    update_note_fields_preserving_updated_at(connection, note_id, **update_payload)
                    encrypted_count += 1

                with SafeSession.allow_reads("auth:set_password:fetch_ontology_rules"):
                    ontology_rules = fetch_all_ontology_rules(connection)

                for rule in ontology_rules:
                    rule_id = rule["id"]
                    rule_text = rule["rule_text"]
                    nonce = rule["rule_encryption_nonce"]
                    tag = rule["rule_encryption_tag"]

                    if not isinstance(rule_id, int):
                        raise TypeError("ontology_rules.id must be an int")
                    if rule_text is None:
                        raise RuntimeError(f"Password setup failed: ontology rule {rule_id} has NULL rule_text")
                    if not isinstance(rule_text, str):
                        raise TypeError(f"ontology_rules.rule_text must be a string: {type(rule_text)}")

                    encrypted = nonce is not None
                    if not encrypted:
                        encrypted = tag is not None

                    if encrypted and (nonce is None or tag is None):
                        raise RuntimeError(
                            "Password setup failed: ontology rule has incomplete encryption metadata: "
                            f"rule_id={rule_id} nonce={nonce is not None} tag={tag is not None}"
                        )
                    if encrypted:
                        continue

                    ciphertext, nonce_bytes, tag_bytes = self.encryption.encrypt_for_storage(rule_text)
                    update_ontology_rule(
                        connection,
                        rule_id,
                        rule_text=ciphertext,
                        rule_encryption_nonce=nonce_bytes,
                        rule_encryption_tag=tag_bytes,
                        updated_at=datetime.now(timezone.utc),
                    )
                    encrypted_rule_count += 1

                update_password_settings(
                    connection,
                    auth_verifier=auth_verifier,
                    auth_salt=auth_salt,
                    auth_iterations=auth_iterations,
                    kek_salt=kek_salt,
                    kek_iterations=kek_iterations,
                    vault_version=VAULT_VERSION,
                    kdf_algorithm=KDF_ALGORITHM,
                    kdf_memory_cost_kib=kdf_memory_cost_kib,
                    kdf_parallelism=kdf_parallelism,
                    encrypted_dek=encrypted_dek,
                    dek_nonce=dek_nonce,
                    dek_tag=dek_tag,
                    encryption_algorithm="AES-256-GCM",
                )
                encrypted_file_count = encrypt_all_files_for_active_dek(
                    encryption_service=self.encryption,
                )
                encrypted_sound_count = encrypt_all_sounds_for_active_dek(
                    encryption_service=self.encryption,
                )
                encrypted_search_history_count = encrypt_all_search_history_for_active_dek(
                    connection=connection,
                    encryption_service=self.encryption,
                )
                with SafeSession.allow_reads("auth:set_password:fetch_link_titles"):
                    encrypted_link_title_count = rewrite_persisted_link_titles(
                        connection=connection,
                        encryption_service=self.encryption,
                        force_plaintext=False,
                    )
                tab_state_store.rewrite_persisted_state(
                    connection=connection,
                    encryption_service=self.encryption,
                    force_plaintext=False,
                )
                encrypted_reminder_count = reminder_store.rewrite_persisted_reminders(
                    connection=connection,
                    encryption_service=self.encryption,
                    force_plaintext=False,
                )
                rewrite_client_state_storage(
                    connection=connection,
                    encryption_service=self.encryption,
                    force_plaintext=False,
                )
        finally:
            maintenance_service.exit_maintenance()

        set_encryption_required(True)

        if note_store.loaded:
            with SafeSession.allow_reads("auth:set_password:refresh_store"):
                note_store.load_from_db(get_request_session(), prefetched_rows=None)

        return (
            True,
            "Password set successfully. "
            f"Encrypted {encrypted_count} notes, {encrypted_rule_count} ontology rules, "
            f"{encrypted_file_count} files, {encrypted_sound_count} sounds, "
            f"{encrypted_search_history_count} search histories, "
            f"{encrypted_link_title_count} link titles, and {encrypted_reminder_count} reminders.",
        )

    def change_password(
        self,
        current_password: str,
        new_password: str,
        time_cost: int,
    ) -> Tuple[bool, str]:
        """Change the password while keeping the existing DEK."""
        if not self.has_password():
            return False, "No password is currently set. Use set_password instead."
        if not self.verify_password(current_password):
            return False, "Current password is incorrect"
        password_policy_error = self.password_policy_error(new_password)
        if password_policy_error is not None:
            return False, password_policy_error

        settings = self.get_settings()
        if not settings:
            raise RuntimeError("App settings missing during password change")
        self._assert_supported_vault_profile(settings)
        if settings.encrypted_dek is None or settings.dek_nonce is None or settings.dek_tag is None:
            raise RuntimeError("App settings missing DEK metadata during password change")

        old_kek = self._derive_kek_from_settings(current_password, settings)

        dek = self.encryption.decrypt_dek(
            settings.encrypted_dek,
            settings.dek_nonce,
            settings.dek_tag,
            old_kek,
        )

        if not (KDF_MIN_TIME_COST <= time_cost <= KDF_MAX_TIME_COST):
            return (
                False,
                f"KDF time cost must be between {KDF_MIN_TIME_COST} and {KDF_MAX_TIME_COST}",
            )

        auth_salt = self.encryption.generate_salt()
        kek_salt = self.encryption.generate_salt()
        auth_iterations = time_cost
        kek_iterations = time_cost
        kdf_memory_cost_kib = KDF_MEMORY_COST_KIB
        kdf_parallelism = KDF_PARALLELISM

        auth_verifier = self.hash_password(
            new_password,
            auth_salt,
            auth_iterations,
            kdf_memory_cost_kib,
            kdf_parallelism,
        )
        new_kek = self.encryption.derive_master_key(
            new_password,
            kek_salt,
            kek_iterations,
            kdf_memory_cost_kib,
            kdf_parallelism,
        )
        encrypted_dek, dek_nonce, dek_tag = self.encryption.encrypt_dek(dek, new_kek)

        with begin_writer() as connection:
            update_password_settings(
                connection,
                auth_verifier=auth_verifier,
                auth_salt=auth_salt,
                auth_iterations=auth_iterations,
                kek_salt=kek_salt,
                kek_iterations=kek_iterations,
                vault_version=VAULT_VERSION,
                kdf_algorithm=KDF_ALGORITHM,
                kdf_memory_cost_kib=kdf_memory_cost_kib,
                kdf_parallelism=kdf_parallelism,
                encrypted_dek=encrypted_dek,
                dek_nonce=dek_nonce,
                dek_tag=dek_tag,
                encryption_algorithm="AES-256-GCM",
            )

        self.encryption.master_key = None
        self.encryption.dek = dek
        return True, "Password changed successfully. Notes remain encrypted with the same key."

    @_recoverable_password_transition
    def remove_password(self, current_password: str) -> Tuple[bool, str]:
        """Disable password protection by decrypting notes and clearing settings."""
        if not self.has_password():
            return False, "No password is currently set"
        if not self.verify_password(current_password):
            return False, "Password is incorrect"

        settings = self.get_settings()
        if not settings:
            raise RuntimeError("App settings missing during password removal")
        self._assert_supported_vault_profile(settings)
        if settings.encrypted_dek is None or settings.dek_nonce is None or settings.dek_tag is None:
            raise RuntimeError("App settings missing DEK metadata during password removal")

        kek = self._derive_kek_from_settings(current_password, settings)
        dek = self.encryption.decrypt_dek(
            settings.encrypted_dek,
            settings.dek_nonce,
            settings.dek_tag,
            kek,
        )
        self.encryption.master_key = None
        self.encryption.dek = dek

        maintenance_service.enter_maintenance("Decrypting all notes (removing password protection)")
        cache_content_updates: dict[str, str] = {}
        cache_tag_updates: dict[str, str] = {}
        cache_proposed_tag_updates: dict[str, str] = {}
        decrypted_file_count = 0
        decrypted_sound_count = 0
        decrypted_search_history_count = 0
        decrypted_reminder_count = 0
        try:
            decrypted_count = 0
            decrypted_rule_count = 0
            with begin_writer() as connection:
                with SafeSession.allow_reads("auth:remove_password:fetch_notes"):
                    notes = fetch_all_for_cache(connection)

                for note in notes:
                    note_id = note["id"]
                    content = note["content"]
                    nonce = note["encryption_nonce"]
                    tag = note["encryption_tag"]
                    tags = note["tags"]
                    tags_nonce = note["tags_encryption_nonce"]
                    tags_tag = note["tags_encryption_tag"]
                    proposed_tags = note["proposed_tags"]
                    proposed_tags_nonce = note["proposed_tags_encryption_nonce"]
                    proposed_tags_tag = note["proposed_tags_encryption_tag"]

                    content_encrypted = nonce is not None
                    if not content_encrypted:
                        content_encrypted = tag is not None
                    tags_encrypted = tags_nonce is not None
                    if not tags_encrypted:
                        tags_encrypted = tags_tag is not None
                    proposed_tags_encrypted = proposed_tags_nonce is not None
                    if not proposed_tags_encrypted:
                        proposed_tags_encrypted = proposed_tags_tag is not None
                    if not content_encrypted and not tags_encrypted and not proposed_tags_encrypted:
                        continue

                    update_payload: dict[str, object] = {}

                    if content_encrypted:
                        if nonce is None or tag is None:
                            raise RuntimeError(
                                "Password removal failed: encrypted note has incomplete metadata: "
                                f"note_id={note_id} nonce={nonce is not None} tag={tag is not None}"
                            )
                        if content is None:
                            raise RuntimeError(
                                f"Password removal failed: encrypted note {note_id} has NULL content"
                            )
                        plaintext = sanitize_note_html(
                            self.encryption.decrypt_from_storage(content, nonce, tag)
                        )
                        update_payload.update(
                            {
                                "content": plaintext,
                                "encryption_nonce": None,
                                "encryption_tag": None,
                            }
                        )
                        cache_content_updates[note_id] = plaintext
                    else:
                        if content is None:
                            raise RuntimeError(
                                f"Password removal failed: note {note_id} has NULL content"
                            )
                        plaintext = content

                    if tags_encrypted:
                        if tags_nonce is None or tags_tag is None:
                            raise RuntimeError(
                                "Password removal failed: encrypted tags have incomplete metadata: "
                                f"note_id={note_id} nonce={tags_nonce is not None} tag={tags_tag is not None}"
                            )
                        if tags is None:
                            raise RuntimeError(
                                f"Password removal failed: encrypted note {note_id} has NULL tags"
                            )
                        tags_plaintext = self.encryption.decrypt_from_storage(tags, tags_nonce, tags_tag)
                        update_payload.update(
                            {
                                "tags": tags_plaintext,
                                "tags_encryption_nonce": None,
                                "tags_encryption_tag": None,
                            }
                        )
                        cache_tag_updates[note_id] = tags_plaintext

                    if proposed_tags_encrypted:
                        if proposed_tags_nonce is None or proposed_tags_tag is None:
                            raise RuntimeError(
                                "Password removal failed: encrypted proposed tags have incomplete metadata: "
                                f"note_id={note_id} nonce={proposed_tags_nonce is not None} "
                                f"tag={proposed_tags_tag is not None}"
                            )
                        if proposed_tags is None:
                            raise RuntimeError(
                                f"Password removal failed: encrypted note {note_id} has NULL proposed_tags"
                            )
                        proposed_tags_plaintext = self.encryption.decrypt_from_storage(
                            proposed_tags,
                            proposed_tags_nonce,
                            proposed_tags_tag,
                        )
                        update_payload.update(
                            {
                                "proposed_tags": proposed_tags_plaintext,
                                "proposed_tags_encryption_nonce": None,
                                "proposed_tags_encryption_tag": None,
                            }
                        )
                        cache_proposed_tag_updates[note_id] = proposed_tags_plaintext

                    if update_payload:
                        update_note_fields_preserving_updated_at(connection, note_id, **update_payload)
                    decrypted_count += 1

                with SafeSession.allow_reads("auth:remove_password:fetch_ontology_rules"):
                    ontology_rules = fetch_all_ontology_rules(connection)

                for rule in ontology_rules:
                    rule_id = rule["id"]
                    rule_text = rule["rule_text"]
                    nonce = rule["rule_encryption_nonce"]
                    tag = rule["rule_encryption_tag"]

                    if not isinstance(rule_id, int):
                        raise TypeError("ontology_rules.id must be an int")
                    if rule_text is None:
                        raise RuntimeError(
                            f"Password removal failed: ontology rule {rule_id} has NULL rule_text"
                        )
                    if not isinstance(rule_text, str):
                        raise TypeError(f"ontology_rules.rule_text must be a string: {type(rule_text)}")

                    encrypted = nonce is not None
                    if not encrypted:
                        encrypted = tag is not None
                    if not encrypted:
                        continue

                    if nonce is None or tag is None:
                        raise RuntimeError(
                            "Password removal failed: encrypted ontology rule has incomplete metadata: "
                            f"rule_id={rule_id} nonce={nonce is not None} tag={tag is not None}"
                        )

                    plaintext = self.encryption.decrypt_from_storage(rule_text, nonce, tag)
                    update_ontology_rule(
                        connection,
                        rule_id,
                        rule_text=plaintext,
                        rule_encryption_nonce=None,
                        rule_encryption_tag=None,
                        updated_at=datetime.now(timezone.utc),
                    )
                    decrypted_rule_count += 1

                decrypted_file_count = decrypt_all_files_for_plaintext(
                    encryption_service=self.encryption,
                )
                decrypted_sound_count = decrypt_all_sounds_for_plaintext(
                    encryption_service=self.encryption,
                )
                decrypted_search_history_count = decrypt_all_search_history_for_plaintext(
                    connection=connection,
                    encryption_service=self.encryption,
                )
                with SafeSession.allow_reads("auth:remove_password:fetch_link_titles"):
                    decrypted_link_title_count = rewrite_persisted_link_titles(
                        connection=connection,
                        encryption_service=self.encryption,
                        force_plaintext=True,
                    )
                tab_state_store.rewrite_persisted_state(
                    connection=connection,
                    encryption_service=None,
                    force_plaintext=True,
                )
                decrypted_reminder_count = reminder_store.rewrite_persisted_reminders(
                    connection=connection,
                    encryption_service=None,
                    force_plaintext=True,
                )
                rewrite_client_state_storage(
                    connection=connection,
                    encryption_service=self.encryption,
                    force_plaintext=True,
                )
                clear_password_settings(connection)
            self.encryption.clear_keys()
        finally:
            maintenance_service.exit_maintenance()

        set_encryption_required(False)

        for note_id, content in cache_content_updates.items():
            cache_note(note_id, content)
            cache_note_text(note_id, strip_html(content))
        for note_id, tags in cache_tag_updates.items():
            cache_note_tags(note_id, tags)
        for note_id, proposed_tags in cache_proposed_tag_updates.items():
            cache_note_proposed_tags(note_id, proposed_tags)

        if note_store.loaded:
            with SafeSession.allow_reads("auth:remove_password:refresh_store"):
                note_store.load_from_db(get_request_session(), prefetched_rows=None)

        return (
            True,
            "Password removed successfully. "
            f"Decrypted {decrypted_count} notes, {decrypted_rule_count} ontology rules, "
            f"{decrypted_file_count} files, {decrypted_sound_count} sounds, "
            f"{decrypted_search_history_count} search histories, "
            f"{decrypted_link_title_count} link titles, and {decrypted_reminder_count} reminders.",
        )
