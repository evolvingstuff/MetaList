# Sound support removed

MetaList no longer has reminder sounds, a sound library, playback controls, or sound API routes. Reminders retain their visual popup and acknowledgment behavior.

Live database migration **8 → 9** removes legacy sound preferences, reminder sound fields, command-palette usage for the retired manager, and the `sounds` table from the attachment sidecar. Unrelated reminders, preferences, and attachments are preserved. Password-protected namespaces migrate only after successful unlock with the active DEK.

Existing backup archives and legacy sidecars remain byte-for-byte unchanged. A restored old database migrates only after installation as the live database, after unlock when encrypted. Old backups can therefore still contain historical sound data.

The removed implementation included `sound_storage.py`, `sounds_sql.py`, the sound router, the browser sound service/manager, and the `mutagen` dependency. Generic file attachments remain supported.
