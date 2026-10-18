# Known Bugs

----

## After a backup restore, a background save can land on the lock page instead of the login screen (open, found 2026-10-18)

Seen twice in the browser smoke (`core`, the encrypted-backup step), once under load and
once not; passes when rerun. The restore restarts the server. A background tab-state save
(the routine scroll-position save) that reaches the new server process gets 401; the
browser treats it as an expired session ("Forcing logout") and navigates to `/locked`,
while the restore flow expects the login panel. The check then waits 30 s for
`#login-panel[data-revealed="true"]`. Order of events in the disposable logs:
`restore` 200, `tab-state` connection refused during the restart, `tab-state` 401 right
after it, `Forcing logout`, navigate `/locked`. Next step: a failing test that sends a
tab-state save right after a restore's restart, then decide which screen the restore
should land on and make the background save not override it.

----

## Pressing + on a proposal made it vanish instead of becoming a tag (fixed 2026-10-14)

Reported while trying Suggest Tags with AI: pressing `+` on a proposal removed it
from the row, but the tag never appeared in the tag bar (and the next save could
drop it). The server accepted it; the redraw then left the tag bar alone,
because it updates the tag bar only when its text still matches what it last
synced (so as not to overwrite typing), and that baseline was out of date:

- a click in the tag bar leaves a trailing space, compared as text, not tags;
- a save never moved the baseline to the saved tags;
- pressing `+`/`−` saved first only after a text edit, so tags typed in the tag
  bar stayed unsaved, and that save had never been imported in `mouse-events.js`
  (`+` after typing in the text threw and did nothing).

Fix: `syncTagBar` compares tags (`normalizeTagBarInput`); `markTagBarSaved`
(`tag-bar-service.js`) records the saved tags after a save or a server answer;
`+`/`−` and Suggest Tags with AI always call `actionSaveNote` (it skips when
nothing changed), now imported. Browser cases `acceptFromNoteMenuCase` and
`acceptFromTagBarCase` (`scripts/browser-ai-note-tag-regressions.mjs`) reproduced
it before the fix.

----

## Tag suggestions fail after deleting a tag's last note (fixed 2026-10-14)

Found by the Suggest Tags with AI browser test: after the only note carrying a
tag was deleted (or retagged), the tag bar's suggestions request failed with a
server error, so no suggestions showed. The search index keeps a tag's note set
once it is empty, and `list_explicit_tag_frequencies()`, `list_tag_frequencies()`,
`list_non_meta_tag_terms()` and the search bar's candidate list still listed the
tag with no notes. Before 0.18.0 that only meant a stale suggestion; since "Why
suggested" (0.18.0), explaining it asserts the tag is on some note, which failed
the whole request.

Fix: those listings skip tags no note carries, as
`list_raw_tag_frequencies_by_casefold()` already did. Tests:
`test_a_tag_whose_last_note_is_gone_is_no_longer_listed`
(`tests/unit/test_search_index_casefold_tags.py`) and
`test_the_tag_bar_never_suggests_a_tag_whose_last_note_was_deleted`
(`tests/unit/test_note_tag_suggestions.py`); both failed before the fix.

----

## Grammarly corrections revert after a moment (fixed 2026-10-14, awaiting the reporter's check)

Reported by a user (Henry, Grammarly app for Windows with the Grammarly
extension in Chrome): clicking a Grammarly suggestion showed the correction
for an instant, then the note left edit mode without it.

Cause, from his console log: pressing the suggestion card logged "Mouse down
outside any note - exiting edit mode", then "Note not dirty, skipping save":
MetaList saved and left edit mode at the press, before Grammarly applied the
correction, and redrew the note without it. Leaving edit mode at the press
(instead of the completed click) arrived on 2026-05-19 (`a696f7fa`), which is
when it stopped working for him. The 2026-09-16 exception (`6275bf1b`)
recognised only `grammarly-extension` and `grammarly-desktop-integration`;
his card is in another element (Grammarly renames them between versions).

Fix: `isWritingAssistantInteraction` (`mouse-events.js`) recognises any
`grammarly-*` element or a host marked `data-grammarly-shadow-root`; browser
cases for `grammarly-popups` and a marked `div` host in
`scripts/browser-writing-assistant-regressions.mjs` (they reproduced the
revert before the fix). A press that does end editing now logs the pressed
elements, so if it recurs, his console log names the element.

Still to confirm: the reporter tries the release with the fix.

----

## Undo referential integrity regression (adapter removal)

When migrating usecases to call `app/services/note_store.py` directly (removing
the `app/services/store.py` adapter), certain undo sequences (delete or move
down) left the in-memory links in an invalid state, causing the UI to enter a
loading/unresponsive state. Stashing those changes (restoring the adapter)
returns stability.

Status: adapter kept; revisit later with link invariants and stepwise migration.

Suggested approach:
- Add `note_store.debug_validate_links()` checks after each apply_* in undo flows
  (move, delete, restore) to pinpoint inconsistencies early.
- Migrate one usecase at a time (e.g., update_content → delete → move) and test
  undo/redo sequences before removing the adapter entirely.

----

## Errors when moving notes

When moving notes up or down in the outline, it works fine 
for outermost layer (notes without parents),
but fails when moving child notes within parents.

1. Click into note A
2. Press shift-cmd-enter to create child A.A
3. Press cmd-enter to create sibling A.B
4. with A.B selected, press cmd-uparrow. This will cause server errors

----
