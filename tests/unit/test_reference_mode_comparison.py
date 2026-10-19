"""Switching a reference between link ([[id]]) and embed (![[id]]) is not a text change."""

from __future__ import annotations

import pytest

from app.services.embedded_references import normalize_reference_modes_for_comparison


TARGET_ID = "22222222-2222-2222-2222-222222222222"
OTHER_ID = "33333333-3333-3333-3333-333333333333"


@pytest.mark.parametrize(("before", "after", "equivalent"), [
    (f"<p>[[{TARGET_ID}]] ![[{OTHER_ID}]]</p>", f"<p>![[{TARGET_ID}]] [[{OTHER_ID}]]</p>", True),
    (f"<p>[[{TARGET_ID}]]</p>", f"<p>![[{OTHER_ID}]]</p>", False),
    (f"<p>[[{TARGET_ID}]]</p>", f"<p>word ![[{TARGET_ID}]]</p>", False),
    ("<p>[[not-a-reference]]</p>", "<p>![[not-a-reference]]</p>", False),
    (f'<p title="[[{TARGET_ID}]]">text</p>', f'<p title="![[{TARGET_ID}]]">text</p>', False),
])
def test_reference_mode_comparison_preserves_other_content(before, after, equivalent):
    assert (normalize_reference_modes_for_comparison(before) == normalize_reference_modes_for_comparison(after)) is equivalent
