# Find in the List

`Cmd+F` (`Ctrl+F` on Windows and Linux) finds text in the notes the list shows, like the
browser's find, but it also finds matches far below what is loaded and inside folded
notes. The browser only ever holds a band of about 150 root notes around where you are
(see the root band in `docs/AI-SUMMARY.md`), so its own find cannot see the rest.

Search filters which notes the list shows; find moves through the notes it shows,
marking each place the text occurs.

## Using it

- `Cmd+F` opens the find bar. It floats just under the search controls, at their right,
  and takes no space: nothing moves. Pressed again, it selects the bar's text.
- In a dialog, `Cmd+F` stays the browser's own find, inside that dialog.
- While a note is being edited, `Cmd+F` first saves it and leaves edit mode, the way
  `Escape` does, with the note staying at its height
  ([principle 6](interaction-principles.md)).
- Typing counts the matches after a short pause: `3 of 12`, or `3 of 50+` while more may
  lie beyond what has been read (see [Efficiency](#efficiency)). `No matches` dims the
  arrows.
- `Enter` or `Cmd+G`: the next match. `Shift+Enter` or `Shift+Cmd+G`: the previous one.
  The bar's `↑` and `↓` do the same, and both directions wrap at the list's ends.
- `Escape`, the bar's `×`, or clicking into a note to edit it closes the bar and clears
  the marks.

## What it matches

- Case-insensitive, also inside words ("fat" finds "father"), overlapping matches
  included. A space at an edge of the text limits it to a word edge on that side
  ("fat " does not find "father"), as quoted search text does
  ([search semantics](search-semantics.md)).
- What notes show: their text, including the text of expanded embedded notes, the
  names of files they show (a PDF's or other file's name on its card), and tag-bar comments. Not tag names (search finds those), not link addresses or fetched
  link titles the note does not show, and not the grey placeholder lines a search leaves
  for branches outside it.
- Only the notes of the current tab, search and sort order, in list order: each note,
  then its children, then the next root.

## Where the page goes

Every match on the loaded part of the list gets a light mark and the current match a
strong one, painted with the CSS Custom Highlight API: the marks move nothing
([principle 5](interaction-principles.md): you cannot know where the text occurs).

| Case | Result |
|---|---|
| Typing | The current match is the first at or below the top of the usable screen; with none below, the first in the list |
| The match is fully in view | Nothing scrolls (2) |
| It is below the window | The list scrolls just enough that its line's bottom sits at the window's bottom edge (3) |
| It is above, or behind the find bar | The list scrolls just enough that its line's top sits just below the bar where it is under the bar, else just below the search controls (3) |
| It is far away, not loaded yet | That part of the list is loaded and the match placed as above, by direction: next from below, previous or a wrap to the first from above |
| It is hidden in a folded note (below its first line, or in a child) | The note and the folded notes above it open for this view only; their saved collapse is unchanged (4). Opening only pushes down what is below; the match is then placed as above |
| Moving on, or closing the bar | What find opened folds back with its first line where it was (1, 4) |
| The search, tab or sort changes | Find counts again |

"Usable screen" is the screen below the search controls (and below the find bar, where
the bar covers it), above the window's bottom edge.

## Efficiency

A common word must not render the whole list. The server answers one window at a time
(`POST /api2/notes/find`, `app/services/snapshot.py` `find_in_view`):

- It reads whole roots in list order from a root position, forward, or backward from
  before it, and stops after the root in which 50 notes matched
  (`FIND_WINDOW_MATCHED_NOTES`).
- Notes whose in-memory search text lacks a word of the find text are skipped without
  rendering (`search_index.note_ids_containing_words`); a note that references or embeds
  one that has it is read too. Only the remaining notes are rendered (through the view's
  own render cache) and counted.
- The browser starts with the window after the top visible root and the one before it,
  and asks for the next window only when `Enter` (or `Shift+Enter`) goes past the
  matches read so far. The count shows `+` until the whole list has been read.

So "the" in 10,000 notes renders about 50 notes per step; a rare word is usually read
whole in one step.

## How the parts fit

- `app/services/find_text.py`: a note's rendered HTML read the way the browser's marks
  read it, and the occurrence count. It mirrors
  `search-highlight-service.js` `readVisibleText` and `search-highlight-matching.js`, so
  the server's count is the number of marks the browser paints.
- `app/services/snapshot.py` `find_in_view`: one window, with each match's content and
  comment counts, how many show while the note is folded (`previewCount`), and whether a
  folded note above hides it (`isUnderFoldedNote`).
- `findRevealNoteId` in `POST /api2/notes/view` (required, null when find opened
  nothing): the note find opened; the view shows it and the notes above it open, as it
  does for the note being edited.
- `app/static/js/modules/mode-manager/services/find-in-list-service.js`: the bar, the
  windows read so far, moving between matches, opening and folding back, scrolling and
  the marks. For a note the page shows whole, the page's count wins.
- Tests: `tests/unit/test_find_in_list.py`; browser cases at exact positions in
  `scripts/browser-find-in-list-regressions.mjs` (`BROWSER_TEST_SUITE=find-in-list`).
