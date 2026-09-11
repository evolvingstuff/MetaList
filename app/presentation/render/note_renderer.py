"""
Note Renderer Module

Provides consistent rendering functions for notes in different modes.
Acts as the single source of truth for note rendering across the application.
"""

import re
import logging

from app.services.content_formatting import format_note_content_for_view
from app.services.content_formatting import has_scoped_footnotes
from app.services.content_formatting import extract_plain_text_from_note_html
from app.services.content_formatting import note_tags_include
from app.services.ai_chat_rendering import find_note_citation_ids
from app.services.ai_chat_rendering import render_ai_chat_markdown_to_html
from app.services.embedded_references import collapsed_preview_source_has_hidden_content
from app.services.embedded_references import collapsed_preview_source_has_media
from app.services.embedded_references import extract_collapsed_preview_source_html
from app.utils.text_utils import strip_html
from app.services.content_cache import get_cached_content
from app.services.content_cache import get_cached_tags
from app.services.note_store import store as note_store


def _format_note_content_standard(*, content_html: str, tags: str) -> str:
    if note_tags_include(tags, "@llm"):
        if note_tags_include(tags, "@markdown"):
            markdown_text = extract_plain_text_from_note_html(content_html)
            if markdown_text == "":
                return ""
            allowed_note_ids = find_note_citation_ids(
                markdown_text,
                notes=note_store,
            )
            rendered_content = render_ai_chat_markdown_to_html(
                markdown_text,
                notes=note_store,
                allowed_note_ids=allowed_note_ids,
            )
            return (
                '<div class="ai-chat-message-content meta-markdown" '
                'data-markdown-rendered="true">'
                f"{rendered_content}</div>"
            )
        if 'class="ai-chat-message-content meta-markdown"' not in content_html:
            raise RuntimeError("@llm note is missing completed chat HTML")
        return content_html
    return format_note_content_for_view(
        content_html=content_html,
        tags=tags,
        redact_passwords=False,
    )


def highlight_search_terms(html_content: str, search_query: str) -> str:
    """
    Highlight search terms in HTML content while preserving HTML structure.
    
    Args:
        html_content: HTML content to highlight terms in
        search_query: Search query string containing terms to highlight
        
    Returns:
        HTML content with search terms wrapped in highlight spans
    """
    if not html_content or not search_query or not search_query.strip():
        return html_content
    
    # Split search query into terms
    search_terms = [
        term.lower()
        for term in search_query.strip().split()
        if term and term != "OR"
    ]
    if not search_terms:
        return html_content
    
    # Create a regex pattern that matches any of the search terms
    # No word boundaries - match subsequences
    # Escape special regex characters in search terms
    escaped_terms = [re.escape(term) for term in search_terms]
    pattern = r'(' + '|'.join(escaped_terms) + r')'
    
    # Function to replace text content while preserving HTML
    def replace_in_text_nodes(match):
        text = match.group(0)
        # Check if we're inside an HTML tag
        if '<' in text or '>' in text:
            return text
        # Wrap matched text in highlight span
        return f'<span class="search-highlight">{text}</span>'
    
    # Split content into HTML tags and text content
    parts = re.split(r'(<[^>]+>)', html_content)
    
    # Process only text parts (odd indices after split)
    for i in range(len(parts)):
        if i % 2 == 0 and parts[i]:  # Text content
            # Apply highlighting with case-insensitive matching
            parts[i] = re.sub(pattern, replace_in_text_nodes, parts[i], flags=re.IGNORECASE)
    
    return ''.join(parts)


def strip_comments_from_html(html_content: str) -> str:
    """
    Remove comment patterns like /* text */ from HTML content while preserving HTML structure.
    Also removes empty divs that might be left behind.
    """
    if not html_content:
        return html_content
    
    # Remove /* comment */ patterns (including any whitespace around them)
    content = re.sub(r'/\*[^*]*\*/', '', html_content)
    
    # Remove empty divs that might be left behind
    content = re.sub(r'<div>\s*</div>', '', content)
    
    # Clean up extra whitespace
    content = re.sub(r'\s+', ' ', content).strip()
    
    return content


def render_read_only_mode(note) -> str:
    tags = getattr(note, "tags", None)
    if not isinstance(tags, str):
        raise TypeError(f"Note tags must be a string, got {type(tags)}")
    content = note.content
    if not note_tags_include(tags, "@llm"):
        content = strip_comments_from_html(content)
    return _format_note_content_standard(content_html=content, tags=tags)


def render_collapsed_read_only_mode(note) -> str:
    tags = getattr(note, "tags", None)
    if not isinstance(tags, str):
        raise TypeError(f"Note tags must be a string, got {type(tags)}")
    if note_tags_include(tags, "@llm"):
        preview_content = note.content
    else:
        if has_scoped_footnotes(tags):
            preview_content = note.content
        else:
            preview_content = extract_collapsed_preview_source_html(note.content)
        preview_content = strip_comments_from_html(preview_content)
    return _format_note_content_standard(content_html=preview_content, tags=tags)


def render_editing_mode(note) -> str:
    return note.content


def render_redacted_mode(note) -> str:
    """
    Render a note in redacted/dimmed mode for irrelevant search results.
    This is where you can customize how de-emphasized notes appear.
    """
    tags = getattr(note, "tags", None)
    if not isinstance(tags, str):
        raise TypeError(f"Note tags must be a string, got {type(tags)}")

    content = note.content
    if not note_tags_include(tags, "@llm"):
        content = strip_comments_from_html(content)
    content = _format_note_content_standard(content_html=content, tags=tags)
    # Wrap content in a span with reduced opacity
    return f'<span style="opacity: 0.4; filter: grayscale(50%);">{content}</span>'


def note_matches_search(note_dict, search_terms):
    """
    Check if a note or any of its descendants contains all search terms.
    
    Args:
        note_dict: Dictionary representation of a note with content and children
        search_terms: List of search terms (all must be present)
        
    Returns:
        True if note or any descendant contains all search terms
    """
    # Check the note's own content using RAW content (for search) not rendered content
    raw_content = note_dict['raw_content']
    plain_text = strip_html(raw_content).lower()
    if all(term in plain_text for term in search_terms):
        return True
    
    # Recursively check ALL descendants - if any descendant matches, we include this note
    for child in note_dict['children']:
        if note_matches_search(child, search_terms):
            return True
    
    return False


def note_directly_matches(note_dict, search_terms):
    """
    Check if a note directly contains all search terms (not checking descendants).
    """
    raw_content = note_dict['raw_content']
    plain_text = strip_html(raw_content).lower()
    return all(term in plain_text for term in search_terms)


def mark_search_relevance(notes, search_terms):
    """
    Mark each note with its search relevance level.
    
    Relevance levels:
    - 'direct_match': Note directly contains all search terms
    - 'relevant': Note is ancestor of a match (has matching descendants) OR descendant of a match
    - 'irrelevant': Note has no connection to search terms
    """
    def process_note(note_dict, parent_is_match: bool):
        # First check if this note is a direct match
        is_direct_match = note_directly_matches(note_dict, search_terms)
        
        # Process all children to determine if we have matching descendants
        has_matching_descendant = False
        for child in note_dict['children']:
            # Pass down whether current note or any ancestor was a match
            child_parent_is_match = parent_is_match
            if is_direct_match:
                child_parent_is_match = True
            child_relevance = process_note(child, child_parent_is_match)
            if child_relevance in ['direct_match', 'relevant']:
                has_matching_descendant = True
        
        # Determine this note's relevance
        if is_direct_match:
            relevance = 'direct_match'
        elif has_matching_descendant or parent_is_match:
            # Relevant if: has matching descendants OR any ancestor was a match
            relevance = 'relevant'
        else:
            relevance = 'irrelevant'
        
        note_dict['search_relevance'] = relevance
        return relevance
    
    # Process each top-level note
    for note in notes:
        process_note(note, parent_is_match=False)
    
    return notes


def apply_redacted_rendering(notes, search_query):
    """
    Apply redacted rendering to notes marked as irrelevant.
    This modifies the content of notes in-place based on their search_relevance.
    """
    def process_note(note_dict):
        # Recursively process children first
        for child in note_dict['children']:
            process_note(child)
        
        # Apply redacted rendering to irrelevant notes (unless being edited)
        if (note_dict['search_relevance'] == 'irrelevant' and 
            not note_dict['flags'].get('isEditing', False)):
            # Re-render using redacted mode
            # We need to create a simple note object for the render function
            class SimpleNote:
                def __init__(self, content, tags):
                    self.content = content
                    self.tags = tags
            
            raw_content = note_dict['raw_content']
            tags = note_dict['tags']
            note_obj = SimpleNote(raw_content, tags)
            note_dict['content'] = render_redacted_mode(note_obj)
        elif (note_dict['search_relevance'] in ['direct_match', 'relevant'] and 
              not note_dict['flags'].get('isEditing', False) and
              search_query):
            # Apply highlighting to relevant non-editing notes
            note_dict['content'] = highlight_search_terms(note_dict['content'], search_query)
    
    for note in notes:
        process_note(note)


def filter_notes_by_search(notes, search_query):
    """
    Filter notes based on search query using AND logic.
    A note is included if it OR any of its descendants contains ALL search terms.
    
    Args:
        notes: List of note dictionaries
        search_query: Search string from user
        
    Returns:
        Filtered list of notes that match the search
    """
    if not search_query or not search_query.strip():
        return notes
    
    # Split search query into terms and convert to lowercase
    search_terms = [term.lower() for term in search_query.strip().split() if term]
    
    if not search_terms:
        return notes
    
    # Filter notes - include a note if it or ANY descendant contains ALL search terms
    filtered_notes = []
    for note in notes:
        if note_matches_search(note, search_terms):
            filtered_notes.append(note)
    
    # Mark search relevance for all notes in filtered results
    mark_search_relevance(filtered_notes, search_terms)
    
    return filtered_notes


EMPTY_EDIT_PLACEHOLDER = "<div><br></div>"


def build_note_tree(
    db_manager,
    db,
    parent_id,
    editing_note_id,
    search_query,
    allowed_root_ids,
):
    """Build a hierarchical tree, preferring the in-memory store when loaded."""

    search_active = bool(search_query and str(search_query).strip())
    if not search_active:
        constrained_roots = allowed_root_ids
    else:
        constrained_roots = None

    if note_store.loaded:
        note_tree = _build_tree_from_store(
            parent_id,
            editing_note_id,
            constrained_roots,
        )
    else:
        note_tree = _build_tree_from_db(
            db_manager,
            db,
            parent_id,
            editing_note_id,
            constrained_roots,
        )

    if parent_id is None and search_query:
        note_tree = filter_notes_by_search(note_tree, search_query)
        apply_redacted_rendering(note_tree, search_query)

    return note_tree


def _build_tree_from_store(parent_id, editing_note_id, allowed_root_ids):
    """Recursively construct the note tree using the in-memory store."""

    note_tree = []
    child_ids = note_store.get_children(parent_id)

    if parent_id is None and allowed_root_ids is not None:
        if not allowed_root_ids:
            return []
        if not isinstance(allowed_root_ids, set):
            allowed_root_ids = set(allowed_root_ids)
        child_ids = [note_id for note_id in child_ids if note_id in allowed_root_ids]

    for note_id in child_ids:
        record = note_store.get_note(note_id)
        is_editing = note_id == editing_note_id
        record_child_ids = note_store.get_children(note_id)
        has_children = bool(record_child_ids)
        if bool(record.is_collapsed):
            children = []
        else:
            children = _build_tree_from_store(note_id, editing_note_id, allowed_root_ids)
        collapsed_preview_source = extract_collapsed_preview_source_html(record.content)
        content_is_collapsible = False
        if collapsed_preview_source != "":
            if collapsed_preview_source_has_media(record.content):
                content_is_collapsible = True
            elif collapsed_preview_source_has_hidden_content(record.content):
                content_is_collapsible = True
        is_collapsible = has_children
        if content_is_collapsible:
            is_collapsible = True

        parent_id_value = record.parent_id
        if parent_id_value is None:
            parent_id_value = ''

        if is_editing:
            rendered = render_editing_mode(record)
        elif bool(record.is_collapsed):
            rendered = render_collapsed_read_only_mode(record)
        else:
            rendered = render_read_only_mode(record)
        if is_editing and (not rendered or not rendered.strip()):
            rendered = EMPTY_EDIT_PLACEHOLDER

        note_tree.append(
            {
                'id': record.id,
                'content': rendered,
                'raw_content': record.content,
                'tags': record.tags,
                'parent_id': parent_id_value,
                'children': children,
                'flags': {
                    'isEditing': is_editing,
                    'isCollapsed': bool(record.is_collapsed),
                    'hasChildren': has_children,
                    'isCollapsible': is_collapsible,
                },
            }
        )

    return note_tree


def _build_tree_from_db(db_manager, db, parent_id, editing_note_id, allowed_root_ids):
    """Fallback tree construction that queries the database."""

    note_tree = []
    notes = db_manager.get_ordered_child_list(db, parent_id)

    if parent_id is None and allowed_root_ids is not None:
        if not allowed_root_ids:
            return []
        if not isinstance(allowed_root_ids, set):
            allowed_root_ids = set(allowed_root_ids)
        notes = [note for note in notes if note.id in allowed_root_ids]

    for note in notes:
        child_rows = db_manager.get_ordered_child_list(db, note.id)
        has_children = bool(child_rows)

        decrypted_content = get_cached_content(note.id)

        class DecryptedNote:
            def __init__(self, original_note, decrypted_content):
                self.id = original_note.id
                self.content = decrypted_content
                self.tags = get_cached_tags(original_note.id)
                self.parent_id = original_note.parent_id
                self.created_at = original_note.created_at
                self.updated_at = original_note.updated_at
                self.is_collapsed = getattr(original_note, 'is_collapsed', False)

        decrypted_note = DecryptedNote(note, decrypted_content)
        is_editing = note.id == editing_note_id
        if bool(getattr(note, 'is_collapsed', False)):
            children = []
        else:
            children = _build_tree_from_db(db_manager, db, note.id, editing_note_id, allowed_root_ids)
        collapsed_preview_source = extract_collapsed_preview_source_html(decrypted_content)
        content_is_collapsible = False
        if collapsed_preview_source != "":
            if collapsed_preview_source_has_media(decrypted_content):
                content_is_collapsible = True
            elif collapsed_preview_source_has_hidden_content(decrypted_content):
                content_is_collapsible = True
        is_collapsible = has_children
        if content_is_collapsible:
            is_collapsible = True

        parent_id_value = note.parent_id
        if parent_id_value is None:
            parent_id_value = ''
        if is_editing:
            rendered_content = render_editing_mode(decrypted_note)
        elif bool(getattr(note, 'is_collapsed', False)):
            rendered_content = render_collapsed_read_only_mode(decrypted_note)
        else:
            rendered_content = render_read_only_mode(decrypted_note)
        if note.id == editing_note_id and (not rendered_content or not rendered_content.strip()):
            rendered_content = EMPTY_EDIT_PLACEHOLDER

        note_tree.append(
            {
                'id': note.id,
                'content': rendered_content,
                'raw_content': decrypted_content,
                'tags': decrypted_note.tags,
                'parent_id': parent_id_value,
                'children': children,
                'flags': {
                    'isEditing': note.id == editing_note_id,
                    'isCollapsed': bool(getattr(note, 'is_collapsed', False)),
                    'hasChildren': has_children,
                    'isCollapsible': is_collapsible,
                },
            }
        )

    return note_tree
