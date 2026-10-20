from __future__ import annotations

import base64
import os
import random
import re
from collections import deque

import pytest
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

import app.services.content_cache as content_cache
import app.services.note_store as note_store_module
from app.services.content_formatting import _scan_tag_bar_tokens
from app.services.content_formatting import _tokenize_tag_bar
from app.services.embedded_references import _find_next_reference_token_start
from app.services.encryption import EncryptionService
from app.services.note_image_tags import _INLINE_IMAGE_RE
from app.services.note_image_tags import _contains_inline_image_markup
from app.services.note_store import NoteStore
from app.services.search_index import SearchIndex, SearchRecord
from app.services.tag_ontology import TagOntology
from app.utils.text_utils import HTMLStripper
from app.utils.text_utils import strip_html


class _FakeDatabase:
    def connection(self) -> object:
        return object()


def _cache_row(note_id: str, content: str, tags: str) -> dict[str, object]:
    return {
        "id": note_id,
        "content": content,
        "tags": tags,
        "proposed_tags": "",
        "encryption_nonce": None,
        "encryption_tag": None,
        "tags_encryption_nonce": None,
        "tags_encryption_tag": None,
        "proposed_tags_encryption_nonce": None,
        "proposed_tags_encryption_tag": None,
        "parent_id": None,
        "prev_id": None,
        "next_id": None,
        "is_collapsed": False,
        "created_at": None,
        "updated_at": None,
    }


def test_cache_hydration_sanitizes_and_extracts_text_once_per_note(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows = [
        _cache_row("one", "<div>One</div>", "alpha"),
        _cache_row("two", "<div>Two</div>", "beta"),
    ]
    sanitize_calls: list[str] = []
    strip_calls: list[str] = []

    def sanitize_once(content: str) -> str:
        sanitize_calls.append(content)
        return content

    def strip_once(content: str) -> str:
        strip_calls.append(content)
        return content.removeprefix("<div>").removesuffix("</div>")

    monkeypatch.setattr(content_cache, "iter_all_for_cache", lambda _connection: iter(rows))
    monkeypatch.setattr(content_cache, "count_notes", lambda _connection: len(rows))
    # The rows come from the stubs above; the fake connection is passed through as is.
    monkeypatch.setattr(content_cache, "raw_sqlite_connection", lambda connection: connection)
    monkeypatch.setattr(content_cache, "sanitize_note_html", sanitize_once)
    monkeypatch.setattr(content_cache, "strip_sanitized_html", strip_once)
    monkeypatch.setattr(content_cache, "_CACHE_TIMING_ENABLED", False)
    monkeypatch.setattr(content_cache, "_search_cache", {})
    monkeypatch.setattr(content_cache, "_tag_cache", {})
    monkeypatch.setattr(content_cache, "_proposed_tag_cache", {})
    monkeypatch.setattr(content_cache, "_text_cache", {})

    returned_rows = content_cache.populate_cache_from_db(_FakeDatabase())

    # Only each note's structure comes back: no content, tags or ciphertext stays held.
    assert returned_rows == [
        {"id": row["id"], "parent_id": None, "prev_id": None, "next_id": None,
         "is_collapsed": False, "created_at": None, "updated_at": None}
        for row in rows
    ]
    assert sanitize_calls == ["<div>One</div>", "<div>Two</div>"]
    assert strip_calls == ["<div>One</div>", "<div>Two</div>"]
    assert content_cache.get_cached_content("one") == "<div>One</div>"
    assert content_cache.get_cached_tags("two") == "beta"
    assert content_cache.get_cached_text("two") == "Two"


def test_note_store_reuses_plain_text_created_during_cache_hydration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows = [
        {
            "id": "one",
            "parent_id": None,
            "prev_id": None,
            "next_id": None,
            "is_collapsed": False, "created_at": None, "updated_at": None,
        }
    ]
    monkeypatch.setattr(note_store_module, "get_cached_content", lambda _note_id: "<div>One</div>")
    monkeypatch.setattr(note_store_module, "get_cached_tags", lambda _note_id: "alpha")
    monkeypatch.setattr(note_store_module, "get_cached_proposed_tags", lambda _note_id: "")
    monkeypatch.setattr(note_store_module, "get_cached_text", lambda _note_id: "One")
    monkeypatch.setattr(
        note_store_module,
        "strip_html",
        lambda _content: (_ for _ in ()).throw(AssertionError("plain text must be reused")),
    )
    monkeypatch.setattr(note_store_module, "get_ontology", TagOntology.empty)
    monkeypatch.setattr(note_store_module, "search_index", SearchIndex())

    store = NoteStore()
    store._timing_enabled = False
    store.load_from_db(None, prefetched_rows=rows)

    assert store.snapshot()["one"].content == "<div>One</div>"
    assert note_store_module.search_index.query_note_ids('"one"') == {"one"}


def test_text_search_uses_in_memory_text_without_eager_trigram_postings() -> None:
    index = SearchIndex()
    records = [
        SearchRecord(
            note_id="one",
            content_text="The quick brown fox",
            tags="animal",
            tag_terms=frozenset({"animal"}),
        ),
        SearchRecord(
            note_id="two",
            content_text="The slow green turtle",
            tags="animal",
            tag_terms=frozenset({"animal"}),
        ),
    ]
    index.rebuild(
        records,
        raw_tag_terms_by_id={"one": frozenset({"animal"}), "two": frozenset({"animal"})},
        progress_update=lambda _processed: None,
        progress_interval=1000,
    )

    assert index.query_note_ids('"quick brown"') == {"one"}
    assert index.query_note_ids('animal "green turtle"') == {"two"}
    assert index.query_note_ids('-"quick brown"') == {"two"}
    assert not hasattr(index, "_tri_notes")


def _cipher_decrypt(dek: bytes, ciphertext_base64: str, nonce: bytes, tag: bytes) -> str:
    decryptor = Cipher(algorithms.AES(dek), modes.GCM(nonce, tag)).decryptor()
    return (decryptor.update(base64.b64decode(ciphertext_base64)) + decryptor.finalize()).decode("utf-8")


@pytest.mark.parametrize("plaintext", ["", "plain", "<div>Unicode ✓ İı</div>" * 50])
def test_cached_aead_decrypt_matches_cipher_decrypt(plaintext: str) -> None:
    service = EncryptionService()
    service.dek = os.urandom(32)
    ciphertext, nonce, tag = service.encrypt(plaintext)

    assert service.decrypt(ciphertext, nonce, tag) == plaintext
    assert _cipher_decrypt(service.dek, ciphertext, nonce, tag) == plaintext


def test_cached_aead_decrypt_rejects_tampering_and_bad_tag_length() -> None:
    service = EncryptionService()
    service.dek = os.urandom(32)
    ciphertext, nonce, tag = service.encrypt("secret")

    with pytest.raises(InvalidTag):
        service.decrypt(ciphertext, nonce, bytes([tag[0] ^ 1]) + tag[1:])
    with pytest.raises(ValueError, match="GCM tag must be 16 bytes"):
        service.decrypt(ciphertext, nonce, tag[:12])


def test_cached_aead_never_outlives_its_dek() -> None:
    service = EncryptionService()
    service.dek = os.urandom(32)
    ciphertext, nonce, tag = service.encrypt("secret")
    assert service.decrypt(ciphertext, nonce, tag) == "secret"
    assert service._dek_aead is not None

    service.dek = os.urandom(32)
    assert service._dek_aead is None
    with pytest.raises(InvalidTag):
        service.decrypt(ciphertext, nonce, tag)

    service.clear_keys()
    assert service._dek_aead is None
    with pytest.raises(ValueError, match="No DEK set"):
        service.decrypt(ciphertext, nonce, tag)


_WHITESPACE_SAMPLES = [" ", "\t", "\n", "\r", "\x0b", "\x0c", "\x1c", "\x85", "\xa0", "\u2003", "\u3000"]


def test_strip_html_whitespace_collapse_matches_regex_collapse() -> None:
    rng = random.Random(7)
    alphabet = ["a", "B", "<b>", "</b>", "<p>", "<br/>", "&amp;", "✓"] + _WHITESPACE_SAMPLES
    for _ in range(2000):
        html_content = "".join(rng.choice(alphabet) for _ in range(rng.randint(1, 30)))
        stripper = HTMLStripper()
        stripper.feed(html_content)
        expected = re.sub(r"\s+", " ", stripper.get_data()).strip()
        assert strip_html(html_content) == expected


def _linear_reference_token_start(text: str, start: int) -> tuple[int | None, int, bool]:
    index = start
    while index < len(text):
        if text.startswith("![[", index):
            return index, 3, True
        if text.startswith("[[", index):
            return index, 2, False
        index += 1
    return None, 0, False


def test_reference_token_start_matches_character_scan() -> None:
    rng = random.Random(11)
    for _ in range(3000):
        text = "".join(rng.choice("![]x") for _ in range(rng.randint(0, 12)))
        for start in range(len(text) + 1):
            assert _find_next_reference_token_start(text=text, start=start) == _linear_reference_token_start(text, start)


def test_inline_image_prefilter_matches_case_insensitive_regex() -> None:
    rng = random.Random(13)
    pieces = ["<", "img", "IMG", "Img", "\u0130mg", "\u0131mg", " ", "/", ">", "data:", "DATA:", "image/", "IMAGE/", "png", "x"]
    for _ in range(5000):
        content = "".join(rng.choice(pieces) for _ in range(rng.randint(0, 8)))
        assert _contains_inline_image_markup(content) == (_INLINE_IMAGE_RE.search(content) is not None)
    assert _contains_inline_image_markup("<\u0131mg/>")
    assert _contains_inline_image_markup("<\u0130MG src=x>")


def test_plain_tag_bar_fast_path_matches_scanner() -> None:
    rng = random.Random(17)
    alphabet = ["a", "Tag", "@red", "-", "*", "/", ")", "]", "}"] + _WHITESPACE_SAMPLES
    for _ in range(3000):
        tags = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 15)))
        assert _tokenize_tag_bar(tags) == _scan_tag_bar_tokens(tags)
    assert _tokenize_tag_bar("a {{@bold b}} /* note */ c") == ["a", "{{@bold b}}", "c"]


def _worklist_propagate(
    dependencies: dict[str, set[str]], accepted: dict[str, frozenset[str]], proposed: dict[str, frozenset[str]],
) -> None:
    """The previous arbitrary-order worklist fixed point, kept as the reference."""
    dependents: dict[str, set[str]] = {note_id: set() for note_id in dependencies}
    for note_id, sources in dependencies.items():
        for source_id in sources:
            if source_id in dependencies:
                dependents[source_id].add(note_id)
            else:
                accepted[note_id] |= accepted[source_id]
                proposed[note_id] |= proposed[source_id]
    pending = deque(dependencies)
    queued = set(dependencies)
    while pending:
        source_id = pending.popleft()
        queued.remove(source_id)
        for note_id in dependents[source_id]:
            next_accepted = accepted[note_id] | accepted[source_id]
            next_proposed = proposed[note_id] | proposed[source_id]
            if next_accepted == accepted[note_id] and next_proposed == proposed[note_id]:
                continue
            accepted[note_id] = next_accepted
            proposed[note_id] = next_proposed
            if note_id not in queued:
                pending.append(note_id)
                queued.add(note_id)


def test_component_propagation_matches_worklist_fixed_point() -> None:
    rng = random.Random(19)
    for _ in range(300):
        node_count = rng.randint(1, 30)
        nodes = [f"n{index}" for index in range(node_count)]
        external = [f"x{index}" for index in range(3)]
        affected = rng.sample(nodes, rng.randint(1, node_count))
        dependencies = {
            note_id: set(rng.sample(nodes + external, rng.randint(0, min(4, node_count))))
            for note_id in affected
        }
        terms = {note_id: frozenset(rng.sample("abcdefgh", rng.randint(0, 3))) for note_id in nodes + external}
        proposed = {note_id: frozenset(rng.sample("PQRS", rng.randint(0, 1))) for note_id in nodes + external}
        expected_accepted, expected_proposed = dict(terms), dict(proposed)
        _worklist_propagate(dependencies, expected_accepted, expected_proposed)

        NoteStore._propagate_tag_dependencies_locked(dependencies, terms, proposed)

        assert terms == expected_accepted
        assert proposed == expected_proposed


def test_component_order_handles_deep_chains_without_recursion() -> None:
    depth = 3_000  # beyond the default recursion limit
    dependencies = {f"n{index}": ({f"n{index - 1}"} if index else set()) for index in range(depth)}
    accepted = {note_id: frozenset({note_id}) for note_id in dependencies}
    proposed = {note_id: frozenset() for note_id in dependencies}

    NoteStore._propagate_tag_dependencies_locked(dependencies, accepted, proposed)

    assert len(accepted[f"n{depth - 1}"]) == depth
