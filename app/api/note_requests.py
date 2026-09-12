"""Required HTTP request contracts; null remains explicit where the protocol allows it."""

from typing import Annotated, Literal
from app.services.resource_limits import SHELL_SECONDS
from typing_extensions import TypedDict
from pydantic import AfterValidator, ConfigDict, Field, with_config

Identifier = Annotated[str, Field(min_length=1, max_length=256)]
Text = Annotated[str, Field(max_length=1024 * 1024)]
Content = Annotated[str, Field(max_length=16 * 1024 * 1024)]
Nonnegative = Annotated[int, Field(ge=0)]


def _unique_windows(value):
    if len(value) != len(set(value)):
        raise ValueError('Search windows must be unique')
    return value


WindowDays = Annotated[list[Annotated[int, Field(ge=1, le=365)]], Field(max_length=20), AfterValidator(_unique_windows)]

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
    undoContext: Identifier
    clientNoteUuidHashes: dict[Identifier, Text]
    visibleRootAnchorId: Text | None
    isUntaggedView: bool

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
    undoContext: Identifier

@with_config(ConfigDict(strict=True))
class CreateNewTabRequest(TypedDict):
    copyFromTabId: Identifier

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
class TagSuggestionsRequest(TypedDict):
    note_id: Identifier
    anchors: list[Identifier]
    explicit_tags: list[Identifier]
    prefix: Text
    content_html: Content

@with_config(ConfigDict(strict=True))
class CreateNoteTopRequest(TypedDict):
    first_visible_note_id: Text | None
    search_query: Text | None
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class CreateSiblingRequest(TypedDict):
    search_query: Text | None
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class CreateChildRequest(TypedDict):
    search_query: Text | None
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class UpdateNoteRequest(TypedDict):
    clientId: Identifier
    content: Content
    tags: Text
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class SaveNoteRequest(TypedDict):
    clientId: Identifier
    content: Content
    tags: Text
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class AddSelectedTextTagRequest(TypedDict):
    selectedText: Identifier
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class MakePseudoTagProposalsRequest(TypedDict):
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class AcceptTagProposalRequest(TypedDict):
    proposal: Identifier
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class RejectTagProposalRequest(TypedDict):
    proposal: Identifier
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class SplitNoteRequest(TypedDict):
    clientId: Identifier
    segments: Annotated[list[Content], Field(min_length=1)]
    tags: Text
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class ToggleTodoDoneRequest(TypedDict):
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class UnformatNoteContentRequest(TypedDict):
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class ResizeNoteImageRequest(TypedDict):
    clientId: Identifier
    sourceKind: Literal['inline', 'file']
    occurrenceIndex: Nonnegative
    action: Literal['bigger', 'smaller', 'reset']
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class RunShellEndpointRequest(TypedDict):
    timeoutSeconds: Annotated[int, Field(ge=0, le=SHELL_SECONDS)]

@with_config(ConfigDict(strict=True))
class ToggleReferenceModeEndpointRequest(TypedDict):
    reference_note_id: Identifier
    occurrence_index: Nonnegative
    mode: Literal['embed', 'link']
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class MoveNoteEndpointRequest(TypedDict):
    tab_id: Identifier
    new_parent_id: Text | None
    sibling_id: Identifier
    position: Literal['BEFORE', 'AFTER']
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class MoveNoteToTopEndpointRequest(TypedDict):
    search_query: Text | None
    tab_id: Identifier
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class IndentNoteEndpointRequest(TypedDict):
    visible_prev_id: Text | None
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class OutdentNoteEndpointRequest(TypedDict):
    search_query: Text | None
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class CollapseEndpointRequest(TypedDict):
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class ExpandEndpointRequest(TypedDict):
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class SetCollapsedBulkEndpointRequest(TypedDict):
    note_ids: Annotated[list[Identifier], Field(min_length=1)]
    collapsed: bool
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class SetCollapsedInContextEndpointRequest(TypedDict):
    search_query: Text | None
    collapsed: bool
    recursive: bool
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class SetCollapsedSubtreeEndpointRequest(TypedDict):
    collapsed: bool
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class PrioritizeInViewEndpointRequest(TypedDict):
    tag: Identifier
    direction: Literal['front', 'back']
    search_query: Text | None
    tab_id: Identifier
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class AlphabetizeRootNotesEndpointRequest(TypedDict):
    direction: Literal['asc', 'desc']
    search_query: Text | None
    tab_id: Identifier
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class ResetUpdatedAtToCreatedAtEndpointRequest(TypedDict):
    search_query: Text | None
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class DeleteNoteRequest(TypedDict):
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class CopyNoteEndpointRequest(TypedDict):
    clientId: Identifier

@with_config(ConfigDict(strict=True))
class PasteSiblingEndpointRequest(TypedDict):
    search_query: Text | None
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

@with_config(ConfigDict(strict=True))
class PasteChildEndpointRequest(TypedDict):
    search_query: Text | None
    clientId: Identifier
    undoContext: Identifier
    viewport: Viewport

