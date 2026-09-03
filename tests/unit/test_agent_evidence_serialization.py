from app.services.agent.evidence_serialization import EvidenceNoteTokenSource
from app.services.agent.evidence_serialization import EvidenceTreeTokenSource
from app.services.agent.evidence_serialization import estimate_cached_root_tree_tokens
from app.services.agent.token_estimation import estimate_input_tokens


def test_lazy_root_tree_token_estimate_counts_nested_payload_and_metadata() -> None:
    root = EvidenceNoteTokenSource(
        note_id="root",
        content_text="Root content",
        explicit_tag_terms=("foo",),
        proposed_tag_terms=("machine-learning",),
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-02T00:00:00+00:00",
    )
    child = EvidenceNoteTokenSource(
        note_id="child",
        content_text="Child content",
        explicit_tag_terms=(),
        proposed_tag_terms=(),
        created_at="2026-01-03T00:00:00+00:00",
        updated_at="2026-01-04T00:00:00+00:00",
    )
    structure = (
        EvidenceTreeTokenSource(
            note_id="root",
            parent_id="",
            child_ids=("child",),
        ),
        EvidenceTreeTokenSource(
            note_id="child",
            parent_id="root",
            child_ids=(),
        ),
    )
    expected_tree = (
        {
            "note_id": "root",
            "content_text": "Root content",
            "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-02T00:00:00+00:00",
            "tags": ["foo"],
            "proposed_tags": ["machine-learning"],
            "children": [
                {
                    "note_id": "child",
                    "content_text": "Child content",
                    "created_at": "2026-01-03T00:00:00+00:00",
                    "updated_at": "2026-01-04T00:00:00+00:00",
                }
            ],
        },
    )

    expected_tokens = estimate_input_tokens(expected_tree)
    assert estimate_cached_root_tree_tokens(
        root_id="root",
        evidence_notes=(root, child),
        structure_nodes=structure,
    ) == expected_tokens
    assert estimate_cached_root_tree_tokens(
        root_id="root",
        evidence_notes=(child, root),
        structure_nodes=tuple(reversed(structure)),
    ) == expected_tokens
