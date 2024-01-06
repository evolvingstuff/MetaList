# MetaList Cheatsheet

## Overview
- Minimalistic UI; mostly keyboard-driven interactions.
- Items are composed of subitems, nested hierarchically.

## Main Actions
- **Search**: 
  - Enter keywords in input bar at top.
  - Search Queries are a combination of tags and text, e.g.: 
`favorites movies "Tom Hanks"` is searching for all subitems that have
(or inherit) the tags `favorites` and also `movies` and also have the text 
"Tom Hanks" somewhere in the content.
  - Negative Queries work as well, e.g.:
`favorites movies -horror` requires the tag `favorites`, `movies`, but *not* `horror`.
- **Create Top-Level Item**: 
  - With nothing selected, press `Enter`.
  - Newly created items inherit tags from the search bar.
  - Newly created items go directly into content editing mode by default.
- **Selecting Items/Subitems**
  1. **Soft Selection Mode (1st click)**: Allows moving item/subitem, adding tags, and some other operations.
  2. **Content Editing Mode (2nd click)**: Allows for direct editing of subitem content.
- **Deselect**: 
  - Click outside the subitem, or press `Escape`.
- **Create Sibling (Beneath Selected)**: 
  - With item/subitem selected, press `Shift + Enter`.
- **Create Child (Underneath Selected)**: 
  - With item/subitem selected, press `Ctrl + Shift + Enter`.
- **Delete Item/Subitem**: 
  - With item/subitem selected, press `Delete`.
- **Move Items/Subitems**
  - Use arrow keys to rearrange selected item/subitem.
    - Up/Down to re-prioritize.
    - Right/Left to indent/outdent. (*only for subitems, not items*)
- **Copy/Paste Content**: 
  - With selected subitem in content editing mode, press `Ctrl + C/V`
- **Copy/Paste Items/Subitems**: 
   - With selected item/subitem in soft selection mode, press `Ctrl + C/V`
- **Copy/Paste Items/Subitems as Child**: 
  - With item/subitem in soft selection mode, press `Ctrl + Shift + C/V`.
- **Tag Editing**: 
  - Enter tags in input bar at bottom.
- **Undo/Redo**:
  - Undo: `Ctrl + Z`.
  - Redo: `Ctrl + Y`.
  - Infinite undo/redo (except when search changes, then the stack is reset).
- **Chat with LLM**
  - Click chat icon in lower right corner.
  - Will need to enter an OpenAI API key the first time.
  - Chat message history resets on closing the chat window (ephemeral; not saved).
