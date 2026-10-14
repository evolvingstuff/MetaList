# Known Bugs

----

## Grammarly corrections revert after a moment (reported 2026-10-12, on hold)

Reported by a user (Henry): in edit mode, clicking a Grammarly suggestion
(e.g. "Change preposition: in the" for "but not the US.") shows the
correction for about 1/10 second, then MetaList removes it. Spelling
corrections revert the same way. It had worked for years and broke in the
past few months.

Answers from the reporter (2026-10-13):
- After MetaList reverts the change, the note leaves edit mode.
- He uses the Grammarly app for Windows (not the browser extension), in Chrome.

So the suggestion card is a separate Windows window over Chrome, not part
of the page: MetaList never sees the click on it, and the element-name
check in `isWritingAssistantInteraction` (`mouse-events.js`) is not the
cause. Recognising more `grammarly-*` names would not help.

What happens instead: clicking the card moves focus from Chrome to the
Grammarly window (window `blur`: MetaList only clears note-clipboard
tracking and ends tab drags, `handleWindowBlur` in `keyboard-events.js`);
then the app puts the correction into Chrome, probably with simulated
keystrokes or a paste. Something it sends makes MetaList save the note as it
was and leave edit mode, which redraws the note without the correction. A
likely suspect is an Escape key (sent to close the card), which saves and
exits edit mode; not confirmed.

Ruled out (none writes the note's text while editing): the AI privacy
preview observer, link-title prefetch, inactivity auto-save, focus/blur
handling, window blur, and the floating-window event guards.

Next step: the reporter records Chrome's console (Ctrl+Shift+J, clear,
reproduce, right-click > Save as) and sends it. MetaList's own log lines
(e.g. "Editing cancelled via Escape key", "Paste event detected") show
which event ended the edit session. Logged lines carry event names and note
lengths, not note text.

Then (BUG workflow): a failing browser test that replays the app's events
(window blur, then the keys or paste it sends, without a click in the page)
in `scripts/browser-writing-assistant-regressions.mjs`, and a fix that keeps
the correction and the edit session.

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
