# Hosted MetaList: Downloading Your Own Copy, and the Backup Reminder

Status: agreed design, not built. Decided 2026-10-23. Code references below checked against the repo on 2026-10-23.

Vocabulary as in `docs/AI-SUMMARY.md`: users see **vault**; code, APIs and backup archives say **namespace**.

## Background

In the planned hosted MetaList, each user's vault runs in its own server process on MetaList's machines. The hosted service keeps encrypted snapshots of every vault (at least hourly while it is unlocked and being edited, and on every graceful stop). Users can restore from those snapshots themselves. Users must also always be able to keep their own copy on their own computer, and some will want to even knowing the service backs up.

The self-hosted backup feature assumes the server runs on the user's machine. In the hosted service it doesn't, so the feature needs a hosted mode.

## What exists today

- **Backup reminder** (`app/static/js/modules/backup-reminder-service.js`, `backup-reminder-schedule.js`; behavior in `docs/ui/controls.md`, "Backup reminder"). Per vault, `pref.backup_reminder`, default `weekly` (`backup-reminder-schedule.js:10`), options Off, Daily, Weekly, Every 2 weeks, Monthly. The × hides it for a day.
- **Its clock** is this vault's newest archive in the backup folder (`GET /api2/backup/times`, `app/api/routes/backups.py:883`).
- **A backup** is a `<namespace>-<timestamp>.metalist-backup.tar.gz` with the notes, files and search-history databases plus `manifest.json` (`app/services/backup_service.py:694`). Encrypted vaults stay encrypted inside it, and the manifest records `encryption_enabled` (`backup_service.py:449`).
- **Destination:** a folder on the machine running the server, chosen with a native picker run on that machine (`POST /api2/backup/folder/pick`, `backups.py:840`) or typed as an absolute path (`PUT /api2/backup/settings`, `backups.py:819`; `POST /api2/backup/run`, `backups.py:893`).
- **Browser downloads** exist only for the notes HTML export (`GET /api2/notes/export-html`, `app/api/routes/notes.py:915`). Nothing downloads a backup archive to the browser.
- **No hosted-mode flag** exists in `app/`.

## Problems in a hosted deployment

1. "Back Up Now" would write the archive onto the hosting machine, not the user's computer.
2. The reminder's clock would read the hosting machine's disk.
3. **Security:** the folder settings let a signed-in user make the server write files at any absolute path they choose. That is correct for self-hosting, where the user owns the machine. On a shared hosting machine it must be refused by the server, not just hidden in the UI.

## Design

### 1. Hosted mode

A server-side setting, supplied by the deployment (environment or launch configuration), never by a user. Self-hosted behavior is unchanged.

| | Self-hosted | Hosted |
|---|---|---|
| Back Up Now | Writes an archive to the backup folder | Downloads an archive through the browser |
| Backup folder settings, folder picker, `/backup/run` with a folder | Available | Refused by the server; hidden in the UI |
| Reminder clock | Newest archive in the folder | Last download of this vault's copy |
| Reminder default | Weekly | Off |

### 2. What the download is: an encrypted archive in the self-hosted format

- The same `.metalist-backup.tar.gz` format and manifest as self-hosted backups, so it restores into a self-hosted install of the same or newer version. It doubles as the way out if the hosted service ever goes away.
- It is ciphertext and opens only with the vault's password or recovery key. The download UI says so: if both are lost, this copy can't be opened either.
- **Vault unlocked:** the click makes a fresh snapshot through the normal snapshot path (checkpoint, then the SQLite backup API or `VACUUM INTO`; never a raw file copy), stores it with the other retained snapshots, and streams it. It's up to the minute and also counts as a regular snapshot.
- **Vault process not running** (locked, dormant, or a lapsed account): serve the newest retained snapshot, with its timestamp shown. Serving ciphertext needs no key.
- **Plaintext export stays a separate menu item.** "Back Up Now" never produces plaintext, and no reminder ever suggests a plaintext copy.

### 3. The reminder in hosted mode

- Menu label: **Remind me to keep my own copy**. Same choices, **Off by default** for every hosted user, including trial users.
- Help text: *"We already keep hourly snapshots of this vault. This is a second copy on your own computer. It opens with your password and the free self-hosted MetaList."*
- Card when due: *"You last downloaded your own copy of this vault N days ago."*, or with none, *"You haven't downloaded your own copy of this vault yet."* Button: **Download a copy**. The × hides it for a day, as today.
- The server can only know the file was sent, not saved, so the wording says "downloaded", never "backed up". Hosted wording must never suggest the vault lacks a backup.
- The clock is a per-vault "last own copy downloaded at" time, recorded when the download finishes streaming. It replaces `GET /api2/backup/times` as the reminder's source in hosted mode.
- The default is currently a browser constant (`BACKUP_REMINDER_DEFAULT`); in hosted mode the server supplies it.

### 4. One-time prompt

"Download your own copy" is shown once each time a trial ends, the user cancels, the subscription lapses, or the user asks to delete the account, even when the reminder is off.

### 5. Never gated

The own-copy download works in every account state (trial, active, lapsed, cancelled during the grace period) for as long as the account exists, the same rule as export. Release check: a test downloads and restores the archive in each of those states.

## Invariants

1. In hosted mode the server never writes a backup to a path the user supplies; the folder routes refuse.
2. Hosted "Back Up Now" always produces an encrypted archive in the self-hosted format, never plaintext.
3. The own-copy download is never gated by trial or subscription state while the account exists.
4. The hosted reminder is off by default, worded as optional, and never says the vault has no backup.
5. The reminder's clock counts downloads, and its text says "downloaded".
6. Hosted mode is set by the deployment, never by a user setting.

## Open questions

- **File storage layout.** If hosted file storage differs from the single files database in today's archive (for example, sealed shards), either pack it into the self-hosted format on download or teach self-hosted restore to read the hosted layout.
- **Large vaults.** Archives with many files could be many GB. Offer "notes only" and "notes and files" separately? Make the download resumable?
- **Upload back in.** Can a hosted user restore from a copy they downloaded (upload it as a new vault), or only from retained snapshots?
