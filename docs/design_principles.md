## Design Principles

### Server responsibilities
* HTML understanding (for search)
  * Knows how to extract text out of arbitrary HTML in support of text search capabilities.
* UI understanding (none)
  * Should know next to nothing about the UI.
  * Should be able to service multiple types of clients without any changes.

### Client responsibilities
* HTML understanding (for rendering)
  * Knows how to apply various rules to parse and transform data. Examples:
    * markdown
    * csv
    * json
    * LaTeX
    * etc..
  * Knows how to apply special tags to add css styles, such as:
    * bold
    * h1
    * italic
    * etc..
  * Knows how to rewrite data so that plain urls become clickable links
  * Knows how to rewrite `<a>` tags so that they open in a new tab (`target="_blank"`)
* UI understanding
  * Knows how to handle selecting items/subitems, and even sets of those
* PubSub
  * Messages are used for web components to communicate, 
* Pagination
  * Chooses how large of a window to request from server, 
as well as when that window needs to change
but not inside of an individual component.

### Assumptions
* tags are case-insensitive

### Vocabulary
* `parents`, `children`, `siblings`
* `next`/`prev` vs `above`/`below`?
----