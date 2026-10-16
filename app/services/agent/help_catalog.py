"""Help topics and the menu catalog; detailed product knowledge lives in the help skills."""

import json
from importlib.resources import files
from typing import Literal


HELP_TOPICS = {
    'notes': ('Notes and editing', 'Hierarchy, editing, moving, copying and pasting, undo, keyboard shortcuts, tag bar typing and tag suggestions, and command palette utilities. Mouse actions belong to mouse.'),
    'mouse': ('Mouse controls', 'What clicking, double-clicking, dragging, right-clicking (context menus), hovering and scrolling do on notes, arrows, references, tabs and other on-screen controls.'),
    'search': ('Search and views', 'Tag/text queries, OR, exclusions, matching, sorting, untagged view, and typing in the search bar with its suggestions.'),
    'tags': ('Tags and ontology', 'Manual tag assignment, inheritance, autocomplete, ontology and tag relationship rules. AI proposal workflows belong to ai.'),
    'formatting': ('Formatting and attachments', 'Markdown, LaTeX, Mermaid, formatting scopes and files.'),
    'references': ('References and floating notes', 'Links, transclusions, backlinks, floating windows and Excalidraw diagrams.'),
    'menus': ('Menus and settings', 'Find/open menu dialogs and understand preference controls.'),
    'reminders': ('Reminders', 'Creating, editing, snoozing and recurrence.'),
    'ai': ('AI and tag proposals', 'OpenAI settings, context limits, prompts/skills, history export, and AI tag proposals: generation, acceptance, rejection/removal and bulk undo limits. This topic alone covers proposal workflow explanations.'),
    'privacy': ('Privacy and security', 'Cloud disclosure, gray notes when hovering chat, password exclusion, encryption and credentials.'),
    'data': ('Namespaces and backups', 'Namespaces, backup/restore, HTML export, ports and updates.'),
    'dictation': ('Dictation (speech to text)', 'Pasting dictated text from speech-to-text tools such as Superwhisper into the search bar, tag bar or a note: how words become tags, spoken dash/quote/or/not, "at to do" meta tags, the "start tags" phrase in notes, undo, and Dictation Settings.'),
    'releases': ('Release notes', 'What changed in each MetaList version (what is new, when a feature or fix arrived).'),
}
HelpTopic = Literal[tuple(HELP_TOPICS)]
MENU_ACTIONS = json.loads(files('app').joinpath('static/config/agent-menu-actions.json').read_text(encoding='utf-8'))
assert len({entry['id'] for entry in MENU_ACTIONS}) == len(MENU_ACTIONS)
MENU_BY_ID = {entry['id']: entry for entry in MENU_ACTIONS}
