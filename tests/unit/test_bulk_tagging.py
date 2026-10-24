from __future__ import annotations

import asyncio
from collections import Counter
import json
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from app.services.agent.cloud_privacy import CloudPrivacyBoundary, EMPTY_CLOUD_PRIVACY_POLICY
from app.services.agent.tagging import (
    TAGGING_FOCUS_KEY, TAGGING_POLICY_KEY, TagBatchResult,
    make_batch, partition_trees, shuffle_trees_for_batches,
    validate_proposals,
)
import app.services.agent.tagging as tagging
import app.services.agent.tagging_run as runs
import app.usecases.bulk_tag_proposals as mutations
from app.services.agent.retrieval_settings import resolve_tagging_batch_tokens
from app.services.bulk_operation import BulkOperationGuard, BulkOperationBusy
from app.services.agent.inference import InferenceProviderError
from app.services.agent.inference import InferenceAttempt
from app.services.agent.inference import StructuredInferenceError
from app.services.agent.skill_settings import DEFAULT_AGENT_SKILLS


_BOUNDARY = CloudPrivacyBoundary(provider="openai", apply_cloud_policy=True, policy=EMPTY_CLOUD_PRIVACY_POLICY)


@pytest.fixture(autouse=True)
def namespace_contains_test_scope(monkeypatch):
    note_ids = tuple({"a", "b", "d", *(str(index) for index in range(2000))})
    monkeypatch.setattr(runs.store, "list_note_ids", lambda: note_ids)
    monkeypatch.setattr(runs, "shuffle_trees_for_batches", lambda trees: trees)
    # No tag outside the scope is visible to the AI.
    monkeypatch.setattr(runs, "visible_tag_counts", lambda boundary: ({}, Counter()))
    monkeypatch.setattr(runs, "visible_super_tag_examples", lambda boundary: ())


def validate(result, batch, policy):
    known = {tag.casefold(): tag for tag in batch.vocabulary}
    return validate_proposals(
        result, batch, batch.note_ids, policy, known,
    )


def tree(note_id, tag, children):
    return {"note_id": note_id, "content_text": note_id * 200,
            "tags": [tag], "proposed_tags": ["unaccepted"], "children": list(children)}


def test_partition_covers_all_roots_and_preserves_hierarchy():
    roots = (tree("a", "accepted", (tree("b", "accepted", ()),)), tree("d", "accepted", ()))
    budget = max(make_batch((root,)).tokens for root in roots)
    batches = partition_trees(roots, budget)
    assert len(batches) == 2
    assert batches[0].note_ids == {"a", "b"}
    assert batches[1].note_ids == {"d"}
    assert all(batch.tokens <= budget for batch in batches)
    assert "unaccepted" not in batches[0].vocabulary


def test_tagging_roots_are_shuffled_without_reordering_hierarchy(monkeypatch):
    child = tree("b", "accepted", ())
    roots = (tree("a", "accepted", (child,)), tree("d", "accepted", ()))
    monkeypatch.setattr(tagging.random, "shuffle", lambda values: values.reverse())

    shuffled = shuffle_trees_for_batches(roots)

    assert [root["note_id"] for root in shuffled] == ["d", "a"]
    assert shuffled[1]["children"] == [child]
    assert [root["note_id"] for root in roots] == ["a", "d"]


def test_vocabulary_and_note_ids_are_enforced():
    batch = make_batch((tree("a", "Cooking", ()),))
    result = TagBatchResult(proposals=[{"note_id": "a", "tags": ["cooking"]}])
    assert validate(result, batch, "existing") == {"a": ("Cooking",)}
    for note_id, tag in (("hidden", "Cooking"), ("a", "unaccepted"), ("a", "new"), ("a", "@shell")):
        with pytest.raises(ValueError):
            validate(TagBatchResult(proposals=[{"note_id": note_id, "tags": [tag]}]), batch, "existing")
    assert validate(TagBatchResult(proposals=[{"note_id": "a", "tags": ["new"]}]), batch, "new") == {"a": ("new",)}


@pytest.mark.parametrize("total,allowed", [(9, False), (10, True), (11, True)])
@pytest.mark.parametrize("policy,valid_tag,invalid_tag", [
    ("existing", "Cooking", "inference"),
    ("new_only", "inference", "Cooking"),
    ("new", "inference", "@shell"),
])
def test_invalid_tag_tolerance_is_ten_percent_of_assignments(total, allowed, policy, valid_tag, invalid_tag):
    roots = tuple(tree(str(index), "Cooking", ()) for index in range(total))
    batch = make_batch(roots)
    entries = [{"note_id": str(index), "tags": [valid_tag]} for index in range(total)]
    entries[0]["tags"] = [invalid_tag]
    result = TagBatchResult(proposals=entries)
    if not allowed:
        with pytest.raises(ValueError, match="10%"):
            validate(result, batch, policy)
        return
    validated = validate(result, batch, policy)
    assert "0" not in validated
    assert len(validated) == total - 1
    assert all(tags == (valid_tag,) for tags in validated.values())


def test_duplicate_tags_cannot_dilute_error_rate():
    batch = make_batch((tree("a", "Cooking", ()),))
    result = TagBatchResult(proposals=[{"note_id": "a", "tags": ["Cooking"] * 11 + ["bad"]}])
    with pytest.raises(ValueError, match="10%"):
        validate(result, batch, "existing")


def test_a_visible_tag_left_out_of_the_vocabulary_is_valid_and_canonicalized():
    batch = make_batch((tree("a", "Cooking", ()),))
    result = TagBatchResult(proposals=[{"note_id": "a", "tags": ["few-shot-learning"]}])
    visible = {"cooking": "Cooking", "few-shot-learning": "Few-Shot-Learning"}
    assert batch.vocabulary == ("Cooking",)
    assert validate_proposals(
        result, batch, batch.note_ids, "existing", visible,
    ) == {
        "a": ("Few-Shot-Learning",),
    }
    assert validate_proposals(
        result, batch, batch.note_ids, "new_only", visible,
    ) == {}
    assert validate_proposals(
        result, batch, batch.note_ids, "new", visible,
    ) == {
        "a": ("Few-Shot-Learning",),
    }


@pytest.mark.parametrize("total,allowed", [(9, False), (10, True), (11, True)])
@pytest.mark.parametrize("invalid_kind", ["undisclosed", "duplicate"])
def test_invalid_note_id_entries_have_ten_percent_tolerance(total, allowed, invalid_kind):
    roots = tuple(tree(str(index), "Cooking", ()) for index in range(total))
    batch = make_batch(roots)
    entries = [
        {"note_id": str(index), "tags": ["Cooking"]}
        for index in range(total)
    ]
    if invalid_kind == "undisclosed":
        entries[0]["note_id"] = "hidden"
    else:
        entries[0]["note_id"] = entries[1]["note_id"]
    result = TagBatchResult(proposals=entries)
    if not allowed:
        with pytest.raises(ValueError, match="invalid note IDs.*10%"):
            validate(result, batch, "existing")
        return
    validated = validate(result, batch, "existing")
    assert len(validated) == total - 1
    assert "hidden" not in validated


def test_a_private_note_id_is_answered_like_an_invented_one():
    """The model learns only what it was shown: another batch's note is named as
    such, while a private note's ID and an invented one get the same answer."""
    batch = make_batch((tree("a", "Cooking", ()),))
    known = {"cooking": "Cooking"}
    cross_batch = TagBatchResult(proposals=[{"note_id": "b", "tags": ["Cooking"]}])
    with pytest.raises(ValueError, match="different batch within the permitted scope"):
        validate_proposals(cross_batch, batch, frozenset({"a", "b"}), "existing", known)
    messages = []
    for note_id in ("private-note", "invented"):
        with pytest.raises(ValueError) as raised:
            validate_proposals(TagBatchResult(proposals=[{"note_id": note_id, "tags": ["Cooking"]}]),
                               batch, frozenset({"a", "b"}), "existing", known)
        messages.append(str(raised.value).replace(note_id, "<id>"))
    assert messages[0] == messages[1]
    assert "Nonexistent note ID" in messages[0]


def test_a_tag_only_private_notes_carry_is_answered_like_an_invented_one():
    batch = make_batch((tree("a", "Cooking", ()),))
    visible = {"cooking": "Cooking"}
    answers = []
    for tag in ("diary", "invented"):
        with pytest.raises(ValueError) as raised:
            validate_proposals(TagBatchResult(proposals=[{"note_id": "a", "tags": [tag]}]),
                               batch, batch.note_ids, "existing", visible)
        answers.append(str(raised.value).replace(tag, "<tag>"))
    assert answers[0] == answers[1]
    # In a new-tags pass it is simply new, with the AI's own spelling.
    assert validate_proposals(TagBatchResult(proposals=[{"note_id": "a", "tags": ["Diary"]}]),
                              batch, batch.note_ids, "new_only", visible) == {"a": ("Diary",)}


@pytest.mark.parametrize("repairs", [True, False])
def test_invalid_model_vocabulary_gets_bounded_correction_attempts(monkeypatch, repairs):
    batch = make_batch((tree("a", "Cooking", ()),))
    calls = []
    async def infer(inference, run, messages, model, on_progress):
        calls.append(messages)
        tag = "hallucinated"
        if repairs and len(calls) == 2:
            tag = "Cooking"
        return SimpleNamespace(content=TagBatchResult(proposals=[{"note_id": "a", "tags": [tag]}]).model_dump_json())
    monkeypatch.setattr(runs, "infer_with_progress", infer)
    async def consume():
        return await runs.infer_validated_batch(None, None, [{"role": "user", "content": "evidence"}],
                                               batch, batch.note_ids,
                                               "existing", 100000, {"cooking": "Cooking"})
    if repairs:
        assert asyncio.run(consume()) == {"a": ("Cooking",)}
        assert len(calls) == 2
    else:
        with pytest.raises(InferenceProviderError, match="3 correction attempts"):
            asyncio.run(consume())
        assert len(calls) == 4
    assert "hallucinated" in calls[1][-1]["content"]
    assert "accepted_vocabulary" in calls[1][-1]["content"]


def test_new_only_collision_with_a_visible_tag_outside_the_vocabulary_is_silently_dropped():
    batch = make_batch((tree("a", "Cooking", ()),))
    result = TagBatchResult(proposals=[
        {"note_id": "a", "tags": ["undisclosed-existing", "genuinely-new"]},
    ])

    assert validate_proposals(
        result,
        batch,
        batch.note_ids,
        "new_only",
        {"cooking": "Cooking", "undisclosed-existing": "undisclosed-existing"},
    ) == {"a": ("genuinely-new",)}


def test_batches_share_whole_context_vocabulary_and_keep_large_roots():
    roots = (tree("a", "Cooking", ()), tree("b", "Gardening", ()))
    batches = partition_trees(roots, 50)
    assert len(batches) == 2
    assert all(batch.vocabulary == ("Cooking", "Gardening") for batch in batches)
    result = TagBatchResult(proposals=[{"note_id": "a", "tags": ["Gardening"]}])
    assert validate(result, batches[0], "existing") == {"a": ("Gardening",)}
    assert batches[0].tokens > 50  # Target window never splits a root tree.


def test_tagging_window_is_provider_specific_and_validated():
    preferences = {"pref.ai.tagging.batch_tokens": "3000", "pref.ai.openai.tagging.batch_tokens": "12000"}
    assert resolve_tagging_batch_tokens(preferences, "openai") == 12000
    assert resolve_tagging_batch_tokens({}, "openai") == 100000
    with pytest.raises(ValueError):
        resolve_tagging_batch_tokens({"pref.ai.tagging.batch_tokens": "499"}, "ollama")


def test_guard_rejects_concurrent_pass_and_validates_answers():
    async def scenario():
        guard = BulkOperationGuard()
        with guard.acquire("session"):
            with pytest.raises(BulkOperationBusy):
                with guard.acquire("another"):
                    pass
            question, future = guard.question(("existing", "new"))
            with pytest.raises(ValueError):
                guard.answer("wrong-session", question, "new")
            with pytest.raises(ValueError):
                guard.answer("session", question, "invalid")
            guard.answer("session", question, "new")
            assert await future == "new"
        assert not guard.operation_id
    asyncio.run(scenario())


@pytest.mark.parametrize("outcome", ["success", "failure", "cancel", "decline"])
def test_whole_pass_publication_and_failure_atomicity(monkeypatch, outcome):
    roots = (tree("a", "accepted", ()), tree("b", "accepted", ()))
    snapshot = SimpleNamespace(session_key="session", tree_nodes_by_id={"a": None, "b": None})
    monkeypatch.setattr(runs, "tagging_trees", lambda _: roots)
    monkeypatch.setattr(runs.TaggingRun, "validate_current", lambda self: None)
    monkeypatch.setattr(runs, "load_client_preferences", lambda **kwargs: {})
    monkeypatch.setattr(runs, "save_client_preferences", lambda **kwargs: None)
    calls = []
    applied = []
    focus_answer = {
        "success": "focus_both",
        "failure": "focus_both",
        "cancel": "focus_both",
        "decline": "cancel",
    }[outcome]
    monkeypatch.setattr(
        runs,
        "prepare_proposal_changes",
        lambda ids, action, tag, proposals: (
            dict(proposals),
            sum(len(tags) for tags in proposals.values()),
            dict(proposals),
        ),
    )
    monkeypatch.setattr(runs, "apply_bulk_proposals", lambda **kwargs: applied.append(kwargs))
    run = SimpleNamespace(base_url="http://local", selected_model="test", skills=DEFAULT_AGENT_SKILLS, current_user_request="Suggest tags here", retrieval_settings=SimpleNamespace(
        max_page_approximate_tokens=max(make_batch((root,)).tokens for root in roots)))

    async def infer(inference, run, messages, model, on_progress):
        assert not applied
        calls.append(messages)
        if len(calls) == 2 and outcome == "failure":
            raise InferenceProviderError("provider unavailable")
        if len(calls) == 2 and outcome == "cancel":
            raise asyncio.CancelledError()
        note_id = ["a", "b"][len(calls) - 1]
        return SimpleNamespace(content=TagBatchResult(proposals=[{"note_id": note_id, "tags": ["new"]}]).model_dump_json())
    monkeypatch.setattr(runs, "infer_with_progress", infer)

    async def inspect_context_window(**kwargs):
        return SimpleNamespace(loaded_tokens=1_000_000)

    async def consume():
        operation = runs.TaggingRun(token="token", privacy_boundary=_BOUNDARY, snapshot=snapshot,
            preferences={TAGGING_POLICY_KEY: "new"}, sync_uuid="sync", batch_tokens=run.retrieval_settings.max_page_approximate_tokens)
        async for event in operation.stream_generation(inference=SimpleNamespace(inspect_context_window=inspect_context_window), run=run):
            if event["type"] == "bulk_question":
                assert not applied
                # Focus and scope are one card, answered once.
                assert event["kind"] == "tag_scope_confirmation"
                assert event["chooses_focus"] is True
                runs.bulk_operation_guard.answer(
                    "session",
                    event["question_id"],
                    focus_answer,
                )

    if outcome == "failure":
        with pytest.raises(InferenceProviderError):
            asyncio.run(consume())
    elif outcome == "cancel":
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(consume())
    else:
        asyncio.run(consume())
    assert len(applied) == (1 if outcome == "success" else 0)
    if applied:
        assert set(applied[0]["changes"]) == {"a", "b"}
        batch_payloads = [json.loads(messages[2]["content"]) for messages in calls]
        assert batch_payloads[0]["prior_batch_new_tags"] == []
        assert batch_payloads[1]["prior_batch_new_tags"] == ["new"]
    assert not runs.bulk_operation_guard.operation_id


@pytest.mark.parametrize("fail", [False, True])
def test_history_clears_after_commit_and_publication_only(monkeypatch, fail):
    events = []
    @contextmanager
    def transaction():
        events.append("begin")
        yield
        if fail:
            raise OSError("commit failed")
        events.append("commit")
    @contextmanager
    def writer():
        yield object()
    monkeypatch.setattr(mutations, "begin_request_transaction", transaction)
    monkeypatch.setattr(mutations, "begin_writer", writer)
    monkeypatch.setattr(mutations, "encrypt", lambda value, token: (value, b"nonce", b"tag"))
    monkeypatch.setattr(mutations, "store", SimpleNamespace(get_note=lambda _: SimpleNamespace(tags=""),
        apply_bulk_tag_sources=lambda changes: events.append("publish")))
    monkeypatch.setattr(mutations, "update_note_fields_preserving_updated_at", lambda *args, **kwargs: events.append("write"))
    monkeypatch.setattr(mutations, "record_explicit_tag_addition_batch", lambda **kwargs: None)
    monkeypatch.setattr(mutations, "cache_note_tags", lambda *args: None)
    monkeypatch.setattr(mutations, "cache_note_proposed_tags", lambda *args: None)
    monkeypatch.setattr(mutations, "reset_all_undo_state", lambda: events.append("clear_history"))
    monkeypatch.setattr(mutations, "generate_new_uuid", lambda: "new-sync")
    if fail:
        with pytest.raises(OSError):
            mutations.apply_bulk_proposals(changes={"a": ("", "proposal")}, token="token")
        assert "publish" not in events and "clear_history" not in events
    else:
        mutations.apply_bulk_proposals(changes={"a": ("", "proposal")}, token="token")
        assert events == ["begin", "write", "commit", "publish", "clear_history"]


def test_no_changes_preserves_history(monkeypatch):
    monkeypatch.setattr(mutations, "get_current_sync_uuid", lambda: "unchanged")
    monkeypatch.setattr(mutations, "reset_all_undo_state", lambda: pytest.fail("No-op cleared undo"))
    assert mutations.apply_bulk_proposals(changes={}, token="token") == "unchanged"


def test_generation_completion_lists_tags_with_clickable_note_references(monkeypatch):
    first_note_id = "11111111-1111-4111-8111-111111111111"
    second_note_id = "22222222-2222-4222-8222-222222222222"
    affected = {
        first_note_id: ("novel-tag", "shared-tag"),
        second_note_id: ("shared-tag",),
    }
    monkeypatch.setattr(runs.TaggingRun, "validate_current", lambda self: None)
    monkeypatch.setattr(
        runs,
        "prepare_proposal_changes",
        lambda *args: (
            {note_id: ("", " ".join(tags)) for note_id, tags in affected.items()},
            3,
            affected,
        ),
    )
    monkeypatch.setattr(runs, "apply_bulk_proposals", lambda **kwargs: None)
    operation = runs.TaggingRun(
        token="token",
        privacy_boundary=_BOUNDARY,
        snapshot=SimpleNamespace(),
        preferences={},
        sync_uuid="sync",
        batch_tokens=1000,
    )

    async def collect_events():
        return [
            event
            async for event in operation.apply(
                tuple(affected), "generate", "", affected, "",
            )
        ]

    events = asyncio.run(collect_events())
    assert events[0] == {
        "type": "bulk_progress",
        "label": "Applying all changes",
        "committing": True,
    }
    content_event = next(event for event in events if event["type"] == "content_delta")
    done_event = next(event for event in events if event["type"] == "done")
    assert content_event["reference_note_ids"] == [first_note_id, second_note_id]
    assert done_event["reference_note_ids"] == [first_note_id, second_note_id]
    assert f"- `novel-tag` [[{first_note_id}]]" in content_event["text"]
    assert (
        f"- `shared-tag` [[{first_note_id}]] [[{second_note_id}]]"
        in content_event["text"]
    )


@pytest.mark.parametrize("action", ["accept", "remove"])
def test_programmatic_proposal_changes_do_not_emit_cancelable_progress(monkeypatch, action):
    monkeypatch.setattr(runs.TaggingRun, "validate_current", lambda self: None)
    monkeypatch.setattr(
        runs,
        "prepare_proposal_changes",
        lambda *args: ({"a": ("accepted", "")}, 1, {"a": ("proposal",)}),
    )
    applied = []
    monkeypatch.setattr(runs, "apply_bulk_proposals", lambda **kwargs: applied.append(kwargs))
    operation = runs.TaggingRun(
        token="token",
        privacy_boundary=_BOUNDARY,
        snapshot=SimpleNamespace(),
        preferences={},
        sync_uuid="sync",
        batch_tokens=1000,
    )

    async def collect_events():
        return [
            event
            async for event in operation.apply(("a",), action, "", {}, "")
        ]

    events = asyncio.run(collect_events())
    assert [event["type"] for event in events] == [
        "bulk_complete",
        "content_delta",
        "done",
    ]
    assert applied == [{"changes": {"a": ("accepted", "")}, "token": "token"}]


def test_budget_boundary_and_large_scope_coverage():
    roots = tuple(tree(str(index), "accepted", ()) for index in range(2000))
    total = make_batch(roots)
    assert len(partition_trees(roots, total.tokens)) == 1
    batches = partition_trees(roots, total.tokens // 3)
    reviewed = [note_id for batch in batches for note_id in batch.note_ids]
    assert len(reviewed) == 2000
    assert len(set(reviewed)) == 2000
    assert all(batch.tokens <= total.tokens // 3 for batch in batches)


@pytest.mark.parametrize("action", ["accept", "remove"])
def test_programmatic_exact_tag_filter_preserves_other_proposals(monkeypatch, action):
    records = {
        "a": SimpleNamespace(tags="human", proposed_tags="Foo other"),
        "b": SimpleNamespace(tags="", proposed_tags="foo"),
        "outside": SimpleNamespace(tags="", proposed_tags="Foo"),
    }
    monkeypatch.setattr(mutations, "store", SimpleNamespace(get_note=records.__getitem__))
    changes, count, affected_proposals = mutations.prepare_proposal_changes(
        ("a", "b"), action, "FOO", {},
    )
    assert count == 2
    assert set(changes) == {"a", "b"}
    assert changes["a"][1] == "other"
    assert changes["b"][1] == ""
    assert affected_proposals == {"a": ("Foo",), "b": ("foo",)}
    expected_tags = {"accept": "human Foo", "remove": "human"}
    assert changes["a"][0] == expected_tags[action]
    assert records["outside"].proposed_tags == "Foo"
    assert records["a"].proposed_tags == "Foo other"


@pytest.mark.parametrize("choice,policy", [("focus_existing", "existing"), ("focus_new", "new"), ("focus_both", "new")])
@pytest.mark.parametrize("over_budget", [False, True])
def test_first_use_category_permission_reports_batch_size(monkeypatch, choice, policy, over_budget):
    roots = (tree("a", "accepted", ()),)
    if over_budget:
        roots = (*roots, tree("b", "accepted", ()))
    saved = []
    questions = []
    monkeypatch.setattr(runs, "tagging_trees", lambda _: roots)
    monkeypatch.setattr(runs.TaggingRun, "validate_current", lambda self: None)
    monkeypatch.setattr(runs, "save_client_preferences", lambda **kwargs: saved.append(dict(kwargs["preferences"])))
    monkeypatch.setattr(runs, "load_client_preferences", lambda **kwargs: {"pref.theme": "dark"})
    monkeypatch.setattr(runs, "prepare_proposal_changes", lambda *args: ({}, 0, {}))
    monkeypatch.setattr(runs, "apply_bulk_proposals", lambda **kwargs: None)
    monkeypatch.setattr(runs.store, "list_note_ids", lambda: tuple(
        root["note_id"] for root in roots
    ))
    async def infer(*args):
        return SimpleNamespace(content='{"proposals":[]}')
    async def inspect(**kwargs):
        return SimpleNamespace(loaded_tokens=1_000_000)
    monkeypatch.setattr(runs, "infer_with_progress", infer)
    snapshot = SimpleNamespace(
        session_key="session",
        tree_nodes_by_id={root["note_id"]: None for root in roots},
    )
    run = SimpleNamespace(base_url="http://local", selected_model="test", skills=DEFAULT_AGENT_SKILLS, current_user_request="Suggest tags",
        retrieval_settings=SimpleNamespace(max_page_approximate_tokens=make_batch((roots[0],)).tokens))
    async def consume():
        operation = runs.TaggingRun(token="token", privacy_boundary=_BOUNDARY, snapshot=snapshot, preferences={}, sync_uuid="sync", batch_tokens=run.retrieval_settings.max_page_approximate_tokens)
        with runs.bulk_operation_guard.acquire("session"):
            async for event in operation.generate(inference=SimpleNamespace(inspect_context_window=inspect), run=run, focus="unspecified"):
                if event["type"] == "bulk_question":
                    questions.append(event)
                    runs.bulk_operation_guard.answer("session", event["question_id"], choice)
    asyncio.run(consume())
    assert len(questions) == 1
    question = questions[0]
    assert question["kind"] == "tag_scope_confirmation"
    assert question["chooses_focus"] is True
    assert question["focus"] == "existing"
    assert question["root_count"] == len(roots)
    assert question["label"].endswith("Choose which tags to suggest.")
    if over_budget:
        assert question["label"].startswith("This scope uses approximately ")
        assert "× the evidence budget: its 2 root notes need " in question["label"]
        assert "nothing is applied until every batch succeeds" in question["label"]
        assert question["prefix_root_count"] == 1
    else:
        assert question["label"].startswith(
            "This scope contains 1 root notes and fits the evidence budget (approximately "
        )
        assert question["prefix_root_count"] == 0
    assert saved == [{
        "pref.theme": "dark",
        TAGGING_POLICY_KEY: policy,
        TAGGING_FOCUS_KEY: choice.removeprefix("focus_"),
    }]


def test_tagging_seeds_first_batch_then_runs_four_batches_concurrently(monkeypatch):
    roots = tuple(tree(f"root-{index}", "accepted", ()) for index in range(7))
    batch_tokens = make_batch((roots[0],)).tokens
    active = 0
    maximum_active = 0
    starts = []

    monkeypatch.setattr(runs, "tagging_trees", lambda _: roots)
    monkeypatch.setattr(runs.TaggingRun, "validate_current", lambda self: None)
    monkeypatch.setattr(runs, "prepare_proposal_changes", lambda *args: ({}, 0, {}))
    monkeypatch.setattr(runs, "apply_bulk_proposals", lambda **kwargs: None)
    monkeypatch.setattr(runs.store, "list_note_ids", lambda: tuple(
        root["note_id"] for root in roots
    ))

    async def infer(_inference, _run, messages, *_args):
        nonlocal active, maximum_active
        payload = json.loads(messages[-1]["content"])
        root_id = payload["result_trees"][0]["note_id"]
        starts.append((root_id, active))
        active += 1
        maximum_active = max(maximum_active, active)
        await asyncio.sleep(0.01)
        active -= 1
        return SimpleNamespace(content='{"proposals":[]}')

    async def inspect(**kwargs):
        return SimpleNamespace(loaded_tokens=1_000_000)

    monkeypatch.setattr(runs, "infer_with_progress", infer)
    snapshot = SimpleNamespace(
        session_key="session",
        tree_nodes_by_id={root["note_id"]: None for root in roots},
    )
    run = SimpleNamespace(
        base_url="http://local", skills=DEFAULT_AGENT_SKILLS,
        selected_model="test",
        current_user_request="Suggest tags",
        retrieval_settings=SimpleNamespace(max_page_approximate_tokens=1_000_000),
    )

    async def consume():
        operation = runs.TaggingRun(
            token="token",
            privacy_boundary=_BOUNDARY,
            snapshot=snapshot,
            preferences={TAGGING_POLICY_KEY: "existing"},
            sync_uuid="sync",
            batch_tokens=batch_tokens,
        )
        with runs.bulk_operation_guard.acquire("session"):
            return [
                event
                async for event in operation.generate(
                    inference=SimpleNamespace(inspect_context_window=inspect),
                    run=run,
                    focus="existing",
                )
            ]

    asyncio.run(consume())
    assert starts[0] == ("root-0", 0)
    assert starts[1][1] == 0
    assert maximum_active == 4
    assert len(starts) == len(roots)


def test_new_only_rejects_existing_vocabulary_case_insensitively():
    batch = make_batch((tree("a", "accepted", ()),))
    result = TagBatchResult(proposals=[{"note_id": "a", "tags": ["ACCEPTED"]}])
    with pytest.raises(ValueError, match="existing tag during a new-tags-only pass"):
        validate(result, batch, "new_only")
    result = TagBatchResult(proposals=[{"note_id": "a", "tags": ["novel"]}])
    assert validate(result, batch, "new_only") == {"a": ("novel",)}


def test_tagging_prompts_make_the_requested_topic_a_specific_binding_filter():
    DEFAULT_TAGGING_PROMPT = DEFAULT_AGENT_SKILLS.for_action("tag_proposals").content
    assert "binding topical constraint" in DEFAULT_TAGGING_PROMPT
    assert "specific concepts, methods, or named entities" in DEFAULT_TAGGING_PROMPT
    assert "examples to disambiguate the intended semantic scope" in DEFAULT_TAGGING_PROMPT
    assert "omit notes outside that topic" in DEFAULT_TAGGING_PROMPT


def test_agent_generation_always_lets_the_user_choose_the_focus(monkeypatch):
    # The agent never decides the focus from the request text; the scope card asks.
    selected_focuses = []
    monkeypatch.setattr(runs.TaggingRun, "validate_current", lambda self: None)

    async def generate(self, *, inference, run, focus):
        selected_focuses.append(focus)
        yield {"type": "done"}

    monkeypatch.setattr(runs.TaggingRun, "generate", generate)
    operation = runs.TaggingRun(
        token="token",
        privacy_boundary=_BOUNDARY,
        snapshot=SimpleNamespace(session_key="focus-regression"),
        preferences={},
        sync_uuid="sync",
        batch_tokens=1000,
    )

    async def consume():
        return [event async for event in operation.stream_generation(inference=None, run=None)]

    assert asyncio.run(consume()) == [{"type": "done"}]
    assert selected_focuses == ["unspecified"]


@pytest.mark.parametrize("policy,focus,answer,expected_calls", [
    ("new", "existing", "", 1),
    ("new", "new", "", 1),
    ("new", "both", "", 1),
    ("existing", "new", "", 0),
    ("existing", "both", "", 0),
])
def test_generation_focus_is_per_pass_and_respects_saved_policy(monkeypatch, policy, focus, answer, expected_calls):
    roots = (tree("a", "accepted", ()),)
    calls, questions, applied = [], [], []
    monkeypatch.setattr(runs, "tagging_trees", lambda _: roots)
    monkeypatch.setattr(runs.TaggingRun, "validate_current", lambda self: None)
    monkeypatch.setattr(runs, "prepare_proposal_changes", lambda *args: ({}, 0, {}))
    monkeypatch.setattr(runs, "apply_bulk_proposals", lambda **kwargs: applied.append(kwargs))
    def forbid_save(**kwargs):
        pytest.fail("Per-pass focus must not change saved preferences")
    monkeypatch.setattr(runs, "save_client_preferences", forbid_save)
    async def infer(inference, run, messages, model, on_progress):
        calls.append(messages)
        return SimpleNamespace(content='{"proposals":[]}')
    async def inspect(**kwargs):
        return SimpleNamespace(loaded_tokens=1_000_000)
    monkeypatch.setattr(runs, "infer_with_progress", infer)
    snapshot = SimpleNamespace(session_key="session", tree_nodes_by_id={"a": None})
    run = SimpleNamespace(base_url="http://local", selected_model="test", skills=DEFAULT_AGENT_SKILLS, current_user_request="Suggest tags",
        retrieval_settings=SimpleNamespace(max_page_approximate_tokens=make_batch(roots).tokens))
    async def consume():
        operation = runs.TaggingRun(token="token", privacy_boundary=_BOUNDARY, snapshot=snapshot,
            preferences={TAGGING_POLICY_KEY: policy}, sync_uuid="sync", batch_tokens=run.retrieval_settings.max_page_approximate_tokens)
        with runs.bulk_operation_guard.acquire("session"):
            async for event in operation.generate(inference=SimpleNamespace(inspect_context_window=inspect), run=run, focus=focus):
                if event["type"] == "bulk_question":
                    questions.append(event["kind"])
                    runs.bulk_operation_guard.answer("session", event["question_id"], answer)
        assert operation.preferences == {TAGGING_POLICY_KEY: policy}
    asyncio.run(consume())
    assert questions == (["focus"] if answer else [])
    assert len(calls) == expected_calls
    assert len(applied) == expected_calls
    if calls:
        resolved_focus = focus
        if answer:
            resolved_focus = answer.removeprefix("focus_")
        if resolved_focus == "unspecified":
            resolved_focus = "existing"
        expected_text = {"existing": "Focus only on missing existing tags", "new": "PASS MODE: NEW TAGS ONLY",
                         "both": "PASS MODE: EXISTING AND NEW TAGS"}[resolved_focus]
        assert expected_text in calls[0][1]["content"]
        payload = json.loads(calls[0][2]["content"])
        assert "request is a binding topical constraint" in calls[0][1]["content"]
        assert payload["request"] == run.current_user_request
        assert payload["tagging_mode"] == {
            "existing": "existing", "new": "new_only", "both": policy,
        }[resolved_focus]


def test_broad_focus_choice_can_enable_new_tags_without_a_second_question(monkeypatch):
    roots = (tree("a", "accepted", ()),)
    saved = []
    monkeypatch.setattr(runs, "tagging_trees", lambda _: roots)
    monkeypatch.setattr(runs.TaggingRun, "validate_current", lambda self: None)
    monkeypatch.setattr(runs, "load_client_preferences", lambda **kwargs: {
        TAGGING_POLICY_KEY: "existing",
    })
    monkeypatch.setattr(runs, "save_client_preferences", lambda **kwargs: saved.append(kwargs["preferences"]))
    monkeypatch.setattr(runs, "prepare_proposal_changes", lambda *args: ({}, 0, {}))
    monkeypatch.setattr(runs, "apply_bulk_proposals", lambda **kwargs: None)
    async def infer(inference, run, messages, model, on_progress):
        return SimpleNamespace(content='{"proposals":[]}')
    async def inspect(**kwargs):
        return SimpleNamespace(loaded_tokens=1_000_000)
    monkeypatch.setattr(runs, "infer_with_progress", infer)
    snapshot = SimpleNamespace(session_key="session", tree_nodes_by_id={"a": None})
    run = SimpleNamespace(base_url="http://local", selected_model="test", skills=DEFAULT_AGENT_SKILLS,
        current_user_request="Suggest tags", retrieval_settings=SimpleNamespace(
            max_page_approximate_tokens=make_batch(roots).tokens))

    async def consume():
        operation = runs.TaggingRun(token="token", privacy_boundary=_BOUNDARY, snapshot=snapshot,
            preferences={TAGGING_POLICY_KEY: "existing"}, sync_uuid="sync",
            batch_tokens=run.retrieval_settings.max_page_approximate_tokens)
        with runs.bulk_operation_guard.acquire("session"):
            async for event in operation.generate(
                inference=SimpleNamespace(inspect_context_window=inspect),
                run=run,
                focus="unspecified",
            ):
                if event["type"] == "bulk_question":
                    assert event["kind"] == "tag_scope_confirmation"
                    assert event["focus"] == "existing"
                    runs.bulk_operation_guard.answer(
                        "session", event["question_id"], "focus_new",
                    )
        assert operation.preferences[TAGGING_POLICY_KEY] == "new"
        assert operation.preferences[TAGGING_FOCUS_KEY] == "new"

    asyncio.run(consume())
    assert saved == [{TAGGING_POLICY_KEY: "new", TAGGING_FOCUS_KEY: "new"}]


def test_broad_focus_question_defaults_to_the_previous_exact_choice(monkeypatch):
    roots = (tree("a", "accepted", ()),)
    monkeypatch.setattr(runs, "tagging_trees", lambda _: roots)
    monkeypatch.setattr(runs.TaggingRun, "validate_current", lambda self: None)
    monkeypatch.setattr(runs, "load_client_preferences", lambda **kwargs: {
        TAGGING_POLICY_KEY: "new", TAGGING_FOCUS_KEY: "both",
    })
    monkeypatch.setattr(runs, "save_client_preferences", lambda **kwargs: None)
    monkeypatch.setattr(runs, "prepare_proposal_changes", lambda *args: ({}, 0, {}))
    monkeypatch.setattr(runs, "apply_bulk_proposals", lambda **kwargs: None)
    monkeypatch.setattr(runs, "infer_with_progress", lambda *args: None)
    async def inspect(**kwargs):
        return SimpleNamespace(loaded_tokens=1_000_000)
    snapshot = SimpleNamespace(session_key="session", tree_nodes_by_id={"a": None})
    run = SimpleNamespace(base_url="http://local", selected_model="test", skills=DEFAULT_AGENT_SKILLS,
        current_user_request="Suggest tags", retrieval_settings=SimpleNamespace(
            max_page_approximate_tokens=make_batch(roots).tokens))

    async def consume():
        operation = runs.TaggingRun(token="token", privacy_boundary=_BOUNDARY, snapshot=snapshot,
            preferences={TAGGING_POLICY_KEY: "new", TAGGING_FOCUS_KEY: "both"},
            sync_uuid="sync", batch_tokens=run.retrieval_settings.max_page_approximate_tokens)
        with runs.bulk_operation_guard.acquire("session"):
            generator = operation.generate(
                inference=SimpleNamespace(inspect_context_window=inspect),
                run=run,
                focus="unspecified",
            )
            event = await anext(generator)
            assert event["type"] == "bulk_question"
            assert event["focus"] == "both"
            runs.bulk_operation_guard.answer(
                "session", event["question_id"], "cancel",
            )
            async for _ in generator:
                pass

    asyncio.run(consume())


@pytest.mark.parametrize("answer", ["proceed", "use_prefix"])
def test_over_budget_tagging_offers_all_roots_or_the_leading_prefix(monkeypatch, answer):
    roots = tuple(tree(f"root-{index}", "accepted", ()) for index in range(3))
    budget = make_batch(roots[:1]).tokens
    assert make_batch(roots[:2]).tokens > budget
    snapshot = SimpleNamespace(
        session_key="session",
        tree_nodes_by_id={root["note_id"]: None for root in roots},
    )
    monkeypatch.setattr(runs, "tagging_trees", lambda _: roots)
    monkeypatch.setattr(runs.store, "list_note_ids", lambda: tuple(
        root["note_id"] for root in roots
    ))
    monkeypatch.setattr(runs.TaggingRun, "validate_current", lambda self: None)
    monkeypatch.setattr(runs, "load_client_preferences", lambda **kwargs: {})
    monkeypatch.setattr(runs, "save_client_preferences", lambda **kwargs: None)
    monkeypatch.setattr(
        runs,
        "prepare_proposal_changes",
        lambda ids, action, tag, proposals: (
            dict(proposals),
            sum(len(tags) for tags in proposals.values()),
            dict(proposals),
        ),
    )
    applied = []
    monkeypatch.setattr(runs, "apply_bulk_proposals", lambda **kwargs: applied.append(kwargs))
    reviewed_note_ids = []

    async def infer(inference, run, messages, model, on_progress):
        batch = json.loads(messages[2]["content"])
        note_ids = [root["note_id"] for root in batch["result_trees"]]
        reviewed_note_ids.extend(note_ids)
        return SimpleNamespace(content=TagBatchResult(proposals=[
            {"note_id": note_id, "tags": ["fresh"]} for note_id in note_ids
        ]).model_dump_json())

    monkeypatch.setattr(runs, "infer_with_progress", infer)

    async def inspect(**kwargs):
        return SimpleNamespace(loaded_tokens=1_000_000)

    run = SimpleNamespace(base_url="http://local", selected_model="test", skills=DEFAULT_AGENT_SKILLS,
        current_user_request="Suggest tags",
        retrieval_settings=SimpleNamespace(max_page_approximate_tokens=budget))
    questions = []
    texts = []

    async def consume():
        operation = runs.TaggingRun(token="token", privacy_boundary=_BOUNDARY, snapshot=snapshot,
            preferences={TAGGING_POLICY_KEY: "new"}, sync_uuid="sync", batch_tokens=budget)
        with runs.bulk_operation_guard.acquire("session"):
            async for event in operation.generate(
                inference=SimpleNamespace(inspect_context_window=inspect),
                run=run,
                focus="new",
            ):
                if event["type"] == "bulk_question":
                    questions.append(event)
                    runs.bulk_operation_guard.answer("session", event["question_id"], answer)
                if event["type"] == "content_delta":
                    texts.append(event["text"])

    asyncio.run(consume())

    assert len(questions) == 1
    question = questions[0]
    assert question["kind"] == "tag_scope_confirmation"
    assert question["root_count"] == 3
    assert question["batch_count"] == 3
    assert question["prefix_root_count"] == 1
    assert "the evidence budget" in question["label"]
    assert len(applied) == 1
    if answer == "proceed":
        assert sorted(reviewed_note_ids) == ["root-0", "root-1", "root-2"]
        assert set(applied[0]["changes"]) == {"root-0", "root-1", "root-2"}
        assert "Reviewed only" not in texts[0]
    else:
        assert reviewed_note_ids == ["root-0"]
        assert set(applied[0]["changes"]) == {"root-0"}
        assert texts[0].startswith("Reviewed only the first 1 of 3 root notes")


def test_leading_tree_prefix_is_the_longest_canonical_prefix_within_budget():
    roots = tuple(tree(f"root-{index}", "accepted", ()) for index in range(5))
    assert tagging.leading_tree_count_within_budget(roots, make_batch(roots).tokens) == 5
    assert tagging.leading_tree_count_within_budget(roots, make_batch(roots[:3]).tokens) == 3
    assert tagging.leading_tree_count_within_budget(roots, make_batch(roots[:1]).tokens - 1) == 0


def test_tag_suggestions_are_a_packaged_skill():
    skill = DEFAULT_AGENT_SKILLS.for_action("tag_proposals")
    assert skill.skill_id == "tag_proposals_v1"
    assert "binding topical constraint" in skill.content


def test_tag_batches_send_the_packaged_tag_skill(monkeypatch):
    roots = (tree("a", "accepted", ()),)
    snapshot = SimpleNamespace(session_key="session", tree_nodes_by_id={"a": None})
    monkeypatch.setattr(runs, "tagging_trees", lambda _: roots)
    monkeypatch.setattr(runs.TaggingRun, "validate_current", lambda self: None)
    monkeypatch.setattr(runs, "load_client_preferences", lambda **kwargs: {})
    monkeypatch.setattr(runs, "save_client_preferences", lambda **kwargs: None)
    monkeypatch.setattr(runs, "apply_bulk_proposals", lambda **kwargs: None)
    monkeypatch.setattr(runs, "prepare_proposal_changes", lambda *args: ({}, 0, {}))
    sent = []

    async def infer(inference, run, messages, model, on_progress):
        sent.append(messages)
        return SimpleNamespace(content='{"proposals":[]}')

    monkeypatch.setattr(runs, "infer_with_progress", infer)

    async def inspect(**kwargs):
        return SimpleNamespace(loaded_tokens=1_000_000)

    run = SimpleNamespace(base_url="http://local", selected_model="test",
        current_user_request="Suggest tags", skills=DEFAULT_AGENT_SKILLS,
        retrieval_settings=SimpleNamespace(max_page_approximate_tokens=1_000_000))

    async def consume():
        # A tagging prompt saved when prompts were editable must never reach the model.
        operation = runs.TaggingRun(token="token", privacy_boundary=_BOUNDARY, snapshot=snapshot,
            preferences={TAGGING_POLICY_KEY: "new", "pref.ai.prompt.tagging": "Stale prompt"},
            sync_uuid="sync", batch_tokens=1_000_000)
        with runs.bulk_operation_guard.acquire("session"):
            async for _event in operation.generate(
                inference=SimpleNamespace(inspect_context_window=inspect), run=run, focus="new",
            ):
                pass

    asyncio.run(consume())

    assert sent[0][0] == {
        "role": "system",
        "content": "ACTIVE_SKILL tag_proposals_v1\nTrigger action: tag_proposals\n\n"
        + DEFAULT_AGENT_SKILLS.for_action("tag_proposals").content,
    }


def test_combined_tag_card_can_choose_focus_and_the_leading_prefix(monkeypatch):
    roots = tuple(tree(f"root-{index}", "accepted", ()) for index in range(3))
    budget = make_batch(roots[:1]).tokens
    snapshot = SimpleNamespace(
        session_key="session",
        tree_nodes_by_id={root["note_id"]: None for root in roots},
    )
    monkeypatch.setattr(runs, "tagging_trees", lambda _: roots)
    monkeypatch.setattr(runs.store, "list_note_ids", lambda: tuple(
        root["note_id"] for root in roots
    ))
    monkeypatch.setattr(runs.TaggingRun, "validate_current", lambda self: None)
    monkeypatch.setattr(runs, "load_client_preferences", lambda **kwargs: {})
    saved = []
    monkeypatch.setattr(runs, "save_client_preferences",
        lambda **kwargs: saved.append(dict(kwargs["preferences"])))
    monkeypatch.setattr(runs, "prepare_proposal_changes", lambda *args: ({}, 0, {}))
    monkeypatch.setattr(runs, "apply_bulk_proposals", lambda **kwargs: None)
    reviewed = []

    async def infer(inference, run, messages, model, on_progress):
        reviewed.extend(
            root["note_id"] for root in json.loads(messages[2]["content"])["result_trees"]
        )
        return SimpleNamespace(content='{"proposals":[]}')

    monkeypatch.setattr(runs, "infer_with_progress", infer)

    async def inspect(**kwargs):
        return SimpleNamespace(loaded_tokens=1_000_000)

    run = SimpleNamespace(base_url="http://local", selected_model="test",
        skills=DEFAULT_AGENT_SKILLS, current_user_request="Suggest tags",
        retrieval_settings=SimpleNamespace(max_page_approximate_tokens=budget))
    questions = []

    async def consume():
        operation = runs.TaggingRun(token="token", privacy_boundary=_BOUNDARY, snapshot=snapshot, preferences={},
            sync_uuid="sync", batch_tokens=budget)
        with runs.bulk_operation_guard.acquire("session"):
            async for event in operation.generate(
                inference=SimpleNamespace(inspect_context_window=inspect),
                run=run,
                focus="unspecified",
            ):
                if event["type"] == "bulk_question":
                    questions.append(event)
                    runs.bulk_operation_guard.answer(
                        "session", event["question_id"], "prefix_focus_new",
                    )

    asyncio.run(consume())

    assert [question["kind"] for question in questions] == ["tag_scope_confirmation"]
    assert questions[0]["prefix_root_count"] == 1
    assert reviewed == ["root-0"]
    assert saved == [{TAGGING_POLICY_KEY: "new", TAGGING_FOCUS_KEY: "new"}]


def test_a_failed_tagging_call_explains_itself_like_the_chat_steps() -> None:
    cut_off = InferenceAttempt(
        request={"max_completion_tokens": 8_192},
        response={
            "choices": [{"message": {"role": "assistant", "content": ""}, "finish_reason": "length"}],
            "usage": {"completion_tokens": 8_192, "completion_tokens_details": {"reasoning_tokens": 8_192}},
        },
        error="IncompleteOutputException: The output is incomplete due to a max_tokens length limit.",
        duration_ms=10_000.0,
        validation_errors=(),
    )

    async def infer_structured(**arguments):
        raise StructuredInferenceError(attempts=[cut_off, cut_off])

    run = SimpleNamespace(
        base_url="https://api.openai.com/v1", selected_model="gpt-5.6-sol", thinking_level="high",
        web_settings=SimpleNamespace(mode="none"), session_key="session", run_id="run",
    )
    with pytest.raises(InferenceProviderError) as failure:
        asyncio.run(runs.infer_with_progress(
            SimpleNamespace(infer_structured=infer_structured), run, [], TagBatchResult, lambda progress: None,
        ))

    message = str(failure.value)
    assert "it failed while proposing tags" in message
    assert "all 8192 tokens went to thinking" in message
    assert "Setup: gpt-5.6-sol, High thinking, web access off." in message


@pytest.mark.parametrize("answer,applies", [("yes", True), ("no", False)])
def test_agent_tag_review_shows_the_exact_change_and_applies_only_after_yes(monkeypatch, answer, applies):
    monkeypatch.setattr(runs.TaggingRun, "validate_current", lambda self: None)
    monkeypatch.setattr(runs, "proposal_scope_ids", lambda descriptor, *, date_filter, file_filter: ("a", "b"))
    monkeypatch.setattr(
        runs,
        "prepare_proposal_changes",
        lambda *args: ({"a": ("x", ""), "b": ("x", "")}, 3, {"a": ("x",), "b": ("x", "y")}),
    )
    applied = []
    monkeypatch.setattr(runs, "apply_bulk_proposals", lambda **kwargs: applied.append(kwargs))
    operation = runs.TaggingRun(token="token", privacy_boundary=_BOUNDARY, snapshot=SimpleNamespace(session_key="review-session", descriptor=None, date_filter=None, file_filter=None),
                                preferences={}, sync_uuid="sync", batch_tokens=1000)

    async def collect_events():
        events = []
        async for event in operation.stream_review(action="accept", scope="current_view", tag_filter="x"):
            events.append(event)
            if event["type"] == "bulk_question":
                runs.bulk_operation_guard.answer("review-session", event["question_id"], answer)
        return events

    events = asyncio.run(collect_events())
    question = events[0]
    assert question["kind"] == "change_confirmation"
    assert question["label"] == "Accept 3 pending proposals of the tag `x` across 2 notes in the current view?"
    assert bool(applied) is applies
    text = "".join(event["text"] for event in events if event["type"] == "content_delta")
    if applies:
        assert text == "Accepted 3 tag proposals across 2 notes."
    else:
        assert text == "Cancelled. No proposals changed."


def test_agent_tag_review_with_nothing_to_change_asks_nothing(monkeypatch):
    monkeypatch.setattr(runs.TaggingRun, "validate_current", lambda self: None)
    monkeypatch.setattr(runs, "prepare_proposal_changes", lambda *args: ({}, 0, {}))
    operation = runs.TaggingRun(token="token", privacy_boundary=_BOUNDARY, snapshot=SimpleNamespace(session_key="review-empty", descriptor=None),
                                preferences={}, sync_uuid="sync", batch_tokens=1000)

    async def collect_events():
        return [event async for event in operation.stream_review(action="remove", scope="namespace", tag_filter="")]

    events = asyncio.run(collect_events())
    assert [event["type"] for event in events] == ["bulk_complete", "content_delta", "done"]
    assert events[1]["text"] == "There are no pending tag proposals in the whole vault. Nothing changed."
