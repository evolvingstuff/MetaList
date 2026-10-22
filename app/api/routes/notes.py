from __future__ import annotations

from http import HTTPStatus
import logging
import urllib.parse
from typing import Dict

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

from app.api.note_requests import (
    ViewDiffRequest,
    UpdateTabStateRequest,
    UpdateTabSortModeRequest,
    CreateNewTabRequest,
    DeleteTabRequest,
    SearchSuggestionsRequest,
    PrioritizeTagSuggestionsRequest,
    TagInteractionsRequest,
    SearchSuggestionInteractionRequest,
    TabSearchInteractionRequest,
    TagSuggestionsRequest,
    TagDetailsRequest,
    SearchTagDetailsRequest,
    DictationPasteRequest,
    CreateNoteTopRequest,
    CreateSiblingRequest,
    CreateChildRequest,
    CreateFilePreviewChildRequest,
    SaveNoteRequest,
    AddSelectedTextTagRequest,
    AcceptTagProposalRequest,
    AddTagProposalsRequest,
    OpenToTagProposalsRequest,
    RejectTagProposalRequest,
    ResolveRobotProposalsRequest,
    SplitNoteRequest,
    ToggleTodoDoneRequest,
    UnformatNoteContentRequest,
    ResizeNoteImageRequest,
    EditingImageSizesRequest,
    RunShellEndpointRequest,
    MoveNoteEndpointRequest,
    MoveNoteToBottomEndpointRequest,
    MoveNoteToTopEndpointRequest,
    IndentNoteEndpointRequest,
    OutdentNoteEndpointRequest,
    CollapseEndpointRequest,
    ExpandEndpointRequest,
    SetCollapsedBulkEndpointRequest,
    SetCollapsedInContextEndpointRequest,
    SetCollapsedSubtreeEndpointRequest,
    PrioritizeInViewEndpointRequest,
    AlphabetizeRootNotesEndpointRequest,
    ResetUpdatedAtToCreatedAtEndpointRequest,
    DeleteNoteRequest,
    CopyNoteEndpointRequest,
    PasteSiblingEndpointRequest,
    PasteChildEndpointRequest,
    PasteReferenceEndpointRequest,
)
from app.api.transactions import serialized_read_route, transactional_route
from app.services.sync import touch_client
from app.services.snapshot import build_view_state
from app.services.snapshot import resolve_search_scope
from app.services.snapshot import resolve_view_scope_membership
from app.services.note_store import store as note_store
from app.services.exception_capture import CapturedExceptionContext
from app.usecases.create_note import CmdCreateNote
from app.usecases.base import QueryCommand
from app.usecases.create_sibling import CmdCreateSibling
from app.services.file_registry import file_registry
from app.usecases.create_child import CmdCreateChild
from app.usecases.create_file_preview_child import CmdCreateFilePreviewChild
from app.usecases.update_content import CmdUpdateContent
from app.usecases.prefetch_link_titles import CmdPrefetchLinkTitles
from app.services.link_title_retry import (
    link_title_retry_snapshot,
    start_link_title_retry,
    stop_link_title_retry,
)
from app.usecases.add_selected_text_tag import CmdAddSelectedTextTag
from app.usecases.tag_proposals import (
    CmdAcceptTagProposal,
    CmdAddTagProposals,
    CmdOpenToTagProposals,
    CmdRejectTagProposal,
    CmdResolveRobotProposals,
)
from app.usecases.delete_subtree import CmdDeleteSubtree
from app.usecases.move import CmdMove
from app.usecases.move_to_top import CmdMoveToBottom, CmdMoveToTop
from app.usecases.prioritize import CmdPrioritize
from app.usecases.alphabetize_root_notes import CmdAlphabetizeRootNotes
from app.usecases.reset_updated_at import CmdResetUpdatedAtToCreatedAt
from app.usecases.indent import CmdIndent
from app.usecases.outdent import CmdOutdent
from app.usecases.collapse import CmdCollapse
from app.usecases.expand import CmdExpand
from app.usecases.set_collapse_bulk import CmdSetCollapseBulk
from app.usecases.set_collapse_in_context import (
    CmdSetCollapseInContext,
    CmdSetCollapseSubtree,
)
from app.usecases.copy_note import CmdCopyNote
from app.usecases.toggle_todo_done import CmdToggleTodoDone
from app.usecases.run_shell import CmdRunShellStart
from app.usecases.run_shell import CmdRunShellStatus
from app.usecases.paste_sibling import CmdPasteSibling
from app.usecases.paste_child import CmdPasteChild
from app.usecases.paste_reference import CmdPasteReferenceChild, CmdPasteReferenceSibling
from app.usecases.split_note import CmdSplitNote
from app.usecases.unformat_content import CmdUnformatContent
from app.usecases.resize_image import CmdResizeImage
from app.usecases.undo import CmdUndo
from app.usecases.redo import CmdRedo
from app.services.sync import get_current_sync_uuid
from app.config import MAX_SEARCH_SUGGESTIONS
from app.config import MAX_TAG_SUGGESTIONS
from app.config import VERSION
from app.services.view_cache import view_cache
from app.services.view_diff import generate_diff_ops
from app.services.tab_state import tab_state_store
from app.services.backlinks import list_backlinks_for_note
from app.services.undo_state import maybe_reset_on_context
from app.services.search_history import (
    TagActivityWindowSelection,
    current_local_date,
    is_first_search_tag_suggestion_context,
    list_search_suggestion_statistics,
    list_recent_search_tag_selections_for_first_query,
    prioritize_first_search_tag_suggestions,
    record_note_interaction,
    record_search_suggestion_selection,
    record_tab_search_selection,
    reset_search_history,
    validate_tag_activity_windows,
)
from app.services.root_sorting import is_root_reorder_locked
from app.services.root_sorting import normalize_sort_mode
from app.services.search_query import parse_search_query
from app.services.html_export import EXPORT_PURPOSES
from app.services.html_export import build_notes_export_document
from app.services.html_export import default_export_title
from app.services.html_export import exported_credential_counts
from app.services.html_export import build_notes_export_filename
from app.services.note_fullscreen import build_note_fullscreen_markup
from app.services.link_titles import link_title_store
from app.services.search_index import search_index
from app.services.dictation_cleanup import clean_dictated_paste
from app.services.tag_details import describe_search_tag
from app.services.tag_details import describe_tag_bar_tag
from app.services.tag_suggestion_reasons import search_suggestion_reasons
from app.services.tag_suggestions import suggest_tags_with_reasons_for_note
from app.services.undo_state import reset_undo_stack
from app.usecases.prioritize import list_prioritize_tag_suggestions
from app.services.selected_text_tag import SelectedTextTagValidationError
from app.api.request_auth import require_request_auth_token
from app.security.shell_execution import is_loopback_host
from app.services.input_errors import InputRejected
from app.services.editing_image_sizes import editing_image_size_factors
from app.services.memory_breakdown import measure_memory_breakdown
from app.services.memory_usage import describe_memory_usage


logger = logging.getLogger(__name__)


router = APIRouter()


class LinkTitlePrefetchRequest(BaseModel):
    content: str
    tags: str


@router.post("/notes/link-titles/prefetch")
@transactional_route
def prefetch_link_titles(request: Request, draft: LinkTitlePrefetchRequest) -> dict[str, str]:
    require_request_auth_token(request)
    return CmdPrefetchLinkTitles(content=draft.content, tags=draft.tags).execute()


@router.get("/notes/link-titles/retry")
def link_title_retry_progress(request: Request) -> dict[str, object]:
    require_request_auth_token(request)
    return link_title_retry_snapshot()


@router.post("/notes/link-titles/retry")
@transactional_route
def start_link_title_retry_route(request: Request) -> dict[str, object]:
    require_request_auth_token(request)
    return start_link_title_retry()


@router.post("/notes/link-titles/retry/stop")
@transactional_route
def stop_link_title_retry_route(request: Request) -> dict[str, object]:
    require_request_auth_token(request)
    return stop_link_title_retry()


def _required_query_param(request: Request, name: str) -> str:
    """A query parameter the route needs: a request without it is rejected, never defaulted."""
    if name not in request.query_params:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=f"{name} query parameter is required")
    return request.query_params[name]


def _optional_note_id_param(request: Request) -> str | None:
    """The note an export covers, with its children; absent means the whole view."""
    if "note_id" not in request.query_params:  # shockharness: ignore[DEF002] reason="an export without note_id covers the whole view"
        return None
    return request.query_params["note_id"]


def _require_note_present(note_id: str, *, context: str) -> None:
    if not isinstance(context, str) or not context:
        raise ValueError("context must be a non-empty string")
    if not isinstance(note_id, str) or not note_id:
        raise TypeError("note_id must be a non-empty string")

    if note_store.has_note(note_id):
        return

    raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail=f"Note not found: {note_id}")


def _require_loopback_shell_request(request: Request) -> None:
    if not isinstance(request, Request):
        raise TypeError("request must be a Request")
    if request.client is None or not is_loopback_host(host=request.client.host):
        raise HTTPException(
            status_code=HTTPStatus.FORBIDDEN,
            detail="Shell execution is restricted to loopback clients",
        )
    request_hostname = request.url.hostname
    if request_hostname is None or not is_loopback_host(host=request_hostname):
        raise HTTPException(
            status_code=HTTPStatus.FORBIDDEN,
            detail="Shell execution requires a loopback request host",
        )


def _resolve_tab_sort_mode(tab_id: object) -> str:
    if tab_id is not None and (not isinstance(tab_id, str) or tab_id == ""):
        raise TypeError("tabId must be a non-empty string")

    capture = CapturedExceptionContext(InputRejected, boundary='app/api/routes/notes.py:_resolve_tab_sort_mode:capture')
    sort_mode: str | None = None
    with capture:
        sort_mode = tab_state_store.get_sort_mode(tab_id=tab_id)
    if capture.captured_exception is not None:
        exc = capture.captured_exception
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=str(exc)) from exc
    if sort_mode is None:
        raise RuntimeError("tab_state_store.get_sort_mode returned no value")
    return sort_mode


def _block_root_reorder_when_sorted(note_id: str, *, tab_id: object, new_parent_id: object) -> None:
    sort_mode = _resolve_tab_sort_mode(tab_id)
    if not is_root_reorder_locked(sort_mode):
        return

    record = note_store.get_note(note_id)
    if record.parent_id is not None:
        return
    if new_parent_id is not None:
        return

    raise HTTPException(
        status_code=HTTPStatus.CONFLICT,
        detail=(
            "Root-note reordering is unavailable while sort order is "
            f"{normalize_sort_mode(sort_mode)!r}"
        ),
    )


def _block_root_prioritization_when_sorted(*, tab_id: object) -> None:
    sort_mode = _resolve_tab_sort_mode(tab_id)
    if not is_root_reorder_locked(sort_mode):
        return
    raise HTTPException(
        status_code=HTTPStatus.CONFLICT,
        detail=(
            "Root-note reordering is unavailable while sort order is "
            f"{normalize_sort_mode(sort_mode)!r}"
        ),
    )


@router.post("/notes/view")
@transactional_route
def view_diff(payload: ViewDiffRequest):
    # Strict: require keys, let FastAPI raise if invalid
    client_id = payload["clientId"]
    touch_client(client_id)
    editing_note_id = payload["editingNoteId"]
    search = payload["search"]
    tab_id = payload["tabId"]
    undo_context = payload["undoContext"]
    tab_view_empty = payload["tabViewEmpty"]
    visible_top_root_id = payload["visibleTopRootId"]
    visible_bottom_root_id = payload["visibleBottomRootId"]
    is_untagged_view = payload["isUntaggedView"]
    if not isinstance(is_untagged_view, bool):
        raise TypeError("isUntaggedView must be a boolean")
    # Go to Bottom: load the band that ends at the view's last root.
    start_at_list_end = payload["startAtListEnd"]
    if not isinstance(start_at_list_end, bool):
        raise TypeError("startAtListEnd must be a boolean")
    if not isinstance(tab_view_empty, bool):
        raise TypeError("tabViewEmpty must be a boolean")

    sort_mode = _resolve_tab_sort_mode(tab_id)
    normalized_search = search
    if isinstance(normalized_search, str) and normalized_search == "":
        normalized_search = None
    if normalized_search is not None:
        if not isinstance(normalized_search, str):
            raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="search must be a string or null")
        # Validated before anything changes; a search that does not parse is
        # answered as rejected input (main.py), shown as a polite warning.
        parse_search_query(normalized_search)

    maybe_reset_on_context(client_id, undo_context)

    normalized_editing_note_id = editing_note_id
    if isinstance(normalized_editing_note_id, str) and normalized_editing_note_id == "":
        normalized_editing_note_id = None

    # The client can send a stale editingNoteId (e.g. after a delete/undo or a tab clone).
    # Treat it as "not editing" so /notes/view doesn't 500.
    if normalized_editing_note_id is not None:
        if not isinstance(normalized_editing_note_id, str):
            raise TypeError("editingNoteId must be a string or null")
        if not note_store.has_note(normalized_editing_note_id):
            normalized_editing_note_id = None

    # The server keeps each tab's warm view (what that browser tab displays),
    # so the browser sends only where it is. A tab with no warm view, or one
    # whose browser shows nothing for it, gets its initial window.
    warm_view = view_cache.get(client_id=client_id, tab_id=tab_id)
    if tab_view_empty:
        warm_view = None
    client_known_note_ids: set[str] = set()
    # The tab's previous root order: a sorted tab keeps the edited note's root there.
    previous_root_ids: list[str] = []
    if warm_view is not None:
        client_known_note_ids = set(warm_view.hash_by_id)
        if None in warm_view.children_by_parent:
            previous_root_ids = warm_view.children_by_parent[None]

    state = build_view_state(
        editing_note_id=normalized_editing_note_id,
        search=normalized_search,
        sort_mode=sort_mode,
        client_known_note_ids=client_known_note_ids,
        previous_root_ids=previous_root_ids,
        visible_top_root_id=visible_top_root_id,
        visible_bottom_root_id=visible_bottom_root_id,
        is_untagged_view=is_untagged_view,
        start_at_list_end=start_at_list_end,
    )
    update_uuid = get_current_sync_uuid()
    # An empty view has no root entry.
    root_ids: list[str] = []
    if None in state.children_by_parent:
        root_ids = list(state.children_by_parent[None])
    view_cache.set(client_id=client_id, tab_id=tab_id, state=state)
    response_snapshot = {
        "notes": {},
        "locks": state.locks,
        "rootIds": root_ids,
        "updateUUID": update_uuid,
        "version": VERSION,
        "currentClientId": client_id,
        "searchQuery": search,
        "searchHighlightPhrases": state.metadata["searchHighlightPhrases"],
        "sortMode": sort_mode,
        "isUntaggedView": is_untagged_view,
        "rootCountTotal": state.metadata["rootCountTotal"],
        "searchRootCountTotal": state.metadata["searchRootCountTotal"],
        "rootSortBuckets": state.metadata["rootSortBuckets"],
        "rootWindowStart": state.metadata["rootWindowStart"],
        "rootBandMargin": state.metadata["rootBandMargin"],
        "rootSortKeyBeforeWindow": state.metadata["rootSortKeyBeforeWindow"],
        "editingNoteId": normalized_editing_note_id,
    }
    if warm_view is None:
        response_snapshot["structure"] = state.structure
        response_snapshot["notes"] = dict(state.payloads)
        return {"snapshot": response_snapshot, "updateUUID": update_uuid}

    response_snapshot["diffOps"] = generate_diff_ops(warm_view, state)
    response_snapshot["notes"] = {
        note_id: note_payload
        for note_id, note_payload in state.payloads.items()
        if note_id not in warm_view.hash_by_id or warm_view.hash_by_id[note_id] != note_payload["hash"]
    }
    response_snapshot["lockDiffs"] = _compute_lock_diff(warm_view.locks, state.locks)
    return {"snapshot": response_snapshot, "updateUUID": update_uuid}


@router.get("/notes/tab-state")
def get_tab_state() -> Dict[str, object]:
    return tab_state_store.snapshot()


@router.post("/notes/tab-state")
@transactional_route
def update_tab_state(payload: UpdateTabStateRequest) -> Dict[str, object]:
    if "activeTabId" not in payload or "tabs" not in payload or "tabOrder" not in payload:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="activeTabId, tabs, and tabOrder are required")
    active_tab_id = payload["activeTabId"]
    tabs = payload["tabs"]
    tab_order = payload["tabOrder"]
    if not isinstance(tab_order, list):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="tabOrder must be a list")
    tab_order_list = [str(entry) for entry in tab_order]
    capture = CapturedExceptionContext(InputRejected, boundary='app/api/routes/notes.py:update_tab_state:capture')
    with capture:
        response = tab_state_store.update(active_tab_id=active_tab_id, tabs=tabs, tab_order=tab_order_list)
    if capture.captured_exception is not None:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Invalid or stale tab state") from capture.captured_exception
    return response


@router.post("/notes/tab-state/sort-mode")
@transactional_route
def update_tab_sort_mode(payload: UpdateTabSortModeRequest) -> Dict[str, object]:
    if "tabId" not in payload:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="tabId is required")
    if "sortMode" not in payload:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="sortMode is required")

    tab_id = payload["tabId"]
    sort_mode = payload["sortMode"]
    client_id = payload["clientId"]
    undo_context = payload["undoContext"]

    capture = CapturedExceptionContext(InputRejected, boundary='app/api/routes/notes.py:update_tab_sort_mode:capture')
    response: Dict[str, object] | None = None
    with capture:
        response = tab_state_store.set_sort_mode(tab_id=tab_id, sort_mode=sort_mode)
    if capture.captured_exception is not None:
        exc = capture.captured_exception
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=str(exc)) from exc
    if response is None:
        raise RuntimeError("tab_state_store.set_sort_mode returned no value")
    if response["changed"] is True:
        reset_undo_stack(client_id, undo_context)
    return response


@router.post("/notes/tab-state/new-tab")
@transactional_route
def create_new_tab(payload: CreateNewTabRequest) -> Dict[str, object]:
    if "copyFromTabId" not in payload:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="copyFromTabId is required")
    copy_from_tab_id = payload["copyFromTabId"]
    capture = CapturedExceptionContext(InputRejected, boundary='app/api/routes/notes.py:create_new_tab:capture')
    with capture:
        response = tab_state_store.create_tab(copy_from_tab_id=copy_from_tab_id)
    if capture.captured_exception is not None:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Invalid or stale tab state") from capture.captured_exception
    # The browser clones the source tab's DOM into the new tab, so the new tab
    # starts from the source tab's warm view.
    view_cache.copy_tab(
        client_id=payload["clientId"], source_tab_id=copy_from_tab_id, target_tab_id=response["newTabId"],
    )
    return response


@router.post("/notes/tab-state/delete-tab")
@transactional_route
def delete_tab(payload: DeleteTabRequest) -> Dict[str, object]:
    if "tabId" not in payload:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="tabId is required")
    tab_id = payload["tabId"]
    capture = CapturedExceptionContext(InputRejected, boundary='app/api/routes/notes.py:delete_tab:capture')
    with capture:
        response = tab_state_store.delete_tab(tab_id=tab_id)
    if capture.captured_exception is not None:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Invalid or stale tab state") from capture.captured_exception
    view_cache.discard_tab(tab_id)
    return response


@router.post("/notes/search-suggestions")
@transactional_route
def search_suggestions(request: Request, payload: SearchSuggestionsRequest) -> Dict[str, object]:
    query = payload["query"]
    raw_window_days = payload["windowDays"]
    if not isinstance(query, str):
        raise TypeError("query must be a string")
    if not isinstance(raw_window_days, list):
        raise TypeError("windowDays must be a list")
    if len(raw_window_days) > MAX_SEARCH_SUGGESTIONS:
        raise ValueError(
            f"windowDays cannot contain more than {MAX_SEARCH_SUGGESTIONS} slots"
        )
    window_days = tuple(raw_window_days)
    validate_tag_activity_windows(window_days)
    all_suggestions = search_index.suggest_all_tag_completions(query=query)
    suggestions = all_suggestions[:MAX_SEARCH_SUGGESTIONS]
    personalized_selections: list[TagActivityWindowSelection] = []
    if is_first_search_tag_suggestion_context(query):
        token = _require_bearer_token(request)
        personalized_selections = list_recent_search_tag_selections_for_first_query(
            query=query,
            candidate_tags=all_suggestions,
            window_days=window_days,
            token=token,
            today=current_local_date(),
        )
        suggestions = prioritize_first_search_tag_suggestions(
            query=query,
            base_suggestions=suggestions,
            recent_tags=[selection.tag for selection in personalized_selections],
            priority_slots=len(window_days),
        )
        suggestions = suggestions[:MAX_SEARCH_SUGGESTIONS]
    personalized_suggestions = [
        {"tag": selection.tag, "windowDays": selection.window_days}
        for selection in personalized_selections
        if selection.tag in suggestions
    ]
    # Why each is suggested, shown when it is right-clicked (docs/ui/controls.md).
    facts = search_index.describe_search_suggestions(query=query, terms=suggestions)
    recent_activity = {
        selection.tag.casefold(): (selection.window_days, selection.activity_count)
        for selection in personalized_selections
        if selection.tag in suggestions
    }
    return {
        "suggestions": suggestions,
        "personalizedSuggestions": personalized_suggestions,
        "reasons": {
            tag: list(search_suggestion_reasons(facts=facts, term=tag, recent_activity=recent_activity))
            for tag in suggestions
        },
    }


@router.post("/notes/prioritize-tag-suggestions")
@transactional_route
def prioritize_tag_suggestions(payload: PrioritizeTagSuggestionsRequest) -> Dict[str, object]:
    query = payload["query"]
    search_query = payload["search_query"]

    if not isinstance(query, str):
        raise TypeError("query must be a string")
    normalized_search: str | None = search_query
    if isinstance(normalized_search, str) and normalized_search == "":
        normalized_search = None
    if normalized_search is not None and not isinstance(normalized_search, str):
        raise TypeError("search_query must be a string or null")

    suggestions = list_prioritize_tag_suggestions(
        search_query=normalized_search,
        query=query,
        limit=MAX_TAG_SUGGESTIONS,
    )
    return {"suggestions": suggestions}


@router.post("/notes/tag-interactions")
@transactional_route
def tag_interactions(request: Request, payload: TagInteractionsRequest) -> Dict[str, object]:
    token = _require_bearer_token(request)
    note_id = payload["noteId"]
    interaction_type = payload["interactionType"]
    if not isinstance(note_id, str) or note_id == "":
        raise TypeError("noteId must be a non-empty string")
    if not isinstance(interaction_type, str):
        raise TypeError("interactionType must be a string")
    _require_note_present(note_id, context="notes.tag-interactions")
    credited = record_note_interaction(
        note_id=note_id,
        interaction_type=interaction_type,
        token=token,
        interacted_on=current_local_date(),
    )
    return {"credited": credited}


@router.post("/notes/tag-interactions/search-suggestion")
@transactional_route
def search_suggestion_interaction(request: Request, payload: SearchSuggestionInteractionRequest) -> Dict[str, object]:
    token = _require_bearer_token(request)
    tag = payload["tag"]
    if not isinstance(tag, str) or tag == "":
        raise TypeError("tag must be a non-empty string")
    credited = record_search_suggestion_selection(
        tag=tag,
        token=token,
        interacted_on=current_local_date(),
    )
    return {"credited": credited}


@router.post("/notes/tag-interactions/tab-selection")
@transactional_route
def tab_search_interaction(request: Request, payload: TabSearchInteractionRequest) -> Dict[str, object]:
    token = _require_bearer_token(request)
    search_query = payload["searchQuery"]
    if not isinstance(search_query, str):
        raise TypeError("searchQuery must be a string")
    credited = record_tab_search_selection(
        search_query=search_query,
        token=token,
        interacted_on=current_local_date(),
    )
    return {"credited": credited}


@router.get("/notes/tag-interactions")
def get_tag_interactions(request: Request) -> Dict[str, object]:
    token = _require_bearer_token(request)
    return list_search_suggestion_statistics(token=token)


@router.get("/notes/memory-usage")
def get_memory_usage(request: Request) -> Dict[str, object]:
    """The Memory Usage dialog: this namespace server process's memory and the notes it holds."""
    _require_bearer_token(request)
    return describe_memory_usage()


@router.get("/notes/memory-usage/breakdown")
@serialized_read_route
def get_memory_breakdown(request: Request) -> Dict[str, object]:
    """What holds the server's memory, part by part (sizes only, never content). It takes
    seconds, so the dialog asks for it on its own; no write lands while it measures."""
    _require_bearer_token(request)
    return measure_memory_breakdown()


@router.delete("/notes/tag-interactions")
@transactional_route
def delete_tag_interactions(request: Request) -> Dict[str, object]:
    token = _require_bearer_token(request)
    deleted_count = reset_search_history(token=token)
    return {"deletedCount": deleted_count}


@router.post("/notes/dictation-paste")
@transactional_route
def dictation_paste(payload: DictationPasteRequest) -> Dict[str, object]:
    """Read-only: the cleaned-up text to insert for a paste (docs/ui/dictation-paste.md)."""
    text = clean_dictated_paste(
        text=payload["text"],
        target=payload["target"],
        existing_tag_frequencies=search_index.list_explicit_tag_frequencies(),
        current_value=payload["current_value"],
        quote_open=payload["quote_open"],
        quote_close=payload["quote_close"],
        negate_phrase=payload["negate_phrase"],
    )
    return {"text": text}


@router.post("/notes/tag-suggestions")
@transactional_route
def tag_suggestions(payload: TagSuggestionsRequest) -> Dict[str, object]:
    note_id = payload["note_id"]
    anchors = payload["anchors"]
    explicit_tags = payload["explicit_tags"]
    prefix = payload["prefix"]
    content_html = payload["content_html"]

    if not isinstance(note_id, str) or not note_id:
        raise TypeError("note_id must be a non-empty string")
    if not isinstance(anchors, list):
        raise TypeError("anchors must be a list")
    if not isinstance(explicit_tags, list):
        raise TypeError("explicit_tags must be a list")
    if not isinstance(prefix, str):
        raise TypeError("prefix must be a string")
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")

    _require_note_present(note_id, context="notes.tag-suggestions")

    suggestions = suggest_tags_with_reasons_for_note(
        note_id=note_id,
        anchors=anchors,
        explicit_tags=explicit_tags,
        prefix=prefix,
        content_html=content_html,
        limit=MAX_TAG_SUGGESTIONS,
    )
    # Why each is suggested, shown when it is right-clicked (docs/ui/tag-bar.md).
    return {
        "suggestions": [suggestion.tag for suggestion in suggestions],
        "reasons": {suggestion.tag: list(suggestion.reasons) for suggestion in suggestions},
    }


@router.post("/notes/tag-details")
@transactional_route
def tag_details(payload: TagDetailsRequest) -> Dict[str, object]:
    """About a tag in a note's tag bar, shown when it is right-clicked (docs/ui/tag-bar.md)."""
    note_id = payload["note_id"]
    _require_note_present(note_id, context="notes.tag-details")
    lines = describe_tag_bar_tag(
        note_id=note_id, tag=payload["tag"], tags_text=payload["tags_text"], content_html=payload["content_html"],
    )
    return {"lines": list(lines)}


@router.post("/notes/search-tag-details")
@transactional_route
def search_tag_details(request: Request, payload: SearchTagDetailsRequest) -> Dict[str, object]:
    """About a tag in the search box, shown when it is right-clicked (docs/ui/controls.md)."""
    window_days = tuple(payload["windowDays"])
    validate_tag_activity_windows(window_days)
    lines = describe_search_tag(
        query=payload["query"], tag=payload["tag"], start=payload["start"], end=payload["end"],
        is_excluded=payload["excluded"], window_days=window_days,
        token=_require_bearer_token(request), today=current_local_date(),
    )
    return {"lines": list(lines)}


@router.get("/notes/export-summary")
@serialized_read_route
def export_summary(request: Request) -> Dict[str, object]:
    """What an export or print of a note (with its children) or of the view holds,
    for its dialog: the title it starts with, and how many passwords and usernames it shows."""
    _require_bearer_token(request)
    search_query = _required_query_param(request, "search_query")
    tab_id = _required_query_param(request, "tab_id")
    is_untagged_view = _required_query_param(request, "is_untagged_view")
    if tab_id == "" or is_untagged_view not in {"true", "false"}:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="search_query, tab_id and is_untagged_view are required")
    note_id = _optional_note_id_param(request)
    if note_id is not None:
        _require_note_present(note_id, context="notes.export-summary")
    normalized_search = search_query
    if normalized_search == "":
        normalized_search = None
    counts = exported_credential_counts(
        search=normalized_search, sort_mode=_resolve_tab_sort_mode(tab_id),
        is_untagged_view=is_untagged_view == "true", root_note_id=note_id,
    )
    return {
        "title": default_export_title(
            search=search_query, is_untagged_view=is_untagged_view == "true", root_note_id=note_id,
        ),
        "password_count": counts.passwords,
        "username_count": counts.usernames,
    }


@router.get("/notes/export-html")
@serialized_read_route
def export_notes_html(request: Request) -> Response:
    token = _require_bearer_token(request)
    search_query = _required_query_param(request, "search_query")
    theme = _required_query_param(request, "theme")

    normalized_search = search_query
    if normalized_search == "":
        normalized_search = None
    note_id = _optional_note_id_param(request)
    if note_id is not None:
        if note_id == "":
            raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="note_id query parameter must be non-empty")
        _require_note_present(note_id, context="notes.export-html")

    normalized_theme = theme.strip().lower()
    if normalized_theme not in {"dark", "light"}:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="theme must be 'light' or 'dark'")
    # The view as the tab shows it: its sort order and kind (All or Untagged notes).
    tab_id = _required_query_param(request, "tab_id")
    if tab_id == "":
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="tab_id query parameter is required")
    is_untagged_view = _required_query_param(request, "is_untagged_view")
    if is_untagged_view not in {"true", "false"}:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="is_untagged_view query parameter must be 'true' or 'false'")

    # Both carry the user's title; a download collapses and expands, a print is always light.
    purpose = _required_query_param(request, "purpose")
    if purpose not in EXPORT_PURPOSES:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="purpose query parameter must be 'download' or 'print'")
    title = _required_query_param(request, "title")
    if purpose == "print":
        normalized_theme = "light"
    # Passwords and usernames show only when the user chose to include them in this export.
    include_credentials = _required_query_param(request, "include_credentials")
    if include_credentials not in {"true", "false"}:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="include_credentials query parameter must be 'true' or 'false'")
    # A download starts as MetaList shows it, the note being edited open ("" when none is).
    editing_note_id: str | None = _required_query_param(request, "editing_note_id")
    if editing_note_id == "":
        editing_note_id = None
    else:
        _require_note_present(editing_note_id, context="notes.export-html")

    document = build_notes_export_document(
        search=normalized_search,
        sort_mode=_resolve_tab_sort_mode(tab_id),
        is_untagged_view=is_untagged_view == "true",
        theme=normalized_theme,
        token=token,
        root_note_id=note_id,
        purpose=purpose,
        title=title,
        include_credentials=include_credentials == "true",
        editing_note_id=editing_note_id,
    )
    filename = build_notes_export_filename(title)
    quoted_filename = urllib.parse.quote(filename)
    return Response(
        content=document,
        media_type="text/html",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quoted_filename}",
            "X-MetaList-Export": "notes-html-v1",
        },
    )


@router.get("/notes/{note_id}/fullscreen")
def note_fullscreen(note_id: str) -> Dict[str, str]:
    _require_note_present(note_id, context="notes.fullscreen")
    return {"html": build_note_fullscreen_markup(note_id)}


@router.get("/notes/{note_id}/floating")
def note_floating_window(note_id: str, revision: str) -> dict[str, str]:
    current_revision = f"{get_current_sync_uuid()}:{link_title_store.get_revision()}"
    if not note_store.has_note(note_id):
        return {"revision": current_revision, "status": "deleted", "html": ""}
    if revision == current_revision:
        return {"revision": current_revision, "status": "unchanged", "html": ""}
    return {
        "revision": current_revision,
        "status": "ready",
        "html": build_note_fullscreen_markup(note_id),
    }


@router.get("/notes/{note_id}/backlinks")
@serialized_read_route
def backlinks(request: Request, note_id: str) -> Dict[str, object]:
    _require_note_present(note_id, context="notes.backlinks")

    normalized_search = None
    if "search" in request.query_params:
        raw_search = request.query_params["search"]
        if not isinstance(raw_search, str):
            raise TypeError("search query parameter must be a string")
        normalized_search = raw_search
    if normalized_search == "":
        normalized_search = None

    source_note_ids = None
    if normalized_search is not None:
        search_scope = resolve_search_scope(
            search=normalized_search,
            editing_note_id=None,
            sort_mode="normal",
            ordered_root_ids=None,
        )
        source_note_ids = search_scope.allowed_note_ids

    backlinks = list_backlinks_for_note(note_id, source_note_ids=source_note_ids)
    return {
        "targetNoteId": note_id,
        "backlinks": backlinks,
    }


@router.get("/notes/{note_id}/outside-referrers")
def outside_referrers(note_id: str) -> Dict[str, object]:
    """How many notes outside this note's subtree reference it or a note in it:
    the references deleting (or cutting) the subtree would break."""
    _require_note_present(note_id, context="notes.outside-referrers")
    return {"noteId": note_id, "count": len(note_store.get_outside_referrer_ids(note_id))}


def _compute_lock_diff(previous: Dict[str, str], current: Dict[str, str]) -> Dict[str, str]:
    diff: Dict[str, str] = {}
    for note_id, owner in current.items():
        if note_id not in previous or previous[note_id] != owner:
            diff[note_id] = owner
    for note_id in previous:
        if note_id not in current:
            diff[note_id] = ""
    return diff


@router.post("/notes/new")
@transactional_route
def create_note_top(request: Request, body: CreateNoteTopRequest):
    token = _require_bearer_token(request)
    viewport = _require_viewport(body)
    cmd = CmdCreateNote(
        first_visible_note_id=body["first_visible_note_id"],
        search_query=body["search_query"],
        token=token,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/new-sibling/{note_id}")
@transactional_route
def create_sibling(request: Request, note_id: str, body: CreateSiblingRequest):
    token = _require_bearer_token(request)
    viewport = _require_viewport(body)
    _require_note_present(note_id, context="notes.new-sibling")
    cmd = CmdCreateSibling(
        reference_note_id=note_id,
        search_query=body["search_query"],
        token=token,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/new-child/{note_id}")
@transactional_route
def create_child(request: Request, note_id: str, body: CreateChildRequest):
    token = _require_bearer_token(request)
    viewport = _require_viewport(body)
    _require_note_present(note_id, context="notes.new-child")
    cmd = CmdCreateChild(
        parent_note_id=note_id,
        search_query=body["search_query"],
        token=token,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/file-preview-child/{note_id}")
@transactional_route
def create_file_preview_child(request: Request, note_id: str, body: CreateFilePreviewChildRequest):
    token = _require_bearer_token(request)
    viewport = _require_viewport(body)
    _require_note_present(note_id, context="notes.file-preview-child")
    file_id = body["fileId"]
    if not file_registry.has_file(file_id):
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail=f"File not found: {file_id}")
    cmd = CmdCreateFilePreviewChild(
        parent_note_id=note_id,
        file_id=file_id,
        search_query=body["search_query"],
        token=token,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.put("/notes/{note_id}/save")
@transactional_route
def save_note(request: Request, note_id: str, body: SaveNoteRequest):
    client_id = body["clientId"]
    content = body["content"]
    tags = body["tags"]
    viewport = _require_viewport(body)
    token = _require_bearer_token(request)
    _require_note_present(note_id, context="notes.save")
    cmd = CmdUpdateContent(
        note_id=note_id,
        content=content,
        tags=tags,
        token=token,
        client_id=client_id,
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/{note_id}/add-selected-text-tag")
@transactional_route
def add_selected_text_tag(request: Request, note_id: str, body: AddSelectedTextTagRequest):
    selected_text = body["selectedText"]
    if not isinstance(selected_text, str):
        raise TypeError("selectedText must be a string")

    token = _require_bearer_token(request)
    viewport = _require_viewport(body)
    _require_note_present(note_id, context="notes.add-selected-text-tag")
    command = CmdAddSelectedTextTag(
        note_id=note_id,
        selected_text=selected_text,
        token=token,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    capture = CapturedExceptionContext(SelectedTextTagValidationError, boundary='app/api/routes/notes.py:add_selected_text_tag:capture')
    response = None
    with capture:
        response = command.execute()
    if capture.captured_exception is not None:
        exc = capture.captured_exception
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=str(exc)) from exc
    if response is None:
        raise RuntimeError("CmdAddSelectedTextTag returned no response")
    return response


def _execute_tag_proposal_mutation(*, command: QueryCommand) -> Dict[str, object]:
    return command.execute()


@router.post("/notes/{note_id}/tag-proposals/accept")
@transactional_route
def accept_tag_proposal(request: Request, note_id: str, body: AcceptTagProposalRequest):
    proposal = body["proposal"]
    if not isinstance(proposal, str) or proposal == "":
        raise TypeError("proposal must be a non-empty string")
    token = _require_bearer_token(request)
    viewport = _require_viewport(body)
    _require_note_present(note_id, context="notes.tag-proposals.accept")
    return _execute_tag_proposal_mutation(
        command=CmdAcceptTagProposal(
            note_id=note_id,
            proposal=proposal,
            token=token,
            client_id=body["clientId"],
            undo_context=body["undoContext"],
            viewport=viewport,
        )
    )


@router.post("/notes/{note_id}/tag-proposals/add")
@transactional_route
def add_tag_proposals(request: Request, note_id: str, body: AddTagProposalsRequest):
    token = _require_bearer_token(request)
    viewport = _require_viewport(body)
    _require_note_present(note_id, context="notes.tag-proposals.add")
    return _execute_tag_proposal_mutation(
        command=CmdAddTagProposals(
            note_id=note_id,
            proposals={target_id: tuple(tags) for target_id, tags in body["proposals"].items()},
            token=token,
            client_id=body["clientId"],
            undo_context=body["undoContext"],
            viewport=viewport,
        )
    )


def _robot_scope_note_ids(body: dict) -> frozenset[str]:
    """The notes the view showing a robot count lets it count (as /notes/view resolves them)."""
    return resolve_view_scope_membership(
        search=body["search"],
        sort_mode=_resolve_tab_sort_mode(body["tabId"]),
        is_untagged_view=body["isUntaggedView"],
    ).allowed_note_ids


@router.post("/notes/{note_id}/tag-proposals/open")
@transactional_route
def open_to_tag_proposals(note_id: str, body: OpenToTagProposalsRequest):
    viewport = _require_viewport(body)
    _require_note_present(note_id, context="notes.tag-proposals.open")
    return CmdOpenToTagProposals(
        note_id=note_id,
        scope_note_ids=_robot_scope_note_ids(body),
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    ).execute()


@router.post("/notes/{note_id}/tag-proposals/resolve-all")
@transactional_route
def resolve_robot_tag_proposals(request: Request, note_id: str, body: ResolveRobotProposalsRequest):
    token = _require_bearer_token(request)
    viewport = _require_viewport(body)
    _require_note_present(note_id, context="notes.tag-proposals.resolve-all")
    return _execute_tag_proposal_mutation(
        command=CmdResolveRobotProposals(
            note_id=note_id,
            action=body["action"],
            includes_hidden_children=body["includesHiddenChildren"],
            scope_note_ids=_robot_scope_note_ids(body),
            token=token,
            client_id=body["clientId"],
            undo_context=body["undoContext"],
            viewport=viewport,
        )
    )


@router.post("/notes/{note_id}/tag-proposals/reject")
@transactional_route
def reject_tag_proposal(request: Request, note_id: str, body: RejectTagProposalRequest):
    proposal = body["proposal"]
    if not isinstance(proposal, str) or proposal == "":
        raise TypeError("proposal must be a non-empty string")
    token = _require_bearer_token(request)
    viewport = _require_viewport(body)
    _require_note_present(note_id, context="notes.tag-proposals.reject")
    return _execute_tag_proposal_mutation(
        command=CmdRejectTagProposal(
            note_id=note_id,
            proposal=proposal,
            token=token,
            client_id=body["clientId"],
            undo_context=body["undoContext"],
            viewport=viewport,
        )
    )


@router.post("/notes/{note_id}/split")
@transactional_route
def split_note(request: Request, note_id: str, body: SplitNoteRequest):
    client_id = body["clientId"]
    segments = body["segments"]
    tags = body["tags"]
    viewport = _require_viewport(body)
    token = _require_bearer_token(request)
    _require_note_present(note_id, context="notes.split")
    cmd = CmdSplitNote(
        note_id=note_id,
        segments=segments,
        tags=tags,
        token=token,
        client_id=client_id,
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/{note_id}/toggle-todo")
@transactional_route
def toggle_todo_done(request: Request, note_id: str, body: ToggleTodoDoneRequest):
    client_id = body["clientId"]
    viewport = _require_viewport(body)
    token = _require_bearer_token(request)
    _require_note_present(note_id, context="notes.toggle-todo")
    cmd = CmdToggleTodoDone(
        note_id=note_id,
        token=token,
        client_id=client_id,
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/{note_id}/unformat")
@transactional_route
def unformat_note_content(request: Request, note_id: str, body: UnformatNoteContentRequest):
    client_id = body["clientId"]
    viewport = _require_viewport(body)
    token = _require_bearer_token(request)
    _require_note_present(note_id, context="notes.unformat")
    cmd = CmdUnformatContent(
        note_id=note_id,
        token=token,
        client_id=client_id,
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/{note_id}/resize-image")
@transactional_route
def resize_note_image(request: Request, note_id: str, body: ResizeNoteImageRequest):
    client_id = body["clientId"]
    viewport = _require_viewport(body)
    token = _require_bearer_token(request)
    _require_note_present(note_id, context="notes.resize-image")
    cmd = CmdResizeImage(
        note_id=note_id,
        source_kind=body["sourceKind"],
        occurrence_index=body["occurrenceIndex"],
        action=body["action"],
        token=token,
        client_id=client_id,
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


# The size each inline image shows at in the editor, for unsaved text and tags:
# what the view would render (a display-only zoom; nothing is saved).
@router.post("/notes/{note_id}/editing-image-sizes")
@transactional_route
def editing_image_sizes(request: Request, note_id: str, body: EditingImageSizesRequest) -> Dict[str, object]:
    _require_bearer_token(request)
    _require_note_present(note_id, context="notes.editing-image-sizes")
    return {"factors": editing_image_size_factors(content_html=body["content"], tags=body["tags"])}


@router.post("/notes/{note_id}/run-shell")
@transactional_route
def run_shell_endpoint(request: Request, note_id: str, body: RunShellEndpointRequest) -> Dict[str, object]:
    _require_loopback_shell_request(request)
    _require_note_present(note_id, context="notes.run-shell")
    timeout_seconds = body["timeoutSeconds"]
    cmd = CmdRunShellStart(
        note_id=note_id,
        timeout_seconds=timeout_seconds,
    )
    return cmd.execute()


@router.get("/notes/{note_id}/run-shell/{run_id}")
def run_shell_status_endpoint(request: Request, note_id: str, run_id: str) -> Dict[str, object]:
    _require_loopback_shell_request(request)
    cmd = CmdRunShellStatus(note_id=note_id, run_id=run_id)
    return cmd.execute()


@router.post("/notes/{note_id}/move")
@transactional_route
def move_note_endpoint(note_id: str, body: MoveNoteEndpointRequest):
    viewport = _require_viewport(body)
    _require_note_present(note_id, context="notes.move")
    if "tab_id" in body:
        tab_id = body["tab_id"]
    else:
        tab_id = None
    _block_root_reorder_when_sorted(
        note_id,
        tab_id=tab_id,
        new_parent_id=body["new_parent_id"],
    )
    _require_note_present(body["sibling_id"], context="notes.move.sibling")
    if body["new_parent_id"] is not None:
        _require_note_present(body["new_parent_id"], context="notes.move.parent")
    cmd = CmdMove(
        note_id=note_id,
        sibling_id=body["sibling_id"],
        position=body["position"],
        new_parent_id=body["new_parent_id"],
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/{note_id}/move-to-top")
@transactional_route
def move_note_to_top_endpoint(note_id: str, body: MoveNoteToTopEndpointRequest):
    return _move_note_to_edge(note_id, body, command_class=CmdMoveToTop, context="notes.move-to-top")


@router.post("/notes/{note_id}/move-to-bottom")
@transactional_route
def move_note_to_bottom_endpoint(note_id: str, body: MoveNoteToBottomEndpointRequest):
    return _move_note_to_edge(note_id, body, command_class=CmdMoveToBottom, context="notes.move-to-bottom")


def _move_note_to_edge(note_id: str, body: MoveNoteToTopEndpointRequest, *, command_class: type, context: str):
    """Move a note to the top or bottom of its siblings (of the view's roots for a root)."""
    viewport = _require_viewport(body)
    _require_note_present(note_id, context=context)

    search_query = body["search_query"]
    normalized_search: str | None = search_query
    if isinstance(normalized_search, str) and normalized_search == "":
        normalized_search = None
    if normalized_search is not None and not isinstance(normalized_search, str):
        raise TypeError("search_query must be a string or null")

    if "tab_id" in body:
        tab_id = body["tab_id"]
    else:
        tab_id = None
    _block_root_reorder_when_sorted(
        note_id,
        tab_id=tab_id,
        new_parent_id=None,
    )

    cmd = command_class(
        note_id=note_id,
        search_query=normalized_search,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/{note_id}/indent")
@transactional_route
def indent_note_endpoint(note_id: str, body: IndentNoteEndpointRequest):
    viewport = _require_viewport(body)
    _require_note_present(note_id, context="notes.indent")
    cmd = CmdIndent(
        note_id=note_id,
        visible_prev_id=body["visible_prev_id"],
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/{note_id}/outdent")
@transactional_route
def outdent_note_endpoint(request: Request, note_id: str, body: OutdentNoteEndpointRequest):
    viewport = _require_viewport(body)
    token = _require_bearer_token(request)
    _require_note_present(note_id, context="notes.outdent")
    cmd = CmdOutdent(
        note_id=note_id,
        search_query=body["search_query"],
        token=token,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/{note_id}/collapse")
@transactional_route
def collapse_endpoint(note_id: str, body: CollapseEndpointRequest):
    viewport = _require_viewport(body)
    _require_note_present(note_id, context="notes.collapse")
    cmd = CmdCollapse(note_id=note_id, client_id=body["clientId"], undo_context=body["undoContext"], viewport=viewport)
    return cmd.execute()


@router.post("/notes/{note_id}/expand")
@transactional_route
def expand_endpoint(note_id: str, body: ExpandEndpointRequest):
    viewport = _require_viewport(body)
    _require_note_present(note_id, context="notes.expand")
    cmd = CmdExpand(note_id=note_id, client_id=body["clientId"], undo_context=body["undoContext"], viewport=viewport)
    return cmd.execute()


@router.post("/notes/set-collapsed-bulk")
@transactional_route
def set_collapsed_bulk_endpoint(body: SetCollapsedBulkEndpointRequest):
    viewport = _require_viewport(body)
    note_ids = body["note_ids"]
    collapsed = body["collapsed"]

    if not isinstance(note_ids, list) or len(note_ids) == 0:
        raise TypeError("note_ids must be a non-empty list")
    if not isinstance(collapsed, bool):
        raise TypeError("collapsed must be a bool")

    for note_id in note_ids:
        if not isinstance(note_id, str) or not note_id:
            raise TypeError("note_ids must be non-empty strings")
        _require_note_present(note_id, context="notes.set_collapsed_bulk")

    cmd = CmdSetCollapseBulk(
        note_ids=note_ids,
        collapsed=collapsed,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/set-collapsed-in-context")
@transactional_route
def set_collapsed_in_context_endpoint(body: SetCollapsedInContextEndpointRequest):
    viewport = _require_viewport(body)
    search_query = body["search_query"]
    collapsed = body["collapsed"]
    recursive = body["recursive"]

    if not isinstance(collapsed, bool):
        raise TypeError("collapsed must be a bool")
    if not isinstance(recursive, bool):
        raise TypeError("recursive must be a bool")

    normalized_search: str | None = search_query
    if isinstance(normalized_search, str) and normalized_search == "":
        normalized_search = None

    if normalized_search is not None and not isinstance(normalized_search, str):
        raise TypeError("search_query must be a string or null")

    cmd = CmdSetCollapseInContext(
        search_query=normalized_search,
        collapsed=collapsed,
        recursive=recursive,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/{note_id}/set-collapsed-subtree")
@transactional_route
def set_collapsed_subtree_endpoint(note_id: str, body: SetCollapsedSubtreeEndpointRequest):
    viewport = _require_viewport(body)
    _require_note_present(note_id, context="notes.set_collapsed_subtree")
    collapsed = body["collapsed"]
    if not isinstance(collapsed, bool):
        raise TypeError("collapsed must be a bool")
    cmd = CmdSetCollapseSubtree(
        note_id=note_id,
        collapsed=collapsed,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/prioritize")
@transactional_route
def prioritize_in_view_endpoint(body: PrioritizeInViewEndpointRequest):
    viewport = _require_viewport(body)
    tag = body["tag"]
    direction = body["direction"]
    search_query = body["search_query"]
    if "tab_id" in body:
        tab_id = body["tab_id"]
    else:
        tab_id = None

    if not isinstance(tag, str):
        raise TypeError("tag must be a string")
    if not isinstance(direction, str):
        raise TypeError("direction must be a string")

    normalized_search: str | None = search_query
    if isinstance(normalized_search, str) and normalized_search == "":
        normalized_search = None
    if normalized_search is not None and not isinstance(normalized_search, str):
        raise TypeError("search_query must be a string or null")
    _block_root_prioritization_when_sorted(tab_id=tab_id)

    cmd = CmdPrioritize(
        tag=tag,
        direction=direction,
        search_query=normalized_search,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/alphabetize-root-notes")
@transactional_route
def alphabetize_root_notes_endpoint(body: AlphabetizeRootNotesEndpointRequest):
    viewport = _require_viewport(body)
    direction = body["direction"]
    search_query = body["search_query"]
    if "tab_id" in body:
        tab_id = body["tab_id"]
    else:
        tab_id = None

    if not isinstance(direction, str):
        raise TypeError("direction must be a string")

    normalized_search: str | None = search_query
    if isinstance(normalized_search, str) and normalized_search == "":
        normalized_search = None
    if normalized_search is not None and not isinstance(normalized_search, str):
        raise TypeError("search_query must be a string or null")
    _block_root_prioritization_when_sorted(tab_id=tab_id)

    cmd = CmdAlphabetizeRootNotes(
        direction=direction,
        search_query=normalized_search,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/reset-updated-at-to-created-at")
@transactional_route
def reset_updated_at_to_created_at_endpoint(body: ResetUpdatedAtToCreatedAtEndpointRequest):
    viewport = _require_viewport(body)
    search_query = body["search_query"]

    normalized_search: str | None = search_query
    if isinstance(normalized_search, str) and normalized_search == "":
        normalized_search = None
    if normalized_search is not None and not isinstance(normalized_search, str):
        raise TypeError("search_query must be a string or null")

    cmd = CmdResetUpdatedAtToCreatedAt(
        search_query=normalized_search,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.delete("/notes/{note_id}")
@transactional_route
def delete_note(note_id: str, body: DeleteNoteRequest):
    client_id = body["clientId"]
    viewport = _require_viewport(body)
    _require_note_present(note_id, context="notes.delete")
    cmd = CmdDeleteSubtree(note_id=note_id, client_id=client_id, undo_context=body["undoContext"], viewport=viewport)
    return cmd.execute()


@router.post("/notes/{note_id}/copy")
@transactional_route
def copy_note_endpoint(note_id: str, body: CopyNoteEndpointRequest):
    cmd = CmdCopyNote(note_id=note_id, client_id=body["clientId"])  
    return cmd.execute()


@router.post("/notes/paste-sibling/{target_note_id}")
@transactional_route
def paste_sibling_endpoint(request: Request, target_note_id: str, body: PasteSiblingEndpointRequest):
    viewport = _require_viewport(body)
    token = _require_bearer_token(request)
    search_query = body["search_query"]
    cmd = CmdPasteSibling(
        target_note_id=target_note_id,
        search_query=search_query,
        token=token,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/paste-child/{target_note_id}")
@transactional_route
def paste_child_endpoint(request: Request, target_note_id: str, body: PasteChildEndpointRequest):
    viewport = _require_viewport(body)
    token = _require_bearer_token(request)
    search_query = body["search_query"]
    cmd = CmdPasteChild(
        target_note_id=target_note_id,
        search_query=search_query,
        token=token,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/paste-reference-sibling/{target_note_id}")
@transactional_route
def paste_reference_sibling_endpoint(request: Request, target_note_id: str, body: PasteReferenceEndpointRequest):
    viewport = _require_viewport(body)
    token = _require_bearer_token(request)
    cmd = CmdPasteReferenceSibling(
        target_note_id=target_note_id,
        reference_note_id=body["reference_note_id"],
        search_query=body["search_query"],
        token=token,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


@router.post("/notes/paste-reference-child/{target_note_id}")
@transactional_route
def paste_reference_child_endpoint(request: Request, target_note_id: str, body: PasteReferenceEndpointRequest):
    viewport = _require_viewport(body)
    token = _require_bearer_token(request)
    cmd = CmdPasteReferenceChild(
        target_note_id=target_note_id,
        reference_note_id=body["reference_note_id"],
        search_query=body["search_query"],
        token=token,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
    return cmd.execute()


def _require_viewport(body: dict) -> dict:
    viewport = body["viewport"]
    if not isinstance(viewport, dict):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="viewport is required")
    return viewport


def _require_bearer_token(request: Request) -> str:
    return require_request_auth_token(request)


@router.post("/notes/undo")
@transactional_route
def undo_endpoint(request: Request, client_id: str, undoContext: str):
    token = _require_bearer_token(request)
    return CmdUndo(client_id=client_id, token=token, undo_context=undoContext).execute()


@router.post("/notes/redo")
@transactional_route
def redo_endpoint(request: Request, client_id: str, undoContext: str):
    token = _require_bearer_token(request)
    return CmdRedo(client_id=client_id, token=token, undo_context=undoContext).execute()
