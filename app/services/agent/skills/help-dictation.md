# Dictation (speech to text)

Use this reference to explain MetaList accurately. It describes user capabilities,
not permission or tools for you to execute every operation. You can answer and
request one supported menu/dialog opening. You cannot submit a form, change
settings, run a shell command, or mutate notes through this help response. Do not
claim that you inspected current notes or settings: none are supplied here.
Prefer user-facing steps over implementation details. If the reference does not
answer a question, say what is unknown; do not invent syntax or controls.

Sources: docs/ui/dictation-paste.md

## What it is for

Speech-to-text tools such as Superwhisper paste sentences, not tags: saying
"neural network" can arrive as `Neural network, neural network. Neural-Dash
Network.` MetaList cleans up such text when it is **pasted** into the search bar, a
note's tag bar, or a note being edited, and turns it into the user's tags. It uses
fixed rules, no AI, and it only reacts to pasting: typed text is never changed.

## How dictated words become tags

- Sentence punctuation (`, . ? ! ; :`) is dropped.
- Spoken joiners join words: "dash" or "hyphen" gives `-`, "underscore" `_`,
  "slash" `/`. Superwhisper's `foo-Dash bar` gives `foo-bar`.
- The longest run of words matching one of the user's existing tags becomes that
  tag, ignoring capitals and treating spaces, `-`, `_`, `.` and `/` alike, spelled
  the way the user uses it most. "neural network" gives `neural-network`.
- Words also match a tag written as one word: "to do" gives `todo`, "scratch pad"
  gives `scratchpad`.
- "at" before the name of a built-in meta tag gives that meta tag: "at to do" gives
  `@todo`, "at done" `@done`, "at list bulleted" `@list-bulleted`. Otherwise "at"
  is ignored. One "at" covers a run of meta tags: "at green bold" gives
  `@green @bold` (Superwhisper drops a repeated "at" anyway), even if the user also
  has a plain tag such as `bold`.
- "quote … end quote" (the default quote phrases) or quote marks mark a phrase, in
  the search bar only; in tag fields the quote phrases are dropped.
- Filler words (a, an, and, at, the, tag, tags, comma, period, um, uh) are ignored,
  unless the word is itself one of the user's tags. A spoken word that is a tag
  always stays that tag.
- Repeats count once, and tags already in the field are not added again.

## Where to paste

- **Search bar:** words matching no tag are dropped. "or" becomes `OR`, the
  exclusion phrase ("minus" by default) excludes the next term ("neural network
  minus python" gives `neural-network -python`), and a quoted phrase becomes a text
  search. "not" is an ordinary word unless it is set as the exclusion phrase.
  With the cursor inside a quoted phrase (after `"`), a paste is not cleaned up:
  it goes in exactly as copied, on one line, with quote marks escaped.
- **Tag bar:** words matching no tag become new tags, lowercased unless they look
  like an acronym (`GPT`). Each word is its own tag unless the words together match
  one of the user's tags; a new multi-word tag has to be typed.
- **Other one-tag fields** (Edit Tag Relationships' search box, Add tag, Implied
  tag, Synonym tag, Rename tag; Prioritize Tag; Accept or reject AI-proposed tags' tag filter):
  the whole paste becomes one tag, "Machine learning" gives `machine-learning`.
- **Tag relationship conditions:** no dictation cleanup: a paste goes in exactly as
  copied, so several tags, quoted text, `/regexes/` and tags not used yet all stay.
- **AI privacy tag lists:** tags, one per line.
- **A note being edited:** say the tag phrase, **"start tags"** by default, then the
  tags. The text before the phrase goes into the note; the words after it are added
  to the note's tags with the tag-bar rules. "Here is my content. Start tags. Neural
  network, at to do." adds the content and the tags `neural-network @todo`. Saying
  only "Start tags, scratch pad." adds just the tag. Only the first phrase counts.
  Words that together match no existing tag become separate tags: "spring planning"
  gives `spring` and `planning`, never `spring-planning` (type a new multi-word tag).
  Without the phrase, a paste into a note is an ordinary paste.

It is a phrase rather than a repeated word because Superwhisper drops a word said
twice in a row.

## Undo

One undo (Cmd/Ctrl+Z) right after the paste brings back what was pasted in the
search bar or tag bar (in the tag bar without commas, which tags cannot contain).
After a paste into a note, one undo removes both the pasted text and the added tags.

## Dictation Settings

The command palette's **Dictation Settings** dialog sets four phrases, each words of
letters (2 to 64 characters): the phrase that starts tags in a note ("start tags"),
the phrases that start and end a quote ("quote", "end quote"), and the phrase that
excludes the next search term ("minus"). One unusual word such as "armadillo" also
works. The quote and exclusion phrases must differ. Save applies them.

## Tips and limits

- Plurals do not match: "transformers" is not the tag `transformer`. In search it
  is dropped; in the tag bar it becomes a new tag.
- In the tag bar, a new multi-word tag has to be typed: dictated words become
  separate tags unless together they match an existing tag.
- Saying "dash" in its ordinary sense ("100 meter dash") joins the words around it.
- `@size=…` and other values cannot be dictated; type them.
