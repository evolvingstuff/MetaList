# Known Bugs

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
