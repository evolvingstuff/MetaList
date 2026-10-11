import asyncio
import json
import re
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType

import pytest

from app.services.agent.agent_tools import ToolContext
from app.services.agent.agent_tools import available_agent_tools
from app.services.agent.agent_tools import run_agent_tool
from app.services.agent.help_catalog import HELP_TOPICS
from app.services.agent.investigation import InvestigationState
from app.services.agent.release_notes import release_notes_skill_from_readme
from app.services.agent.retrieval_settings import AgentRetrievalSettings
from app.services.agent.skill_settings import DEFAULT_AGENT_SKILLS
from app.services.agent.skills import load_skill
from app.services.agent.web_capabilities import WebUrlCapabilitySet
from app.services.agent.scope import NoteText
from app.services.agent.web_actions import NoteTextGuard
from app.services.agent.web_evidence import web_evidence_store
from app.services.agent.web_fetch import WebPageFetchResult
from app.services.agent.web_settings import AgentWebSettings
from app.version import __version__
from test_agent_scoped_runtime import _snapshot


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
_NO_URLS = WebUrlCapabilitySet(())


def _context(*, snapshot, max_tokens: int, web_mode: str, skills) -> ToolContext:
    return ToolContext(
        session_key=snapshot.session_key,
        investigation=InvestigationState.start(
            snapshot=snapshot, settings=AgentRetrievalSettings(max_page_approximate_tokens=max_tokens),
        ),
        skills=skills,
        web_settings=AgentWebSettings(mode=web_mode),
        web_capabilities=_NO_URLS,
        note_text_guard=NoteTextGuard.build(note_text="", typed_text="", known_urls=frozenset(),
                                            approved_urls=frozenset()),
    )


def _run(context: ToolContext, name: str, arguments: object):
    return asyncio.run(run_agent_tool(name=name, arguments=json.dumps(arguments), context=context))


def _small_view() -> ToolContext:
    return _context(snapshot=_snapshot(large_tail=False), max_tokens=50_000, web_mode="none",
                    skills=DEFAULT_AGENT_SKILLS)


def test_the_release_notes_help_matches_the_readme() -> None:
    readme = (REPOSITORY_ROOT / "README.md").read_text(encoding="utf-8")
    # Regenerate with: .venv/bin/python scripts/sync_release_notes_help.py
    assert load_skill("help-releases.md") == release_notes_skill_from_readme(readme)


def test_release_notes_keep_every_readme_release_newest_first_without_links() -> None:
    readme = (
        "# App\n\n## Changes in 1.1.0\n\n- New [thing](docs/thing.md).\n\n"
        "## Changes in 1.0.0\n\n- First.\n\n## Technology Stack\n\n- Python\n"
    )
    skill = release_notes_skill_from_readme(readme)
    assert skill.index("## 1.1.0") < skill.index("## 1.0.0")
    assert "- New thing." in skill
    assert "Python" not in skill
    with pytest.raises(ValueError, match="no"):
        release_notes_skill_from_readme("# App\n")
    with pytest.raises(ValueError, match="empty"):
        release_notes_skill_from_readme("## Changes in 1.0.0\n\n## Changes in 0.9.0\n- x\n")


def test_help_lookup_returns_the_topics_skills_and_installed_version() -> None:
    context = _small_view()
    result = _run(context, "lookup_metalist_help", {"topics": ["releases", "ai"]})
    payload = json.loads(result.content)
    assert not result.is_error
    assert payload["installed_version"] == __version__
    assert [topic["topic"] for topic in payload["topics"]] == ["releases", "ai"]
    assert "## 0.11.0" in payload["topics"][0]["help"]
    assert payload["topics"][1]["help"] == DEFAULT_AGENT_SKILLS.for_action("help_ai").content
    assert [skill.skill_id for skill in result.activated_skills] == ["help_releases_v1", "help_ai_v1"]
    assert "ROOT_ALPHA" not in result.content


@pytest.mark.parametrize("arguments", [
    {"topics": []},
    {"topics": ["unknown"]},
    {"topics": ["ai", "ai"]},
    {"topics": ["ai"], "extra": 1},
    {},
])
def test_invalid_tool_arguments_are_explained_back_to_the_model(arguments) -> None:
    result = _run(_small_view(), "lookup_metalist_help", arguments)
    assert result.is_error
    assert "not accepted" in json.loads(result.content)["error"]


def test_unparseable_arguments_and_unknown_tools_are_explained_back() -> None:
    context = _small_view()
    broken = asyncio.run(run_agent_tool(name="read_view_notes", arguments="{not json", context=context))
    assert broken.is_error
    unknown = _run(context, "delete_notes", {})
    assert unknown.is_error and "no tool named" in json.loads(unknown.content)["error"]
    # Web pages are not offered at all when web access is off.
    web = _run(context, "open_web_pages", {"urls": ["https://example.com"]})
    assert web.is_error


def test_view_overview_describes_the_view_and_lists_its_trees() -> None:
    result = _run(_small_view(), "view_overview", {})
    payload = json.loads(result.content)
    assert payload["note_count"] == 3 and payload["tree_count"] == 2
    assert [tree["root_id"] for tree in payload["trees"]] == ["root-a", "root-b"]
    assert payload["trees"][0] == {"root_id": "root-a", "notes_in_view": 2, "preview": "ROOT_ALPHA"}
    assert payload["trees_not_listed"] == 0
    assert payload["selected_note"] == {"status": "none", "has_selection": False}


def test_view_overview_stops_listing_trees_at_its_budget() -> None:
    snapshot = _snapshot(large_tail=False)
    notes = dict(snapshot.notes_by_id)
    nodes = dict(snapshot.tree_nodes_by_id)
    root_ids = list(snapshot.ordered_root_ids)
    note_ids = list(snapshot.ordered_note_ids)
    for index in range(200):
        root_id = f"extra-{index}"
        notes[root_id] = replace(notes["root-b"], note_id=root_id, root_note_id=root_id,
                                 note_text=NoteText.from_text(f"Extra tree {index} " + "word " * 30))
        nodes[root_id] = replace(nodes["root-b"], note_id=root_id, root_note_id=root_id)
        root_ids.append(root_id)
        note_ids.append(root_id)
    snapshot = replace(snapshot, ordered_root_ids=tuple(root_ids), ordered_note_ids=tuple(note_ids),
                       notes_by_id=MappingProxyType(notes), tree_nodes_by_id=MappingProxyType(nodes))
    context = _context(snapshot=snapshot, max_tokens=2_000, web_mode="none", skills=DEFAULT_AGENT_SKILLS)
    payload = json.loads(_run(context, "view_overview", {}).content)
    assert 0 < len(payload["trees"]) < 202
    assert payload["trees_not_listed"] == 202 - len(payload["trees"])
    assert all(len(tree["preview"]) <= 120 for tree in payload["trees"])


def test_reading_with_no_ids_reads_the_view_in_order() -> None:
    result = _run(_small_view(), "read_view_notes", {"note_ids": []})
    payload = json.loads(result.content)
    assert result.note_ids == ("root-a", "child-a", "root-b")
    assert "CHILD_ALPHA" in result.content
    assert payload["unread_root_ids"] == [] and payload["unknown_ids"] == []


def test_reading_a_child_reads_its_whole_tree_and_reports_unknown_ids() -> None:
    result = _run(_small_view(), "read_view_notes", {"note_ids": ["child-a", "not-in-view"]})
    payload = json.loads(result.content)
    assert result.note_ids == ("root-a", "child-a")
    assert payload["unknown_ids"] == ["not-in-view"]
    assert "TAIL" not in result.content


def test_reading_stops_at_the_budget_and_reports_too_large_trees() -> None:
    context = _context(snapshot=_snapshot(large_tail=True), max_tokens=2_000, web_mode="none",
                       skills=DEFAULT_AGENT_SKILLS)
    payload = json.loads(_run(context, "read_view_notes", {"note_ids": []}).content)
    assert payload["too_large_root_ids"] == ["root-b"]
    assert payload["unread_root_ids"] == []
    assert len(payload["trees"]) == 1


def test_reading_leaves_trees_that_no_longer_fit_for_a_later_call() -> None:
    snapshot = _snapshot(large_tail=False)
    notes = dict(snapshot.notes_by_id)
    for note_id in ("root-a", "root-b"):
        notes[note_id] = replace(notes[note_id], note_text=NoteText.from_text(f"{note_id} " + "word " * 300))
    snapshot = replace(snapshot, notes_by_id=MappingProxyType(notes))
    context = _context(snapshot=snapshot, max_tokens=500, web_mode="none", skills=DEFAULT_AGENT_SKILLS)
    payload = json.loads(_run(context, "read_view_notes", {"note_ids": []}).content)
    assert [tree["note_id"] for tree in payload["trees"]] == ["root-a"]
    assert payload["unread_root_ids"] == ["root-b"] and payload["too_large_root_ids"] == []
    later = _run(context, "read_view_notes", {"note_ids": payload["unread_root_ids"]})
    assert later.note_ids == ("root-b",)


def test_search_finds_notes_by_every_word_in_text_or_tags_within_the_view() -> None:
    context = _small_view()
    result = _run(context, "search_view_notes", {"query": "child_alpha TESTOSTERONE"})
    payload = json.loads(result.content)
    assert payload["matching_note_ids"] == ["child-a"]
    assert result.note_ids == ("root-a", "child-a")
    by_tag = json.loads(_run(context, "search_view_notes", {"query": "#testosterone"}).content)
    assert by_tag["matching_note_count"] == 3
    none = _run(context, "search_view_notes", {"query": "absent words"})
    assert json.loads(none.content)["trees"] == [] and none.note_ids == ()
    assert _run(context, "search_view_notes", {"query": "   "}).is_error


def test_search_never_returns_notes_outside_the_frozen_view() -> None:
    snapshot = _snapshot(large_tail=False)
    hidden = {key: value for key, value in snapshot.notes_by_id.items() if key != "child-a"}
    nodes = dict(snapshot.tree_nodes_by_id)
    nodes["root-a"] = replace(nodes["root-a"], child_ids=())
    del nodes["child-a"]
    snapshot = replace(snapshot, ordered_note_ids=("root-a", "root-b"),
                       notes_by_id=MappingProxyType(hidden), tree_nodes_by_id=MappingProxyType(nodes))
    context = _context(snapshot=snapshot, max_tokens=50_000, web_mode="none", skills=DEFAULT_AGENT_SKILLS)
    result = _run(context, "search_view_notes", {"query": "child_alpha"})
    assert json.loads(result.content)["matching_note_count"] == 0 and result.note_ids == ()
    assert "CHILD_ALPHA" not in result.content


def test_tools_are_offered_in_the_default_order_and_web_only_when_enabled() -> None:
    assert [tool.name for tool in available_agent_tools(web_settings=AgentWebSettings(mode="none"))] == [
        "lookup_metalist_help", "view_overview", "search_view_notes", "read_view_notes",
    ]
    assert available_agent_tools(web_settings=AgentWebSettings(mode="full"))[-1].name == "open_web_pages"
    assert "releases" in HELP_TOPICS


def test_web_pages_open_through_the_web_fetcher_with_citation_tokens(monkeypatch) -> None:
    calls = []

    async def fake_fetch(urls, *, allows_target):
        calls.append(list(urls))
        assert allows_target("https://anything.example/")
        return (WebPageFetchResult(
            requested_url=urls[0], final_url=urls[0], status="ok", title="Tool page",
            content_text="Tool page content", outgoing_links=(), fetched_at="2026-10-05T00:00:00+00:00",
            truncated=False, error_kind="",
        ),)

    monkeypatch.setattr("app.services.agent.web_actions.fetch_web_pages", fake_fetch)
    context = _context(snapshot=_snapshot(large_tail=False), max_tokens=50_000, web_mode="full",
                       skills=DEFAULT_AGENT_SKILLS)
    result = _run(context, "open_web_pages", {"urls": ["https://agent-tools.example/page"]})
    page = json.loads(result.content)["pages"][0]
    assert calls == [["https://agent-tools.example/page"]]
    # The model sees a short per-session token and no long evidence id to copy.
    assert page["status"] == "ok" and re.fullmatch(r"\[\[web:\d+\]\]", page["citation_token"])
    assert "evidence_id" not in page
    assert [web_evidence_store.short_citation_token(session_key="session-1", evidence_id=evidence.evidence_id)
            for evidence in result.web_evidence] == [page["citation_token"]]


def test_contextual_web_mode_blocks_addresses_not_in_context(monkeypatch) -> None:
    async def forbidden_fetch(urls, *, allows_target):
        raise AssertionError("A blocked address must not be fetched")

    monkeypatch.setattr("app.services.agent.web_actions.fetch_web_pages", forbidden_fetch)
    context = _context(snapshot=_snapshot(large_tail=False), max_tokens=50_000, web_mode="contextual",
                       skills=DEFAULT_AGENT_SKILLS)
    result = _run(context, "open_web_pages", {"urls": ["https://not-in-context.example/"]})
    assert json.loads(result.content)["pages"][0]["status"] == "blocked"
    assert result.web_evidence == ()


def test_note_tools_report_the_note_text_they_showed_for_the_web_guard() -> None:
    context = _small_view()
    read = _run(context, "read_view_notes", {"note_ids": ["child-a"]})
    assert "ROOT_ALPHA" in read.disclosed_note_text and "CHILD_ALPHA" in read.disclosed_note_text
    assert "testosterone" in read.disclosed_note_text
    assert "TAIL" not in read.disclosed_note_text
    overview = _run(context, "view_overview", {})
    assert overview.disclosed_note_text == "ROOT_ALPHA\nTAIL"
    assert _run(context, "lookup_metalist_help", {"topics": ["ai"]}).disclosed_note_text == ""
