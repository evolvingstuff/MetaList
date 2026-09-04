# Database Schema

Core SQLite structures include AppSettings (singleton), DBNote (hierarchical linked list), and a namespace-local content-migration ledger. Additional feature tables are documented with their owning services.

```mermaid
erDiagram
    AppSettings {
        int id PK "Always 1"
        string auth_verifier "Argon2id verifier or NULL"
        bytes auth_salt "Auth salt"
        int auth_iterations "Argon2id time-cost"
        bytes kek_salt "KEK salt"
        int kek_iterations "Argon2id time-cost"
        int vault_version "Wrapped-key vault version"
        string kdf_algorithm "KDF profile (ARGON2ID)"
        int kdf_memory_cost_kib "Argon2id memory-cost (KiB)"
        int kdf_parallelism "Argon2id parallelism"
        boolean encryption_enabled "True if password set"
        string encryption_algorithm "AES-256-GCM"
        bytes encrypted_dek "Encrypted DEK"
        bytes dek_nonce "DEK nonce"
        bytes dek_tag "DEK auth tag"
        datetime created_at
        datetime updated_at
    }
    
    DBNote {
        string id PK "UUID v4"
        string content "Encrypted content"
        string tags "Encrypted tags"
        string proposed_tags "Encrypted unresolved tag proposals"
        boolean is_collapsed "UI collapse state"
        bytes encryption_nonce "Per-note nonce"
        bytes encryption_tag "Per-note tag"
        bytes tags_encryption_nonce "Tags nonce"
        bytes tags_encryption_tag "Tags tag"
        bytes proposed_tags_encryption_nonce "Proposal nonce"
        bytes proposed_tags_encryption_tag "Proposal tag"
        string parent_id FK "Parent note (self-ref)"
        string prev_id FK "Previous sibling (self-ref)"
        string next_id FK "Next sibling (self-ref)"
        datetime created_at
        datetime updated_at
    }

    NamespaceContentMigration {
        string migration_id PK "Named content migration identity"
        string status "pending, running, complete, or error"
        int converted_count "Atomically recorded replacements"
        int unresolved_count "Remote references still present"
        datetime last_attempt_at
        datetime completed_at "NULL until complete"
        datetime created_at
        datetime updated_at
    }

    TagActivityHistory {
        string storage_id PK "Random UUIDv4"
        string payload_json "Encrypted sparse daily tag counts when protected"
        bytes payload_encryption_nonce "AES-GCM nonce"
        bytes payload_encryption_tag "AES-GCM authentication tag"
    }
```
