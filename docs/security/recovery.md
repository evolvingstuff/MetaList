# Recovery runbook

This runbook covers the current live-database recovery protocol. It never repairs or migrates a historical backup in place. See [security architecture](README.md#recovery-of-live-database-changes) and [the test map](../testing/coverage-map.md).

## Interrupted password change or restore

Password creation/removal and multi-database restore have a durable recovery boundary. A checksummed `.<database-name>.recovery` directory beside the live namespace database contains temporary transaction images for the notes and files databases. It is live transaction state, separate from the `backups/` directory. A commit marker distinguishes committed work from work that must roll back. The empty `.recovery.lock` file can legitimately remain after cleanup.

1. If the request failed, stop retrying edits while the server is in maintenance mode. Record the error and namespace name; do not publish logs containing private data.
2. Resolve the reported external problem, such as a full disk or lost access to the live data directory. Do not delete recovery files to bypass a failure. Do not change permissions or timestamps on backup archives.
3. Restart the affected namespace normally. Startup attempts recovery before storage auditing or migrations. An interrupted operation without a durable commit marker restores its previous database pair; completed work retains the committed pair. Recovery can retry after another interruption.
4. Log in and verify representative notes, hierarchy, attachments, and settings. A transition rolled back before commit requires the previous password. An archive restore uses the password that protected the selected backup, which may differ from the former live namespace password.
5. If recovery still fails, retain the complete live transaction state and source backups for diagnosis. Do not remove tables, discard a sidecar, hand-edit a recovery manifest, or suppress `BKP001`/storage audit failures. The server intentionally stays unavailable rather than serving inconsistent state.

A live password transition may temporarily retain its previous plaintext state in the owner-only recovery directory until commit/cleanup. Existing archives are never rewritten to match a new password.

## Restore from an archive

Use MetaList's backup/restore UI for a validated archive or supported legacy backup. The application verifies the source, stages and checks the database pair, installs the live copies within the recovery boundary, and verifies the original source hashes again. A current-namespace restore restarts the server; log in again afterward. Session undo history is not a substitute for a backup and is cleared during session replacement/restore.

- Keep the original archive and any legacy sidecars together and byte-for-byte unchanged. Do not repackage an archive to fix a manifest, rename its contents, run SQLite migration commands on it, or overwrite it with a newly generated archive.
- Older plaintext databases migrate only after installation as live data. Older encrypted databases migrate after successful unlock. A newer unsupported database version requires a compatible application version; editing its version number is unsafe.
- A checksum mismatch, malformed archive, unsupported hierarchy, missing companion database, or invalid encryption metadata requires diagnosis or a different verified backup. Disabling checks is not recovery.
- Creating a new backup requires a distinct destination. Existing archive names cannot be overwritten. Retention/deletion is a separately authorized operation, not part of this runbook.

## Verify recovery in disposable storage

The safest routine exercise uses the automated browser smoke: it creates its own namespace, attachment and encrypted archive, restores it, verifies restart/reauthentication and checks that the source hash is unchanged.

```bash
npm run test:browser
```

To investigate a particular archive interactively, use a separate absolute data root and free listener ports. Configure `METALIST_DATA_DIRECTORY` **before** launching the application; do not change the environment of an already-running personal namespace. Use the UI to restore the selected source into that disposable instance. The source archive remains read-only to this workflow. Avoid hand-copying just a live `.db` while its writer is running: WAL and companion-file consistency matter.

The standalone storage audit reads live namespace databases and reports metadata/integrity problems. It does not recover a lost password, prove absence of every stale disk byte, or repair an archive. Use `metalist-audit-encryption --help` for its supported namespace-root option; never point mutation tooling at historical backup files.

## Release and platform limits

Local macOS tests cover injected storage errors, interrupted processes, rollback, actual browser restore/restart, and archive immutability. They do not simulate physical power loss or establish Windows/Linux behavior. Every release candidate still requires the exact-commit platform matrix described in [release controls](supply-chain.md#release-validation).
