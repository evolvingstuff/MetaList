"""Required HTTP request contracts; null remains explicit where the protocol allows it."""

from app.utils.byte_sizes import KIB, MIB
from typing import Annotated, Literal
from app.services.resource_limits import SHELL_SECONDS
from app.services.search_history_storage import MAX_TAG_ACTIVITY_RETENTION_DAYS
from typing_extensions import TypedDict
from pydantic import AfterValidator, ConfigDict, Field, with_config

MAX_IDENTIFIER_LENGTH = 256
MAX_TAG_ACTIVITY_WINDOWS = 20
# The AI proposes at most this many tags for one note.
MAX_PROPOSED_TAGS_PER_NOTE = 12
MAX_TAG_PROPOSAL_NOTES = 20_000

Identifier = Annotated[str, Field(min_length=1, max_length=MAX_IDENTIFIER_LENGTH)]
Text = Annotated[str, Field(max_length=MIB)]
# The longest note content (HTML) one request may carry, in characters: 16 Mi (2**24),
# so a single request cannot make the server hold an unbounded note.
MAX_NOTE_CONTENT_CHARS = 16_777_216
Content = Annotated[str, Field(max_length=MAX_NOTE_CONTENT_CHARS)]
# Clients build undo contexts as "tab:<id>|search:<executed query>|epoch:<n>", so the
# limit must admit any Text-sized search query (for example an "Open all references"
# query ORing every cited note ID) plus that small fixed envelope.
UndoContext = Annotated[str, Field(min_length=1, max_length=MIB + KIB)]
Nonnegative = Annotated[int, Field(ge=0)]


def _unique_windows(value):
    if len(value) != len(set(value)):
        raise ValueError('Search windows must be unique')
    return value


WindowDays = Annotated[
    list[Annotated[int, Field(ge=1, le=MAX_TAG_ACTIVITY_RETENTION_DAYS)]],
    Field(max_length=MAX_TAG_ACTIVITY_WINDOWS),
    AfterValidator(_unique_windows),
]

@with_config(ConfigDict(strict=True))
class SortKey(TypedDict):
    domIndex: Nonnegative

@with_config(ConfigDict(strict=True))
class ScrollAnchor(TypedDict):
    anchorId: Identifier
    anchorBias: Literal['center', 'top']
    intraOffset: Nonnegative
    beltPrev: list[Identifier]
    beltNext: list[Identifier]
    anchorSortKey: SortKey

@with_config(ConfigDict(strict=True))
class Viewport(TypedDict):
    scrollY: Nonnegative
    scrollAnchor: ScrollAnchor | None

@with_config(ConfigDict(strict=True))
class Tab(TypedDict):
    searchQuery: Text
    scrollY: Nonnegative
    anchorRootId: Text | None
    scrollAnchor: ScrollAnchor | None
    sortMode: Literal['normal', 'created', 'updated', 'alphabetical', 'content-volume']

@with_config(ConfigDict(strict=True))
class ViewDiffRequest(TypedDict):
    clientId: Identifier
    editingNoteId: Text | None
    search: Text | None
    tabId: Identifier
    undoContext: UndoContext
    tabViewEmpty: bool
    visibleTopRootId: Text | None
    visibleBottomRootId: Text | None
    isUntaggedView: bool
    startAtListEnd: bool

@with_config(ConfigDict(strict=True))
class UpdateTabStateRequest(TypedDict):
    activeTabId: Identifier
    tabs: dict[Identifier, Tab]
    tabOrder: list[Identifier]

@with_config(ConfigDict(strict=True))
class UpdateTabSortModeRequest(TypedDict):
    tabId: Identifier
    sortMode: Literal['normal', 'created', 'updated', 'alphabetical', 'content-volume']
    clientId: Identifier
    undoContext: UndoContext

@with_config(ConfigDict(strict=True))
class CreateNewTabRequest(TypedDict):
    copyFromTabId: Identifier
    clientId: Identifier

@with_config(ConfigDict(strict=True))
class DeleteTabRequest(TypedDict):
    tabId: Identifier

@with_config(ConfigDict(strict=True))
class SearchSuggestionsRequest(TypedDict):
    query: Text
    windowDays: WindowDays

@with_config(ConfigDict(strict=True))
class PrioritizeTagSuggestionsRequest(TypedDict):
    query: Text
    search_query: Text | None

@with_config(ConfigDict(strict=True))
class TagInteractionsRequest(TypedDict):
    noteId: Identifier
    interactionType: Literal['edit', 'expand', 'command', 'fullscreen', 'move', 'indent', 'outdent']

@with_config(ConfigDict(strict=True))
class SearchSuggestionInteractionRequest(TypedDict):
    tag: Identifier

@with_config(ConfigDict(strict=True))
class TabSearchInteractionRequest(TypedDict):
    searchQuery: Text

@with_config(ConfigDict(strict=True))
class DictationPasteRequest(TypedDict):
    """Text pasted into the search bar or the tag bar, and the field's current value."""
    text: Text
    target: Literal["search", "tags", "tag", "condition"]
    current_value: Text
    # The spoken phrases around a quoted phrase (Dictation Settings).
    quote_open: Identifier
    quote_close: Identifier
    # Spoken before a search term to exclude it (Dictation Settings).
    negate_phrase: Identifier

@with_config(ConfigDict(strict=True))
class TagSuggestionsRequest(TypedDict):
    note_id: Identifier
    anchors: list[Identifier]
    explicit_tags: list[Identifier]
    prefix: Text
    content_html: Content

@with_config(ConfigDict(strict=True))
class TagDetailsRequest(TypedDict):
    note_id: Identifier
    tag: Identifier
    tags_text: Text
    content_html: Content

@with_config(ConfigDict(strict=True))
class SearchTagDetailsRequest(TypedDict):
    query: Text
    tag: Identifier
    start: Nonnegative
    end: Nonnegative
    excluded: bool
    windowDays: WindowDays

@with_config(ConfigDict(strict=True))
class CreateNoteTopRequest(TypedDict):
    first_visible_note_id: Text | None
    search_query: Text | None
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class CreateSiblingRequest(TypedDict):
    search_query: Text | None
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class CreateChildRequest(TypedDict):
    search_query: Text | None
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class CreateFilePreviewChildRequest(TypedDict):
    fileId: Identifier
    search_query: Text | None
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class SaveNoteRequest(TypedDict):
    clientId: Identifier
    content: Content
    tags: Text
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class AddSelectedTextTagRequest(TypedDict):
    selectedText: Identifier
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class AcceptTagProposalRequest(TypedDict):
    proposal: Identifier
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class AddTagProposalsRequest(TypedDict):
    # note id -> the AI's tags for it: the edited note and maybe notes below it.
    proposals: Annotated[dict[Identifier, Annotated[list[Identifier], Field(min_length=1, max_length=MAX_PROPOSED_TAGS_PER_NOTE)]],
                         Field(min_length=1, max_length=MAX_TAG_PROPOSAL_NOTES)]
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

# The view a robot count (🤖 N) was shown in: its tab, search ('' for none) and kind.
@with_config(ConfigDict(strict=True))
class OpenToTagProposalsRequest(TypedDict):
    search: Text
    tabId: Identifier
    isUntaggedView: bool
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class ResolveRobotProposalsRequest(TypedDict):
    action: Literal["accept", "reject"]
    includesHiddenChildren: bool
    search: Text
    tabId: Identifier
    isUntaggedView: bool
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class RejectTagProposalRequest(TypedDict):
    proposal: Identifier
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class SplitNoteRequest(TypedDict):
    clientId: Identifier
    segments: Annotated[list[Content], Field(min_length=1)]
    tags: Text
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class ToggleTodoDoneRequest(TypedDict):
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class UnformatNoteContentRequest(TypedDict):
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class ResizeNoteImageRequest(TypedDict):
    clientId: Identifier
    sourceKind: Literal['inline', 'file']
    occurrenceIndex: Nonnegative
    action: Literal['bigger', 'smaller', 'reset']
    undoContext: UndoContext
    viewport: Viewport

# The edited note's text and tags as the editor has them, unsaved; image sources
# may be left out (only the structure decides sizes).
@with_config(ConfigDict(strict=True))
class EditingImageSizesRequest(TypedDict):
    content: Content
    tags: Text

@with_config(ConfigDict(strict=True))
class FinishFileEditSessionRequest(TypedDict):
    clientId: Identifier
    hostNoteId: Identifier
    contentRevision: Annotated[int, Field(ge=1)]
    isNewDiagram: bool
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class DiscardFileEditSessionRequest(TypedDict):
    contentRevision: Annotated[int, Field(ge=1)]

@with_config(ConfigDict(strict=True))
class RunShellEndpointRequest(TypedDict):
    timeoutSeconds: Annotated[int, Field(ge=0, le=SHELL_SECONDS)]

@with_config(ConfigDict(strict=True))
class MoveNoteEndpointRequest(TypedDict):
    tab_id: Identifier
    new_parent_id: Text | None
    sibling_id: Identifier
    position: Literal['BEFORE', 'AFTER']
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class MoveNoteToTopEndpointRequest(TypedDict):
    search_query: Text | None
    tab_id: Identifier
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class MoveNoteToBottomEndpointRequest(TypedDict):
    search_query: Text | None
    tab_id: Identifier
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class IndentNoteEndpointRequest(TypedDict):
    visible_prev_id: Text | None
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class OutdentNoteEndpointRequest(TypedDict):
    search_query: Text | None
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class CollapseEndpointRequest(TypedDict):
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class ExpandEndpointRequest(TypedDict):
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class SetCollapsedBulkEndpointRequest(TypedDict):
    note_ids: Annotated[list[Identifier], Field(min_length=1)]
    collapsed: bool
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class SetCollapsedInContextEndpointRequest(TypedDict):
    search_query: Text | None
    collapsed: bool
    recursive: bool
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class SetCollapsedSubtreeEndpointRequest(TypedDict):
    collapsed: bool
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class PrioritizeInViewEndpointRequest(TypedDict):
    tag: Identifier
    direction: Literal['front', 'back']
    search_query: Text | None
    tab_id: Identifier
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class AlphabetizeRootNotesEndpointRequest(TypedDict):
    direction: Literal['asc', 'desc']
    search_query: Text | None
    tab_id: Identifier
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class ResetUpdatedAtToCreatedAtEndpointRequest(TypedDict):
    search_query: Text | None
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class DeleteNoteRequest(TypedDict):
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class CopyNoteEndpointRequest(TypedDict):
    clientId: Identifier

@with_config(ConfigDict(strict=True))
class PasteSiblingEndpointRequest(TypedDict):
    search_query: Text | None
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class PasteChildEndpointRequest(TypedDict):
    search_query: Text | None
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class PasteReferenceEndpointRequest(TypedDict):
    reference_note_id: Identifier
    search_query: Text | None
    clientId: Identifier
    undoContext: UndoContext
    viewport: Viewport

