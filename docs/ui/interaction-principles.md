# Interaction Principles

What MetaList does on screen after an action follows from a few principles about
attention. Rules for scrolling, editing, dragging, collapsing and layout are derived
from them, not decided case by case. When a new case comes up, reason from these.

## Principles

1. **Attention is anchored to a point; keep that point still.** Every action has a
   point of contact where the user's eyes are: where they clicked, the caret or the
   line being read, where they dropped a note. After the action, what is at that point
   stays at the same place on screen. MetaList re-renders around the user's
   attention, never under it.

2. **Only the user's action changes the screen.** Anything the user did not directly
   cause (scrolling, flashing, expanding, collapsing, extra spacing) is noise that
   costs attention. MetaList adds no motion, emphasis or state change of its own.

3. **Never lose sight of what was just acted on.** This is the only reason MetaList
   may move things itself. If keeping the point still would leave it out of sight,
   move it the minimum distance needed to bring it back, toward where the user
   expected it and no further (no extra margin beyond the normal gap between notes).
   "Out of sight" means behind the sticky search controls or past the window's edge:
   the usable screen starts below the search controls.

4. **Deliberate choices persist; work stays visible.** A state the user chose, such as
   collapsing a note, stays until they change it; looking at something does not change
   it. When the user changed something, the result stays in view so they can see it
   took.

5. **Emphasis only for what the user cannot already know.** Errors and changes made by
   something other than the user may be highlighted. The results of the user's own
   actions never are: they already know where they are.

## Derived behavior

| Action | Point of attention | Result |
|---|---|---|
| Click into a note | where they clicked | stays under the pointer, caret there (1) |
| Escape, after editing | the caret, else the line being read | stays at the same height (1); a collapsed note stays expanded when changed (4); no highlight (5) |
| Escape, after only looking | the note's first line | a collapsed note collapses again with its first line where it was (1, 4) |
| Drag a note and drop it | the drop line | the note's edge next to the line stays on it: its top when moved up, its bottom when moved down; nothing scrolls (1, 2) |
| …that edge would sit behind the search controls | the drop line | scroll just enough to show it right below them (3) |
| Keyboard move up or down | the moved note | follow only if it would leave sight, by the minimum (3) |
| Up or down arrow (Go to Top / Bottom) | the end they asked for | that end of the list comes into view: the top at the top, the last note's bottom at the bottom of the window; editing ends first, saved (2, 3) |
| Move to Top | the moved note | the view follows it to its new place at the top (3) |
| Move to Bottom | the place the note left | nothing scrolls: the notes above stay put and the ones below close the gap (1, 2); in a short list the note is seen landing at the end. Sending a note to the bottom is a choice to stop looking at it, so (3) does not pull the view after it. Moving the note being edited saves it and leaves edit mode |

## Applying them

Any change to scrolling, editing, dragging, collapsing or layout names the principle it
follows, lists every case it touches with the expected result (agreed before the code
changes), and has a test per case that checks exact positions. Tests for cases that work
today are written and run against the unchanged code first, so a regression fails a test
before anyone sees it. Browser checks: `scripts/browser-scroll-regressions.mjs`
(`BROWSER_TEST_SUITE=exit-edit-scroll npm run test:browser`).
