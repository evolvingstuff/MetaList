# Known Bugs

----

## Grammarly corrections revert after a moment (reported 2026-10-12, on hold)

Reported by a user (Henry): in edit mode, clicking a Grammarly suggestion
(e.g. "Change preposition: in the" for "but not the US.") shows the
correction for about 1/10 second, then MetaList removes it. Spelling
corrections revert the same way. It had worked for years and broke in the
past few months.

Likely cause (not yet confirmed): `isWritingAssistantInteraction` in
`app/static/js/modules/mode-manager/events/mouse-events.js` recognises a
click on a suggestion card only inside an element named exactly
`grammarly-extension` or `grammarly-desktop-integration` (added in
`6275bf1b`, 2026-09-16). If Grammarly now draws its cards in an element
with another name, the click counts as an outside click: MetaList saves the
note as it was at the press (before Grammarly applies the change), leaves
edit mode and redraws it from that save.

Ruled out (none writes the note's text while editing): the AI privacy
preview observer, link-title prefetch, inactivity auto-save, focus/blur
handling, and the floating-window event guards.

Open questions:
- Does the note leave edit mode when he clicks the suggestion? (Confirms the
  outside-click cause.)
- Grammarly browser extension or desktop app, and on Windows or Mac? The
  Windows desktop app may apply corrections by pasting, which MetaList's
  paste handling processes: a possible second cause.
- Or inspect real Grammarly: install the extension (needs a free account)
  in Chrome and look at the elements it adds to a MetaList note.

Planned fix (BUG workflow): first a failing browser test in
`scripts/browser-writing-assistant-regressions.mjs` with a simulated card in
a newly named host (e.g. `grammarly-popups`); then recognise any element
whose name starts with `grammarly-`.

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
