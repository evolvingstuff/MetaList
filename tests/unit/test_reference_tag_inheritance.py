from types import SimpleNamespace
from random import Random

import pytest

import app.services.note_store as note_store_module
from app.services.note_store import NoteStore
from app.services.search_index import SearchIndex
from app.services.tag_ontology import TagOntology, compile_rules, parse_rules_text
import app.services.snapshot as snapshot_module


SOURCE = "11111111-1111-4111-8111-111111111111"
HOST = "22222222-2222-4222-8222-222222222222"
CHILD = "33333333-3333-4333-8333-333333333333"
OTHER = "44444444-4444-4444-8444-444444444444"
PARENT = "55555555-5555-4555-8555-555555555555"


def _load(monkeypatch, specs):
    """Specs map IDs to (parent, content, accepted tags, proposed tags)."""
    children = {}
    for note_id, (parent, _, _, _) in specs.items():
        if parent not in children:
            children[parent] = []
        children[parent].append(note_id)
    rows = []
    for note_id, (parent, _, _, _) in specs.items():
        siblings = children[parent]
        position = siblings.index(note_id)
        prev_id = None
        next_id = None
        if position > 0:
            prev_id = siblings[position - 1]
        if position + 1 < len(siblings):
            next_id = siblings[position + 1]
        rows.append(dict(id=note_id, parent_id=parent, is_collapsed=False,
                         prev_id=prev_id, next_id=next_id))
    index = SearchIndex()
    monkeypatch.setattr(note_store_module, "search_index", index)
    monkeypatch.setattr(note_store_module, "get_ontology", TagOntology.empty)
    monkeypatch.setattr(note_store_module, "get_cached_content", lambda n: specs[n][1])
    monkeypatch.setattr(note_store_module, "get_cached_text", lambda n: specs[n][1])
    monkeypatch.setattr(note_store_module, "get_cached_tags", lambda n: specs[n][2])
    monkeypatch.setattr(note_store_module, "get_cached_proposed_tags", lambda n: specs[n][3])
    store = NoteStore()
    store._timing_enabled = False
    store.load_from_db(None, prefetched_rows=rows)
    return store, index


@pytest.mark.parametrize("prefix", ["", "!"])
def test_reference_search_stops_at_source_ancestors_and_includes_source_descendants(monkeypatch, prefix):
    store, index = _load(monkeypatch, {
        PARENT: (None, "foo", "ancestor", "ancestor-proposal"),
        SOURCE: (PARENT, "bar", "source", ""),
        CHILD: (SOURCE, "baz", "descendant @red /*comment*/", "descendant-proposal"),
        HOST: (None, f"{prefix}[[{SOURCE}]]", "", ""),
    })
    assert index.query_note_ids("ancestor") == {PARENT, SOURCE, CHILD}
    assert index.query_note_ids("ancestor-proposal") == {PARENT, SOURCE, CHILD}
    assert index.query_note_ids("descendant") == {CHILD, HOST}
    assert index.query_note_ids("descendant-proposal") == {CHILD, HOST}
    assert index.query_note_ids("@red") == {CHILD}
    assert store.get_inherited_non_meta_tag_terms(HOST) == {"source", "descendant"}
    assert store.get_inherited_proposed_non_meta_tag_terms(HOST) == {"descendant-proposal"}
    store.update_note_from_db(SimpleNamespace(id=CHILD), "baz", "replacement", "")
    assert index.query_note_ids("descendant") == set()
    assert index.query_note_ids("descendant-proposal") == set()
    assert index.query_note_ids("replacement") == {CHILD, HOST}


def test_descendant_tag_search_renders_referenced_subtree(monkeypatch):
    store, index = _load(monkeypatch, {
        PARENT: (None, "foo", "ancestor", ""),
        SOURCE: (PARENT, "bar", "", ""),
        CHILD: (SOURCE, "baz", "descendant", ""),
        HOST: (None, f"![[{SOURCE}]]", "", ""),
    })
    monkeypatch.setattr(snapshot_module, "note_store", store)
    monkeypatch.setattr(snapshot_module, "search_index", index)
    monkeypatch.setattr(snapshot_module, "get_all_locks", lambda: {})
    state = snapshot_module.build_view_state(
        editing_note_id=None, search="descendant", sort_mode="normal",
        client_known_note_ids=set(), client_seen_root_ids=set(),
        anchor_root_id=None, is_untagged_view=False,
    )
    assert HOST in state.payloads
    rendered = state.payloads[HOST]["content"]
    assert f'data-embed-note-id="{SOURCE}"' in rendered
    assert f'data-embed-note-id="{CHILD}"' in rendered
    assert "bar" in rendered and "baz" in rendered
    assert state.payloads[HOST]["metadata"]["inheritedTags"] == ["descendant"]


@pytest.mark.parametrize("bulk", [False, True])
def test_moving_descendant_updates_references_to_old_and_new_subtrees(monkeypatch, bulk):
    store, index = _load(monkeypatch, {
        SOURCE: (None, "bar", "", ""),
        CHILD: (SOURCE, "baz", "descendant", ""),
        OTHER: (None, "New source", "", ""),
        HOST: (None, f"![[{SOURCE}]]", "", ""),
        PARENT: (None, f"![[{OTHER}]]", "", ""),
    })
    assert index.query_note_ids("descendant") == {CHILD, HOST}
    move = SimpleNamespace(id=CHILD, parent_id=OTHER, prev_id=None, next_id=None)
    if bulk:
        store.bulk_update_metadata([move], rebuild=False)
    else:
        store.update_metadata_from_db(move, rebuild=False)
    assert index.query_note_ids("descendant") == {CHILD, PARENT}
    store.rebuild_search_index_tag_terms()
    assert index.query_note_ids("descendant") == {CHILD, PARENT}


def test_deleted_and_restored_descendant_updates_subtree_references(monkeypatch):
    store, index = _load(monkeypatch, {
        SOURCE: (None, "bar", "", ""),
        CHILD: (SOURCE, "baz", "descendant", ""),
        HOST: (None, f"![[{SOURCE}]]", "", ""),
    })
    assert index.query_note_ids("descendant") == {CHILD, HOST}
    store.remove_note(CHILD)
    assert index.query_note_ids("descendant") == set()
    store.add_note_from_db(SimpleNamespace(id=CHILD, parent_id=SOURCE, prev_id=None, next_id=None),
                           "Restored baz", "restored", "")
    assert index.query_note_ids("restored") == {CHILD, HOST}


def test_subtree_reference_cycle_clears_removed_accepted_and_proposed_tags(monkeypatch):
    store, index = _load(monkeypatch, {
        SOURCE: (None, "bar", "", ""),
        CHILD: (SOURCE, f"baz ![[{SOURCE}]]", "descendant", "proposal"),
        HOST: (None, f"![[{SOURCE}]]", "", ""),
    })
    assert index.query_note_ids("descendant proposal") == {CHILD, HOST}
    store.update_note_from_db(SimpleNamespace(id=CHILD), f"baz ![[{SOURCE}]]", "", "")
    assert index.query_note_ids("descendant") == set()
    assert index.query_note_ids("proposal") == set()
    assert store.get_inherited_non_meta_tag_terms(HOST) == set()
    assert store.get_inherited_proposed_non_meta_tag_terms(HOST) == set()


def test_descendant_edit_does_not_reindex_source_ancestors_or_siblings(monkeypatch):
    store, index = _load(monkeypatch, {
        SOURCE: (None, "bar", "source", ""),
        CHILD: (SOURCE, "baz", "descendant", ""),
        OTHER: (SOURCE, "Sibling", "sibling", ""),
        HOST: (None, f"![[{SOURCE}]]", "", ""),
    })
    affected_sets = []
    original = store._propagate_inherited_tag_terms_locked

    def track(affected):
        affected_sets.append(affected)
        return original(affected)

    monkeypatch.setattr(store, "_propagate_inherited_tag_terms_locked", track)
    store.update_note_from_db(SimpleNamespace(id=CHILD), "baz", "replacement", "")
    assert affected_sets == [{CHILD, HOST}]
    assert index.query_note_ids("replacement") == {CHILD, HOST}
    assert index.query_note_ids("source") == {SOURCE, CHILD, OTHER, HOST}


@pytest.mark.parametrize("prefix", ["", "!"])
def test_reference_tags_reach_host_and_children_on_hydration(monkeypatch, prefix):
    store, index = _load(monkeypatch, {
        PARENT: (None, "Parent", "ancestor", ""),
        SOURCE: (PARENT, "Source text", "foo @red /*comment*/", "suggestion"),
        HOST: (None, f"{prefix}[[{SOURCE}]]", "host-tag", ""),
        CHILD: (HOST, "Child", "", ""),
        OTHER: (None, "Other", "", ""),
    })
    assert index.query_note_ids("foo") == {SOURCE, HOST, CHILD}
    assert index.query_note_ids("foo host-tag") == {HOST, CHILD}
    assert index.query_note_ids("ancestor") == {PARENT, SOURCE}
    assert index.query_note_ids("suggestion") == {SOURCE, HOST, CHILD}
    assert index.query_note_ids("-foo") == {PARENT, OTHER}
    assert index.query_note_ids("@red") == {SOURCE}
    assert index.query_note_ids('"Source text"') == {SOURCE}
    assert store.get_inherited_non_meta_tag_terms(HOST) == {"foo"}
    assert store.get_inherited_non_meta_tag_terms(CHILD) == {"foo", "host-tag"}
    assert store.get_inherited_proposed_non_meta_tag_terms(CHILD) == {"suggestion"}


def test_edits_update_reference_dependents_and_remove_old_hits(monkeypatch):
    store, index = _load(monkeypatch, {
        SOURCE: (None, "Source", "foo", ""),
        HOST: (None, f"[[{SOURCE}]]", "", ""),
        CHILD: (HOST, "Child", "", ""),
        OTHER: (None, "Other", "bar", ""),
    })
    store.update_note_from_db(SimpleNamespace(id=SOURCE), "Source", "new-tag", "")
    assert index.query_note_ids("foo") == set()
    assert index.query_note_ids("new-tag") == {SOURCE, HOST, CHILD}
    store.update_note_from_db(SimpleNamespace(id=HOST), f"[[{OTHER}]]", "", "")
    assert index.query_note_ids("new-tag") == {SOURCE}
    assert index.query_note_ids("bar") == {OTHER, HOST, CHILD}
    store.update_note_from_db(SimpleNamespace(id=HOST), "No reference", "", "")
    assert index.query_note_ids("bar") == {OTHER}


def test_chains_cycles_and_tag_removal_reach_least_fixed_point(monkeypatch):
    store, index = _load(monkeypatch, {
        SOURCE: (None, f"[[{HOST}]]", "foo", ""),
        HOST: (None, f"[[{SOURCE}]]", "bar", ""),
        CHILD: (HOST, "Child", "", ""),
        OTHER: (None, f"[[{CHILD}]]", "", ""),
    })
    assert index.query_note_ids("foo bar") == {SOURCE, HOST, CHILD}
    store.update_note_from_db(SimpleNamespace(id=SOURCE), f"[[{HOST}]]", "", "")
    assert index.query_note_ids("foo") == set()
    assert index.query_note_ids("bar") == {SOURCE, HOST, CHILD}
    store.update_note_from_db(SimpleNamespace(id=HOST), "No reference", "", "")
    assert index.query_note_ids("bar") == set()


def test_bulk_tags_and_formatting_scopes_update_edges(monkeypatch):
    store, index = _load(monkeypatch, {
        SOURCE: (None, "Source", "foo", ""),
        HOST: (None, f"[[{SOURCE}]]", "[[@red]]", ""),
        CHILD: (HOST, "Child", "", ""),
    })
    assert index.query_note_ids("foo") == {SOURCE}
    store.apply_bulk_tag_sources({HOST: ("", ""), SOURCE: ("bar", "pending")})
    assert index.query_note_ids("bar pending") == {SOURCE, HOST, CHILD}
    assert index.query_note_ids("foo") == set()
    store.apply_bulk_tag_sources({HOST: ("[[@red]]", "")})
    assert index.query_note_ids("bar") == {SOURCE}


def test_deleted_and_restored_source_updates_surviving_referrers(monkeypatch):
    store, index = _load(monkeypatch, {
        SOURCE: (None, "Source", "foo", ""),
        HOST: (None, f"[[{SOURCE}]]", "", ""),
        CHILD: (HOST, "Child", "", ""),
    })
    store.remove_note(SOURCE)
    assert index.query_note_ids("foo") == set()
    store.add_note_from_db(SimpleNamespace(id=SOURCE, parent_id=None, prev_id=HOST, next_id=None),
                           "Restored", "restored-tag", "")
    assert index.query_note_ids("restored-tag") == {SOURCE, HOST, CHILD}
    store.remove_note(HOST)
    assert index.query_note_ids("restored-tag") == {SOURCE}


def test_new_child_inherits_reference_tags(monkeypatch):
    store, index = _load(monkeypatch, {
        SOURCE: (None, "Source", "foo", ""),
        HOST: (None, f"[[{SOURCE}]]", "", ""),
    })
    store.add_note_from_db(SimpleNamespace(id=CHILD, parent_id=HOST, prev_id=None, next_id=None),
                           "New child", "", "")
    assert index.query_note_ids("foo") == {SOURCE, HOST, CHILD}


@pytest.mark.parametrize("bulk", [False, True])
def test_moving_source_or_referrer_updates_both_paths(monkeypatch, bulk):
    store, index = _load(monkeypatch, {
        PARENT: (None, "Parent", "foo", ""),
        SOURCE: (PARENT, "Source", "", ""),
        OTHER: (None, "Other", "bar", ""),
        HOST: (None, f"[[{SOURCE}]]", "", ""),
        CHILD: (HOST, "Child", "", ""),
    })
    move = SimpleNamespace(id=SOURCE, parent_id=OTHER, prev_id=None, next_id=None)
    if bulk:
        store.bulk_update_metadata([move], rebuild=False)
    else:
        store.update_metadata_from_db(move, rebuild=False)
    assert index.query_note_ids("foo") == {PARENT}
    assert index.query_note_ids("bar") == {OTHER, SOURCE}
    # Moving the child away stops parent-derived contributions.
    move = SimpleNamespace(id=CHILD, parent_id=PARENT, prev_id=None, next_id=None)
    if bulk:
        store.bulk_update_metadata([move], rebuild=False)
    else:
        store.update_metadata_from_db(move, rebuild=False)
    assert index.query_note_ids("foo") == {PARENT, CHILD}
    assert index.query_note_ids("bar") == {OTHER, SOURCE}


def test_reference_to_descendant_forms_valid_cycle_without_stale_tags(monkeypatch):
    store, index = _load(monkeypatch, {
        HOST: (None, f"[[{CHILD}]]", "foo", ""),
        CHILD: (HOST, "Child", "bar", ""),
    })
    assert index.query_note_ids("foo bar") == {HOST, CHILD}
    store.update_note_from_db(SimpleNamespace(id=CHILD), "Child", "", "")
    assert index.query_note_ids("bar") == set()
    assert index.query_note_ids("foo") == {HOST, CHILD}


def test_parent_cycles_still_fail_loudly(monkeypatch):
    store, _ = _load(monkeypatch, {
        HOST: (None, "Parent", "foo", ""),
        CHILD: (HOST, "Child", "bar", ""),
    })
    with pytest.raises(RuntimeError, match="hierarchy cycle"):
        store.update_metadata_from_db(
            SimpleNamespace(id=HOST, parent_id=CHILD, prev_id=None, next_id=None),
            rebuild=False,
        )


def test_only_affected_notes_recompute_and_plain_edits_and_collapse_reuse_cache(monkeypatch):
    store, index = _load(monkeypatch, {
        SOURCE: (None, "Source", "foo", ""),
        HOST: (None, f"[[{SOURCE}]] [[{SOURCE}]]", "", ""),
        CHILD: (HOST, "Child", "", ""),
        OTHER: (None, "Unrelated", "unrelated", ""),
    })
    affected_sets = []
    original = store._propagate_inherited_tag_terms_locked

    def track(affected):
        affected_sets.append(affected)
        return original(affected)

    monkeypatch.setattr(store, "_propagate_inherited_tag_terms_locked", track)
    store.update_note_from_db(SimpleNamespace(id=SOURCE), "Source", "bar", "")
    assert affected_sets == [{SOURCE, HOST, CHILD}]
    affected_sets.clear()
    store.set_collapsed(HOST, True)
    store.set_collapsed(HOST, False)
    store.update_note_from_db(SimpleNamespace(id=HOST), f"Text [[{SOURCE}]]", "", "")
    assert affected_sets == []
    assert index.query_note_ids("bar") == {SOURCE, HOST, CHILD}
    assert store.get_backlink_counts(SOURCE) == {HOST: 1}


def test_search_snapshot_shows_references_and_inherited_metadata(monkeypatch):
    store, index = _load(monkeypatch, {
        SOURCE: (None, "Source", "foo", ""),
        HOST: (None, f"[[{SOURCE}]]", "", ""),
        CHILD: (HOST, "Child", "", ""),
        OTHER: (None, "Unrelated", "", ""),
    })
    monkeypatch.setattr(snapshot_module, "note_store", store)
    monkeypatch.setattr(snapshot_module, "search_index", index)
    monkeypatch.setattr(snapshot_module, "get_all_locks", lambda: {})
    state = snapshot_module.build_view_state(
        editing_note_id=None, search="foo", sort_mode="normal",
        client_known_note_ids=set(), client_seen_root_ids=set(),
        anchor_root_id=None, is_untagged_view=False,
    )
    assert set(state.payloads) == {SOURCE, HOST, CHILD}
    assert state.payloads[HOST]["metadata"]["inheritedTags"] == ["foo"]
    assert state.payloads[CHILD]["metadata"]["inheritedTags"] == ["foo"]
    untagged = snapshot_module.build_view_state(
        editing_note_id=None, search=None, sort_mode="normal",
        client_known_note_ids=set(), client_seen_root_ids=set(),
        anchor_root_id=None, is_untagged_view=True,
    )
    assert set(untagged.payloads) == {OTHER}


def test_ontology_applies_to_reference_tags_using_each_notes_own_text(monkeypatch):
    store, index = _load(monkeypatch, {
        SOURCE: (None, "Source", "foo", ""),
        HOST: (None, f"Special [[{SOURCE}]]", "", ""),
        CHILD: (HOST, "Child", "", ""),
    })
    ontology = compile_rules(
        rules=parse_rules_text(text='foo => category\n(foo "special") => matched', filename="test"),
        filename="test",
    )
    monkeypatch.setattr(note_store_module, "get_ontology", lambda: ontology)
    store.rebuild_search_index_tag_terms()
    assert index.query_note_ids("category") == {SOURCE, HOST, CHILD}
    assert index.query_note_ids("matched") == {HOST}
    store.update_note_from_db(SimpleNamespace(id=SOURCE), "Source", "", "")
    assert index.query_note_ids("category") == set()
    assert index.query_note_ids("matched") == set()


@pytest.mark.parametrize("seed", [714, 715, 716])
def test_incremental_graph_updates_match_independent_reachability_oracle(monkeypatch, seed):
    random = Random(seed)
    ids = [f"{n:08x}-1111-4111-8111-111111111111" for n in range(16)]
    specs = {}
    dependencies = {}
    own_tags = {}
    for n, note_id in enumerate(ids):
        parent = None
        if n % 2:
            parent = ids[n - 1]
        targets = set(random.sample(ids, 2))
        dependencies[note_id] = targets - {note_id}
        own_tags[note_id] = {f"tag-{n % 4}"}
        specs[note_id] = (parent, " ".join(f"[[{target}]]" for target in targets),
                          f"tag-{n % 4}", "")
    store, index = _load(monkeypatch, specs)

    def assert_matches_oracle():
        for note_id in ids:
            visited = set()
            pending = []
            expected = set()
            # Canonical ancestry supplies direct tags and reference entry points.
            current = note_id
            while current is not None:
                expected.update(own_tags[current])
                pending.extend(dependencies[current])
                current = specs[current][0]
            # Once inside a reference, walk downward and through further links.
            while pending:
                current = pending.pop()
                if current in visited:
                    continue
                visited.add(current)
                expected.update(own_tags[current])
                pending.extend(dependencies[current])
                pending.extend(child for child in ids if specs[child][0] == current)
            assert index.list_raw_tag_terms_for_note(note_id) == expected

    assert_matches_oracle()
    for _ in range(60):
        note_id = random.choice(ids)
        targets = set(random.sample(ids, random.randrange(3)))
        tags = set(random.sample(["tag-0", "tag-1", "tag-2", "tag-3"], random.randrange(2)))
        dependencies[note_id] = targets - {note_id}
        own_tags[note_id] = tags
        content = " ".join(f"[[{target}]]" for target in targets)
        specs[note_id] = (specs[note_id][0], content, " ".join(tags), "")
        store.update_note_from_db(SimpleNamespace(id=note_id), content, " ".join(tags), "")
        assert_matches_oracle()
    store.rebuild_search_index_tag_terms()
    assert_matches_oracle()
