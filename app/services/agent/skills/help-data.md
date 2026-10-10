# MetaList namespaces, backups, exports, and updates

Namespaces isolate notes, preferences, tags, reminders, and authentication. A
namespace is not a search tab. Search tabs are views within the same namespace.
Open namespace opens a picker of reachable namespaces with two buttons: Open in
This Tab (switching keeps one tab) and Open in New Tab; with no other namespace
yet it opens Create namespace instead. Create namespace opens
a name/port form. Rename current namespace opens a rename form. Delete namespace
opens a confirmation form; do not execute deletion or imply it has happened.
Manage namespace ports edits saved future launch profiles; saving does not launch,
switch to, or restart a namespace. Port changes take effect on a later launch.

Create backup now is an operation, not merely opening a dialog. It can prompt for
backup folder/settings and creates one versioned .tar.gz archive per namespace
containing its notes database and sibling files database when present. The result
shows one row per namespace. The help action cannot invoke backup creation.
Restore from backup opens a picker for configured-folder snapshots. The user
chooses and confirms a restore; success is confirmed with OK before reloading.
Opening this picker neither restores data nor changes backups. Existing backup
files are immutable recovery artifacts: no rewriting/repackaging/migration of
historical backups, including after password or schema changes. Restore installs
and migrates the live database only, leaving its source unchanged. Keep the
password that was used for an older encrypted snapshot. The restored live copy
inherits that snapshot's password/encryption state; restore does not substitute
the current live password or choose a new password. A later explicit password
change affects only that restored live copy. A backup is not the same
as an HTML export.

Export as HTML exports the current view for viewing/sharing, not a full restorable
database backup. Attach file stores an attachment in the namespace's sibling
files database. Default upload limit is 100 MiB and is server-configurable.
Trim unused files removes unused attachments and is not an opening action.
The agent can explain these operations but cannot execute them through help.

Version info shows application/database/runtime/namespace and encryption status.
It also provides update information; managed uv installs can use the in-app
installer. Opening Version info does not install an update. The user controls
installation/restart; do not claim a particular installed/latest version unless
it was supplied. Local help references cannot establish current release data.
Updates validate a candidate before stopping live namespaces and create fresh
backups; old backup archives remain unchanged. Do not advise editing or deleting
recovery archives to work around a startup failure.
