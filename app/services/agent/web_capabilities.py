"""Per-turn exact URL capabilities derived only from disclosed agent evidence."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Iterable

from app.services.agent.investigation import InvestigationEvidencePayload
from app.services.agent.scope import SelectedNoteContext
from app.services.public_http import normalize_public_http_url


_URL_CANDIDATE_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
_TRAILING_URL_PUNCTUATION = ".,;:!?)]}"


@dataclass(frozen=True, slots=True)
class WebUrlCapability:
    normalized_url: str
    sources: tuple[str, ...]

    def __post_init__(self) -> None:
        if normalize_public_http_url(self.normalized_url) != self.normalized_url:
            raise ValueError("Web URL capability requires a normalized public URL syntax")
        if len(self.sources) == 0 or len(set(self.sources)) != len(self.sources):
            raise ValueError("Web URL capability requires unique provenance sources")


class WebUrlCapabilitySet:
    def __init__(self, capabilities: Iterable[WebUrlCapability]) -> None:
        sources_by_url: dict[str, list[str]] = {}
        ordered_urls: list[str] = []
        for capability in capabilities:
            if not isinstance(capability, WebUrlCapability):
                raise TypeError("capabilities must contain WebUrlCapability records")
            if capability.normalized_url not in sources_by_url:
                ordered_urls.append(capability.normalized_url)
                sources_by_url[capability.normalized_url] = []
            for source in capability.sources:
                if source not in sources_by_url[capability.normalized_url]:
                    sources_by_url[capability.normalized_url].append(source)
        self._capabilities = tuple(
            WebUrlCapability(url, tuple(sources_by_url[url])) for url in ordered_urls
        )
        self._by_url = {
            capability.normalized_url: capability for capability in self._capabilities
        }

    def allows(self, url: str) -> bool:
        normalized = normalize_public_http_url(url)
        return normalized is not None and normalized in self._by_url

    def require(self, url: str) -> WebUrlCapability:
        normalized = normalize_public_http_url(url)
        if normalized is None or normalized not in self._by_url:
            raise PermissionError("URL is not available in permitted agent context")
        return self._by_url[normalized]

    @property
    def normalized_urls(self) -> tuple[str, ...]:
        return tuple(capability.normalized_url for capability in self._capabilities)

    @property
    def capabilities(self) -> tuple[WebUrlCapability, ...]:
        return self._capabilities

    def including(self, other: WebUrlCapabilitySet) -> WebUrlCapabilitySet:
        """This set plus the addresses of another, keeping every provenance source."""
        if not isinstance(other, WebUrlCapabilitySet):
            raise TypeError("Can only include another WebUrlCapabilitySet")
        return WebUrlCapabilitySet((*self._capabilities, *other.capabilities))


def extract_normalized_web_urls(text: str) -> tuple[str, ...]:
    if not isinstance(text, str):
        raise TypeError("Web URL extraction requires text")
    normalized_urls: list[str] = []
    for match in _URL_CANDIDATE_RE.finditer(text):
        candidate = match.group(0).rstrip(_TRAILING_URL_PUNCTUATION)
        normalized = normalize_public_http_url(candidate)
        if normalized is not None and normalized not in normalized_urls:
            normalized_urls.append(normalized)
    return tuple(normalized_urls)


def build_web_url_capabilities(
    *,
    canonical_messages: list[dict[str, str]],
    selected_note: SelectedNoteContext,
    investigation_evidence: InvestigationEvidencePayload | None,
    retained_web_urls: tuple[str, ...],
) -> WebUrlCapabilitySet:
    if not isinstance(canonical_messages, list):
        raise TypeError("canonical_messages must be a list")
    capabilities: list[WebUrlCapability] = []
    for index, message in enumerate(canonical_messages):
        if not isinstance(message, dict) or set(message) != {"role", "content"}:
            raise ValueError("Canonical web capability message is invalid")
        if message["role"] != "user":
            continue
        capabilities.extend(
            WebUrlCapability(url, (f"user_message:{index}",))
            for url in extract_normalized_web_urls(message["content"])
        )

    if selected_note.status == "available":
        for note in selected_note.tree_notes:
            disclosed_text = f"{note.content_text}\n{note.tags}"
            capabilities.extend(
                WebUrlCapability(url, (f"selected_note:{note.note_id}",))
                for url in extract_normalized_web_urls(disclosed_text)
            )

    if investigation_evidence is not None:
        for note_id, disclosed_text in _iter_disclosed_investigation_note_text(
            investigation_evidence.result_trees
        ):
            capabilities.extend(
                WebUrlCapability(url, (f"investigation_note:{note_id}",))
                for url in extract_normalized_web_urls(disclosed_text)
            )

    for url in retained_web_urls:
        normalized = normalize_public_http_url(url)
        if normalized is None:
            raise ValueError("Retained web evidence URL is invalid")
        capabilities.append(WebUrlCapability(normalized, ("retained_web_evidence",)))
    return WebUrlCapabilitySet(capabilities)


def note_evidence_url_capabilities(evidence: InvestigationEvidencePayload) -> WebUrlCapabilitySet:
    """Addresses written in notes a tool returned to the model."""
    if not isinstance(evidence, InvestigationEvidencePayload):
        raise TypeError("Note evidence must be InvestigationEvidencePayload")
    return WebUrlCapabilitySet(
        WebUrlCapability(url, (f"investigation_note:{note_id}",))
        for note_id, disclosed_text in _iter_disclosed_investigation_note_text(evidence.result_trees)
        for url in extract_normalized_web_urls(disclosed_text)
    )


def _listed_or_none(note: dict[str, object], key: str) -> object:
    """A list the serialized tree leaves out when it is empty (children, tags)."""
    if key not in note:  # shockharness: ignore[DEF002] reason="the serialized tree leaves out an empty list"
        return []
    return note[key]


def _iter_disclosed_investigation_note_text(
    result_trees: tuple[dict[str, object], ...],
) -> Iterable[tuple[str, str]]:
    stack = list(reversed(result_trees))
    while stack:
        note = stack.pop()
        if "note_id" not in note:
            raise RuntimeError("Investigation evidence note is missing note_id")
        note_id = note["note_id"]
        children = _listed_or_none(note, "children")
        if not isinstance(note_id, str) or note_id == "":
            raise RuntimeError("Investigation evidence note is missing note_id")
        if not isinstance(children, list):
            raise RuntimeError("Investigation evidence note children are invalid")
        # Structure-only placeholders say is_evidence: false; evidence notes omit it.
        if "is_evidence" in note and note["is_evidence"] is not False:
            raise RuntimeError("Structural tree nodes must be marked is_evidence false")
        if "is_evidence" not in note:
            if "content_text" not in note:
                raise RuntimeError("Investigation evidence note content is invalid")
            content_text = note["content_text"]
            tags = _listed_or_none(note, "tags")
            proposed_tags = _listed_or_none(note, "proposed_tags")
            if not isinstance(content_text, str):
                raise RuntimeError("Investigation evidence note content is invalid")
            if (
                not isinstance(tags, list)
                or any(not isinstance(tag, str) for tag in tags)
                or not isinstance(proposed_tags, list)
                or any(not isinstance(tag, str) for tag in proposed_tags)
            ):
                raise RuntimeError("Investigation evidence note tags are invalid")
            yield note_id, "\n".join((content_text, *tags, *proposed_tags))
        for child in reversed(children):
            if not isinstance(child, dict):
                raise RuntimeError("Investigation evidence child must be an object")
            stack.append(child)
