from __future__ import annotations

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
    CreateNoteTopRequest,
    CreateSiblingRequest,
    CreateChildRequest,
    UpdateNoteRequest,
    SaveNoteRequest,
    AddSelectedTextTagRequest,
    MakePseudoTagProposalsRequest,
    AcceptTagProposalRequest,
    RejectTagProposalRequest,
    SplitNoteRequest,
    ToggleTodoDoneRequest,
    UnformatNoteContentRequest,
    ResizeNoteImageRequest,
    RunShellEndpointRequest,
    ToggleReferenceModeEndpointRequest,
    MoveNoteEndpointRequest,
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
)
from app.api.transactions import transactional_route
from app.services.sync import touch_client
from app.services.snapshot import build_view_state
from app.services.snapshot import resolve_search_scope
from app.services.note_store import store as note_store
from app.services.exception_capture import CapturedExceptionContext
from app.usecases.create_note import CmdCreateNote
from app.usecases.base import QueryCommand
from app.usecases.create_sibling import CmdCreateSibling
from app.usecases.create_child import CmdCreateChild
from app.usecases.update_content import CmdUpdateContent
from app.usecases.prefetch_link_titles import CmdPrefetchLinkTitles
from app.usecases.add_selected_text_tag import CmdAddSelectedTextTag
from app.usecases.tag_proposals import (
    CmdAcceptTagProposal,
    CmdMakePseudoTagProposals,
    CmdRejectTagProposal,
)
from app.usecases.delete_subtree import CmdDeleteSubtree
from app.usecases.move import CmdMove
from app.usecases.move_to_top import CmdMoveToTop
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
from app.usecases.split_note import CmdSplitNote
from app.usecases.toggle_reference_mode import CmdToggleReferenceMode
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
from app.services.html_export import build_notes_export_document
from app.services.html_export import build_notes_export_filename
from app.services.note_fullscreen import build_note_fullscreen_markup
from app.services.search_index import search_index
from app.services.tag_suggestions import suggest_tags_for_note
from app.services.undo_state import reset_undo_stack
from app.usecases.prioritize import list_prioritize_tag_suggestions
from app.services.selected_text_tag import SelectedTextTagValidationError
from app.api.request_auth import require_request_auth_token
from app.security.shell_execution import is_loopback_host


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


def _require_note_present(note_id: str, *, context: str) -> None:
    if not isinstance(context, str) or not context:
        raise ValueError("context must be a non-empty string")
    if not isinstance(note_id, str) or not note_id:
        raise TypeError("note_id must be a non-empty string")

    if note_store.has_note(note_id):
        return

    raise HTTPException(status_code=404, detail=f"Note not found: {note_id}")


def _require_loopback_shell_request(request: Request) -> None:
    if not isinstance(request, Request):
        raise TypeError("request must be a Request")
    if request.client is None or not is_loopback_host(host=request.client.host):
        raise HTTPException(
            status_code=403,
            detail="Shell execution is restricted to loopback clients",
        )
    request_hostname = request.url.hostname
    if request_hostname is None or not is_loopback_host(host=request_hostname):
        raise HTTPException(
            status_code=403,
            detail="Shell execution requires a loopback request host",
        )


def _resolve_tab_sort_mode(tab_id: object) -> str:
    if tab_id is not None and (not isinstance(tab_id, str) or tab_id == ""):
        raise TypeError("tabId must be a non-empty string")

    capture = CapturedExceptionContext(ValueError)
    sort_mode: str | None = None
    with capture:
        sort_mode = tab_state_store.get_sort_mode(tab_id=tab_id)
    if capture.captured_exception is not None:
        exc = capture.captured_exception
        raise HTTPException(status_code=400, detail=str(exc)) from exc
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
        status_code=409,
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
        status_code=409,
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
    client_note_uuid_hashes = payload["clientNoteUuidHashes"]
    anchor_root_id = payload["visibleRootAnchorId"]
    is_untagged_view = payload["isUntaggedView"]
    if not isinstance(is_untagged_view, bool):
        raise TypeError("isUntaggedView must be a boolean")

    sort_mode = _resolve_tab_sort_mode(tab_id)
    if not isinstance(client_note_uuid_hashes, dict):
        raise TypeError("clientNoteUuidHashes must be an object")

    normalized_search = search
    if isinstance(normalized_search, str) and normalized_search == "":
        normalized_search = None
    if normalized_search is not None:
        if not isinstance(normalized_search, str):
            raise HTTPException(status_code=400, detail="search must be a string or null")
        capture = CapturedExceptionContext(ValueError)
        with capture:
            parse_search_query(normalized_search)
        if capture.captured_exception is not None:
            exc = capture.captured_exception
            raise HTTPException(status_code=400, detail=str(exc)) from exc

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

    # Known hashes plus a viewport anchor so the server can extend the window
    client_hashes = {
        k: v for k, v in client_note_uuid_hashes.items() if k
    }
    # Fallback: if client didn't provide an anchor, use the last known root from cached state
    cache_key = {
        "client_id": client_id,
        "tab_id": tab_id,
        "search": normalized_search,
        "sort_mode": sort_mode,
        "is_untagged_view": is_untagged_view,
    }
    cached_state = view_cache.get(**cache_key)
    if not anchor_root_id and cached_state and client_hashes:
        last_roots = list(cached_state.children_by_parent.get(None, []))
        if last_roots:
            anchor_root_id = last_roots[-1]

    state = build_view_state(
        editing_note_id=normalized_editing_note_id,
        search=normalized_search,
        sort_mode=sort_mode,
        client_known_note_ids=set(client_hashes.keys()),
        client_seen_root_ids=set(),
        anchor_root_id=anchor_root_id,
        is_untagged_view=is_untagged_view,
    )
    update_uuid = get_current_sync_uuid()
    root_ids = list(state.children_by_parent.get(None, []))
    root_count_total = state.metadata["rootCountTotal"]
    search_root_count_total = state.metadata["searchRootCountTotal"]

    client_note_ids = set(client_hashes.keys())
    current_note_ids = set(state.hash_by_id.keys())
    if cached_state is None:
        cached_note_ids = set()
    else:
        cached_note_ids = set(cached_state.hash_by_id.keys())
    extra_client_ids = _unknown_client_note_ids(
        client_note_ids=client_note_ids,
        current_note_ids=current_note_ids,
        cached_note_ids=cached_note_ids,
    )
    force_full_snapshot = bool(extra_client_ids)
    if force_full_snapshot:
        logger.info(
            "notes.view forcing full snapshot (client has unknown ids): extra_count=%s",
            len(extra_client_ids),
        )

    client_has_state = bool(client_hashes)

    if not cached_state or force_full_snapshot:
        view_cache.set(state=state, **cache_key)
        if force_full_snapshot:
            filtered_notes = dict(state.payloads)
        else:
            filtered_notes = {
                note_id: data
                for note_id, data in state.payloads.items()
                if client_hashes.get(note_id) != data.get("hash")
            }

        # Optimization: when the server cache is cold but the client already has a
        # complete, matching hash map for the visible window, avoid resending the
        # full structure + note payloads. This is common when a new tab is created
        # by cloning the existing DOM.
        if client_has_state and not filtered_notes and not force_full_snapshot:
            response_snapshot = {
                "diffOps": [],
                "notes": {},
                "locks": state.locks,
                "rootIds": root_ids,
                "lockDiffs": {},
                "updateUUID": update_uuid,
                "version": VERSION,
                "currentClientId": client_id,
                "searchQuery": search,
                "sortMode": sort_mode,
                "isUntaggedView": is_untagged_view,
                "rootCountTotal": root_count_total,
                "searchRootCountTotal": search_root_count_total,
                "rootSortBuckets": state.metadata["rootSortBuckets"],
                "editingNoteId": normalized_editing_note_id,
            }
            return {"snapshot": response_snapshot, "updateUUID": update_uuid}

        response_snapshot = {
            "structure": state.structure,
            "notes": filtered_notes,
            "locks": state.locks,
            "rootIds": root_ids,
            "updateUUID": update_uuid,
            "version": VERSION,
            "currentClientId": client_id,
            "searchQuery": search,
            "sortMode": sort_mode,
            "isUntaggedView": is_untagged_view,
            "rootCountTotal": root_count_total,
            "searchRootCountTotal": search_root_count_total,
            "rootSortBuckets": state.metadata["rootSortBuckets"],
            "editingNoteId": normalized_editing_note_id,
        }
        return {"snapshot": response_snapshot, "updateUUID": update_uuid}

    if not client_has_state:
        view_cache.set(state=state, **cache_key)
        filtered_notes = {
            note_id: data
            for note_id, data in state.payloads.items()
            if client_hashes.get(note_id) != data.get("hash")
        }
        response_snapshot = {
            "structure": state.structure,
            "notes": filtered_notes,
            "locks": state.locks,
            "rootIds": root_ids,
            "updateUUID": update_uuid,
            "version": VERSION,
            "currentClientId": client_id,
            "searchQuery": search,
            "sortMode": sort_mode,
            "isUntaggedView": is_untagged_view,
            "rootCountTotal": root_count_total,
            "searchRootCountTotal": search_root_count_total,
            "rootSortBuckets": state.metadata["rootSortBuckets"],
            "editingNoteId": normalized_editing_note_id,
        }
        return {"snapshot": response_snapshot, "updateUUID": update_uuid}

    diff_ops = generate_diff_ops(cached_state, state)
    note_updates = {
        note_id: payload
        for note_id, payload in state.payloads.items()
        if cached_state.hash_by_id.get(note_id) != payload["hash"]
    }

    view_cache.set(state=state, **cache_key)

    lock_diff = _compute_lock_diff(cached_state.locks, state.locks)

    response_snapshot = {
        "diffOps": diff_ops,
        "notes": note_updates,
        "locks": state.locks,
        "rootIds": root_ids,
        "lockDiffs": lock_diff,
        "updateUUID": update_uuid,
        "version": VERSION,
        "currentClientId": client_id,
        "searchQuery": search,
        "sortMode": sort_mode,
        "isUntaggedView": is_untagged_view,
        "rootCountTotal": root_count_total,
        "searchRootCountTotal": search_root_count_total,
        "rootSortBuckets": state.metadata["rootSortBuckets"],
        "editingNoteId": normalized_editing_note_id,
    }
    return {"snapshot": response_snapshot, "updateUUID": update_uuid}


@router.get("/notes/tab-state")
def get_tab_state() -> Dict[str, object]:
    return tab_state_store.snapshot()


@router.post("/notes/tab-state")
@transactional_route
def update_tab_state(payload: UpdateTabStateRequest) -> Dict[str, object]:
    if "activeTabId" not in payload or "tabs" not in payload or "tabOrder" not in payload:
        raise HTTPException(status_code=400, detail="activeTabId, tabs, and tabOrder are required")
    active_tab_id = payload["activeTabId"]
    tabs = payload["tabs"]
    tab_order = payload["tabOrder"]
    if not isinstance(tab_order, list):
        raise HTTPException(status_code=400, detail="tabOrder must be a list")
    tab_order_list = [str(entry) for entry in tab_order]
    capture = CapturedExceptionContext(ValueError)
    with capture:
        response = tab_state_store.update(active_tab_id=active_tab_id, tabs=tabs, tab_order=tab_order_list)
    if capture.captured_exception is not None:
        raise HTTPException(status_code=400, detail="Invalid or stale tab state") from capture.captured_exception
    return response


@router.post("/notes/tab-state/sort-mode")
@transactional_route
def update_tab_sort_mode(payload: UpdateTabSortModeRequest) -> Dict[str, object]:
    if "tabId" not in payload:
        raise HTTPException(status_code=400, detail="tabId is required")
    if "sortMode" not in payload:
        raise HTTPException(status_code=400, detail="sortMode is required")

    tab_id = payload["tabId"]
    sort_mode = payload["sortMode"]
    client_id = payload["clientId"]
    undo_context = payload["undoContext"]

    capture = CapturedExceptionContext(TypeError, ValueError)
    response: Dict[str, object] | None = None
    with capture:
        response = tab_state_store.set_sort_mode(tab_id=tab_id, sort_mode=sort_mode)
    if capture.captured_exception is not None:
        exc = capture.captured_exception
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if response is None:
        raise RuntimeError("tab_state_store.set_sort_mode returned no value")
    if response["changed"] is True:
        reset_undo_stack(client_id, undo_context)
    return response


@router.post("/notes/tab-state/new-tab")
@transactional_route
def create_new_tab(payload: CreateNewTabRequest) -> Dict[str, object]:
    if "copyFromTabId" not in payload:
        raise HTTPException(status_code=400, detail="copyFromTabId is required")
    copy_from_tab_id = payload["copyFromTabId"]
    capture = CapturedExceptionContext(ValueError)
    with capture:
        response = tab_state_store.create_tab(copy_from_tab_id=copy_from_tab_id)
    if capture.captured_exception is not None:
        raise HTTPException(status_code=400, detail="Invalid or stale tab state") from capture.captured_exception
    return response


@router.post("/notes/tab-state/delete-tab")
@transactional_route
def delete_tab(payload: DeleteTabRequest) -> Dict[str, object]:
    if "tabId" not in payload:
        raise HTTPException(status_code=400, detail="tabId is required")
    tab_id = payload["tabId"]
    capture = CapturedExceptionContext(ValueError)
    with capture:
        response = tab_state_store.delete_tab(tab_id=tab_id)
    if capture.captured_exception is not None:
        raise HTTPException(status_code=400, detail="Invalid or stale tab state") from capture.captured_exception
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
    return {
        "suggestions": suggestions,
        "personalizedSuggestions": personalized_suggestions,
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


@router.delete("/notes/tag-interactions")
@transactional_route
def delete_tag_interactions(request: Request) -> Dict[str, object]:
    token = _require_bearer_token(request)
    deleted_count = reset_search_history(token=token)
    return {"deletedCount": deleted_count}


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

    suggestions = suggest_tags_for_note(
        note_id=note_id,
        anchors=anchors,
        explicit_tags=explicit_tags,
        prefix=prefix,
        content_html=content_html,
        limit=MAX_TAG_SUGGESTIONS,
    )
    return {"suggestions": suggestions}


@router.get("/notes/export-html")
def export_notes_html(request: Request) -> Response:
    token = _require_bearer_token(request)
    search_query = request.query_params.get("search_query")
    if search_query is None:
        raise HTTPException(status_code=400, detail="search_query query parameter is required")
    theme = request.query_params.get("theme")
    if theme is None:
        raise HTTPException(status_code=400, detail="theme query parameter is required")

    if not isinstance(search_query, str):
        raise TypeError("search_query query parameter must be a string")
    if not isinstance(theme, str):
        raise TypeError("theme query parameter must be a string")

    normalized_search = search_query
    if normalized_search == "":
        normalized_search = None
    note_id = request.query_params.get("note_id")
    if note_id is not None:
        if not isinstance(note_id, str) or note_id == "":
            raise HTTPException(status_code=400, detail="note_id query parameter must be non-empty")
        _require_note_present(note_id, context="notes.export-html")

    normalized_theme = theme.strip().lower()
    if normalized_theme not in {"dark", "light"}:
        raise HTTPException(status_code=400, detail="theme must be 'light' or 'dark'")

    document = build_notes_export_document(
        search=normalized_search,
        theme=normalized_theme,
        token=token,
        root_note_id=note_id,
    )
    filename = build_notes_export_filename()
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


@router.get("/notes/{note_id}/backlinks")
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


def _compute_lock_diff(previous: Dict[str, str], current: Dict[str, str]) -> Dict[str, str]:
    diff: Dict[str, str] = {}
    for note_id, owner in current.items():
        if previous.get(note_id) != owner:
            diff[note_id] = owner
    for note_id in previous:
        if note_id not in current:
            diff[note_id] = ""
    return diff


def _unknown_client_note_ids(
    *,
    client_note_ids: set[str],
    current_note_ids: set[str],
    cached_note_ids: set[str],
) -> set[str]:
    stale_deleted_ids = client_note_ids - current_note_ids
    return stale_deleted_ids - cached_note_ids


# Stub endpoints for the rest of the notes API (501 Not Implemented)

def _not_impl(exc: Exception) -> None:
    # Turn NotImplementedError into HTTP 501; re-raise anything else
    if isinstance(exc, NotImplementedError):
        raise HTTPException(status_code=501, detail=str(exc))
    raise exc


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


@router.put("/notes/{note_id}")
@transactional_route
def update_note(request: Request, note_id: str, body: UpdateNoteRequest):
    # Required fields; let KeyError surface for missing keys
    client_id = body["clientId"]
    content = body["content"]
    tags = body["tags"]
    viewport = _require_viewport(body)
    token = _require_bearer_token(request)
    _require_note_present(note_id, context="notes.update")
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
    capture = CapturedExceptionContext(SelectedTextTagValidationError)
    response = None
    with capture:
        response = command.execute()
    if capture.captured_exception is not None:
        exc = capture.captured_exception
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if response is None:
        raise RuntimeError("CmdAddSelectedTextTag returned no response")
    return response


@router.post("/notes/{note_id}/tag-proposals/pseudo")
@transactional_route
def make_pseudo_tag_proposals(request: Request, note_id: str, body: MakePseudoTagProposalsRequest):
    token = _require_bearer_token(request)
    viewport = _require_viewport(body)
    _require_note_present(note_id, context="notes.tag-proposals.pseudo")
    return CmdMakePseudoTagProposals(
        note_id=note_id,
        token=token,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    ).execute()


def _execute_tag_proposal_mutation(*, command: QueryCommand) -> Dict[str, object]:
    capture = CapturedExceptionContext(KeyError)
    response = None
    with capture:
        response = command.execute()
    if capture.captured_exception is not None:
        exc = capture.captured_exception
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if response is None:
        raise RuntimeError("Tag proposal command returned no response")
    return response


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
    run_capture = CapturedExceptionContext(RuntimeError, TypeError, ValueError)
    result: Dict[str, object] | None = None
    with run_capture:
        cmd = CmdRunShellStatus(
            note_id=note_id,
            run_id=run_id,
        )
        result = cmd.execute()
    if run_capture.captured_exception is not None:
        exc = run_capture.captured_exception
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result is None:
        raise RuntimeError("Shell status command did not return a result")
    return result


@router.post("/notes/{note_id}/reference-mode")
@transactional_route
def toggle_reference_mode_endpoint(request: Request, note_id: str, body: ToggleReferenceModeEndpointRequest):
    viewport = _require_viewport(body)
    token = _require_bearer_token(request)
    _require_note_present(note_id, context="notes.reference-mode")
    cmd = CmdToggleReferenceMode(
        note_id=note_id,
        reference_note_id=body["reference_note_id"],
        occurrence_index=body["occurrence_index"],
        mode=body["mode"],
        token=token,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=viewport,
    )
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
    viewport = _require_viewport(body)
    _require_note_present(note_id, context="notes.move-to-top")

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

    cmd = CmdMoveToTop(
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


def _require_viewport(body: dict) -> dict:
    viewport = body["viewport"]
    if not isinstance(viewport, dict):
        raise HTTPException(status_code=400, detail="viewport is required")
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
