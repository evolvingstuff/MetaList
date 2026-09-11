from dataclasses import dataclass

from app.security.note_html import sanitize_note_html
from app.services.content_formatting import format_note_content_for_view
from app.usecases.base import QueryCommand


@dataclass
class CmdPrefetchLinkTitles(QueryCommand):
    content: str
    tags: str

    def describe(self) -> str:
        return "CmdPrefetchLinkTitles"

    def execute(self) -> dict[str, str]:
        # Reuse view eligibility (including footnotes and Markdown) without saving
        # the draft or publishing generated HTML back into the active editor.
        format_note_content_for_view(
            content_html=sanitize_note_html(self.content),
            tags=self.tags,
            redact_passwords=True,
        )
        return {"status": "success"}
