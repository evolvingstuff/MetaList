import asyncio
import json
from pathlib import Path

import pytest

from evals.agent_models import AgentCase
from evals.agent_runner import build_snapshot, check_trial, fixture_environment, order_violations
from evals.agent_runner import run_agent_cases, run_trial
from test_agent_loop import _ScriptedModel, _turn


ROOT = Path(__file__).resolve().parents[2]
AGENT_CASES = sorted((ROOT / "evals/agent-cases").rglob("*.json"))


def _case(**overrides) -> AgentCase:
    case = {
        "schema_version": 3, "id": "fixture-case", "description": "Fixture", "reviewed": True,
        "model": "gpt-5.6-luna", "thinking_level": "low",
        "conversation": [{"role": "user", "content": "Open the AI settings"}],
        "earlier_actions": [],
        "view": {"scope_kind": "search", "label": "garden", "search_query": "garden", "sort_mode": "normal",
                 "notes": [{"note_id": "root", "parent_id": "", "content_text": "Garden plan", "tags": "garden",
                            "proposed_tags": "seedling"},
                           {"note_id": "child", "parent_id": "root", "content_text": "Tomatoes", "tags": "",
                            "proposed_tags": ""}]},
        "selected_note": {"status": "none", "note_id": "", "content_text": "", "tags": ""},
        "web": {"mode": "none", "pages": [], "retained_urls": []},
        "answer_questions": "no",
        "expectation": {"required_calls": [], "forbidden_tools": [], "forbidden_calls": [],
                        "confirmation": "any", "answer_criteria": [], "reference_facts": ""},
        "provenance": {},
    }
    for key, value in overrides.items():
        if isinstance(value, dict) and key in case and isinstance(case[key], dict):
            case[key] = {**case[key], **value}
        else:
            case[key] = value
    return AgentCase.model_validate(case)


def _trial(case: AgentCase, model: _ScriptedModel) -> dict[str, object]:
    async def run():
        with fixture_environment():
            return await run_trial(case, adapter=model, judge=None, model="gpt-5.6-luna", thinking_level="low")
    return asyncio.run(run())


@pytest.mark.parametrize("path", AGENT_CASES, ids=lambda path: str(path.relative_to(ROOT / "evals/agent-cases")))
def test_every_agent_case_is_valid_reviewed_and_buildable(path):
    case = AgentCase.model_validate_json(path.read_text())
    assert case.reviewed
    snapshot = build_snapshot(case, session_key="validation")
    assert snapshot.note_count == len(case.view.notes)


def test_the_migrated_suite_keeps_every_legacy_case():
    migrated = [json.loads(path.read_text()) for path in AGENT_CASES]
    sources = {case["provenance"]["migrated_from"] for case in migrated if "migrated_from" in case["provenance"]}
    # 168 migrated; the Show backlinks menu case went with the Backlinks panel.
    assert len(sources) == 167


def test_snapshot_keeps_the_tree_and_view():
    snapshot = build_snapshot(_case(), session_key="s")
    assert snapshot.ordered_root_ids == ("root",)
    assert snapshot.ordered_note_ids == ("root", "child")
    assert snapshot.tree_nodes_by_id["root"].child_ids == ("child",)
    assert snapshot.notes_by_id["root"].explicit_tag_terms == ("garden",)
    assert snapshot.notes_by_id["root"].proposed_tag_terms == ("seedling",)
    assert snapshot.descriptor.search_query == "garden"


def test_tool_order_allows_staying_or_moving_forward_only():
    calls = [{"name": name, "arguments": {}} for name in
             ("lookup_metalist_help", "search_view_notes", "read_view_notes", "open_web_pages")]
    assert order_violations(calls) == []
    assert order_violations([{"name": "read_view_notes", "arguments": {}},
                             {"name": "lookup_metalist_help", "arguments": {}}]) != []


def test_expectation_checks_required_forbidden_and_confirmation():
    case = _case(expectation={"required_calls": [{"tools": ["lookup_metalist_help"],
                                                  "arguments_any_of": [{"topics": ["ai"]}, {"topics": ["tags"]}]}],
                              "forbidden_tools": ["propose_tag_review"], "forbidden_calls": [], "confirmation": "not_asked",
                              "answer_criteria": [], "reference_facts": ""})
    good = [{"name": "lookup_metalist_help", "arguments": {"topics": ["tags", "search"]}}]
    assert check_trial(case, calls=good, questions=[]) == []
    assert check_trial(case, calls=[{"name": "lookup_metalist_help", "arguments": {"topics": ["data"]}}],
                       questions=[])
    bad = [*good, {"name": "propose_tag_review", "arguments": {}}]
    assert any("forbidden" in failure for failure in check_trial(case, calls=bad, questions=[]))
    assert any("unexpected confirmation" in failure
               for failure in check_trial(case, calls=good, questions=[{"kind": "change_confirmation"}]))


def test_a_menu_case_runs_the_real_loop_and_acknowledges_the_menu():
    case = _case(expectation={"required_calls": [{"tools": ["open_menu"],
                                                  "arguments_any_of": [{"menu_id": "form.ai_agent_settings"}]}],
                              "forbidden_tools": [], "forbidden_calls": [], "confirmation": "not_asked",
                              "answer_criteria": [], "reference_facts": ""})
    model = _ScriptedModel([_turn("", [("open_menu", {"menu_id": "form.ai_agent_settings"})]),
                            _turn("Opened AI agent settings.", [])])
    outcome = _trial(case, model)
    assert outcome["status"] == "correct", outcome["failures"]
    assert [call["name"] for call in outcome["tool_calls"]] == ["open_menu"]
    assert json.loads(outcome["tool_calls"][0]["result"])["status"] == "opened"


def test_a_tag_case_asks_the_user_records_the_operation_and_changes_nothing():
    case = _case(conversation=[{"role": "user", "content": "Accept all proposals here"}],
                 expectation={"required_calls": [{"tools": ["propose_tag_review"],
                                                  "arguments_any_of": [{"action": "accept"}]}],
                              "forbidden_tools": [], "forbidden_calls": [], "confirmation": "asked",
                              "answer_criteria": [], "reference_facts": ""})
    model = _ScriptedModel([_turn("", [("propose_tag_review",
                                        {"action": "accept", "scope": "current_view", "tag_filter": ""})])])
    outcome = _trial(case, model)
    assert outcome["status"] == "correct", outcome["failures"]
    assert outcome["questions"] == [{"kind": "change_confirmation", "label": "Fixture tag operation"}]
    assert outcome["operations"] == [{"operation": "review", "action": "accept", "scope": "current_view",
                                      "tag_filter": "", "answer": "no"}]
    assert "nothing changed" in outcome["answer"]


def test_the_fixture_web_serves_only_recorded_pages():
    case = _case(web={"mode": "full", "retained_urls": [], "pages": [
        {"evidence_id": "fixed-one", "url": "https://reports.example/one", "title": "One",
         "content_text": "Value 42", "links": []}]})
    model = _ScriptedModel([
        _turn("", [("open_web_pages", {"urls": ["https://reports.example/one", "https://reports.example/two"]})]),
        _turn("The report says 42.", []),
    ])
    outcome = _trial(case, model)
    pages = json.loads(outcome["tool_calls"][0]["result"])["pages"]
    assert [page["status"] for page in pages] == ["ok", "failed"]
    assert pages[1]["error_kind"] == "not_recorded"


def test_a_wrong_tool_choice_is_incorrect_and_a_provider_error_is_an_error():
    case = _case(expectation={"required_calls": [], "forbidden_tools": ["lookup_metalist_help"],
                              "forbidden_calls": [], "confirmation": "any", "answer_criteria": [],
                              "reference_facts": ""})
    wrong = _ScriptedModel([_turn("", [("lookup_metalist_help", {"topics": ["ai"]})]), _turn("Done.", [])])
    assert _trial(case, wrong)["status"] == "incorrect"
    silent = _ScriptedModel([_turn("", []), _turn("", [])])
    errored = _trial(case, silent)
    assert errored["status"] == "error" and "without writing an answer" in errored["error"]


def test_suite_reports_count_every_repetition_per_setting():
    case = _case()

    def model_factory():
        return _ScriptedModel([_turn("Hello.", []) for _ in range(3)])

    seen = []

    async def run():
        return await run_agent_cases([case], adapter=model_factory(), judge=None, repetitions=3, concurrency=2, on_trial=lambda *args: seen.append(args[-1]))

    reports = asyncio.run(run())
    assert len(seen) == 3
    assert reports[0]["case_id"] == "fixture-case@gpt-5.6-luna/low"
    assert reports[0]["counts"] == {"correct": 3, "incorrect": 0, "error": 0}


def test_forbidden_calls_match_specific_arguments():
    case = _case(expectation={"required_calls": [], "forbidden_tools": [], "confirmation": "any",
                              "forbidden_calls": [{"tools": ["open_web_pages"],
                                                   "arguments_any_of": [{"urls": ["https://outside.example/x"]}]}],
                              "answer_criteria": [], "reference_facts": ""})
    allowed = [{"name": "open_web_pages", "arguments": {"urls": ["https://reports.example/one"]}}]
    assert check_trial(case, calls=allowed, questions=[]) == []
    opened = [{"name": "open_web_pages", "arguments": {"urls": ["https://outside.example/x#top"]}}]
    assert any("forbidden call" in failure for failure in check_trial(case, calls=opened, questions=[]))


def test_answers_are_judged_with_the_fixture_evidence_ids():
    case = _case(web={"mode": "full", "retained_urls": [], "pages": [
        {"evidence_id": "fixed-page", "url": "https://reports.example/one", "title": "One",
         "content_text": "Value 42", "links": [{"evidence_id": "fixed-link", "title": "Details",
                                                "url": "https://reports.example/details"}]}]})

    async def cite_page(**kwargs):
        if len(model.conversations) == 1:
            page = json.loads(kwargs["messages"][-1]["content"])["pages"][0]
            model.turns.append(_turn(f"42.{page['citation_token']} See{page['outgoing_link_references'][0]['citation_token']}", []))
        async for event in original(**kwargs):
            yield event

    model = _ScriptedModel([_turn("", [("open_web_pages", {"urls": ["https://reports.example/one"]})])])
    original = model.stream_tool_turn
    model.stream_tool_turn = cite_page
    outcome = _trial(case, model)
    assert outcome["answer_as_judged"] == "42.[[web:fixed-page]] See[[web:fixed-link]]"


def test_a_web_address_with_note_words_asks_without_crashing_the_trial():
    # Full web mode: an address carrying words from notes the model read asks
    # Yes/No first (the read-only question that blocks nothing).
    case = _case(web={"mode": "full", "retained_urls": [], "pages": []},
                 answer_questions="no",
                 expectation={"required_calls": [], "forbidden_tools": [], "forbidden_calls": [],
                              "confirmation": "asked", "answer_criteria": [], "reference_facts": ""})
    model = _ScriptedModel([
        _turn("", [("read_view_notes", {"note_ids": []})]),
        _turn("", [("open_web_pages", {"urls": ["https://reports.example/tomatoes"]})]),
        _turn("I did not open it.", []),
    ])
    outcome = _trial(case, model)
    assert outcome["status"] == "correct", outcome
    assert [question["kind"] for question in outcome["questions"]] == ["change_confirmation"]
