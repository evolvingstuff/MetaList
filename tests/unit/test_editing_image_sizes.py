"""The size each inline image shows at while its note is edited: what the view
renders for it (docs/ui/content-formatting.md)."""

from app.services.editing_image_sizes import editing_image_size_factors

_IMAGE = '<img src="">'


def test_an_image_without_a_size_tag_is_full_size() -> None:
    assert editing_image_size_factors(content_html=f"<p>Photo {_IMAGE}</p>", tags="") == [1.0]


def test_an_image_takes_its_braces_size_tag() -> None:
    assert editing_image_size_factors(content_html=f"<p>Photo {{{_IMAGE}}}</p>", tags="{@size=0.25}") == [0.25]


def test_any_positive_size_counts_not_only_the_menu_steps() -> None:
    assert editing_image_size_factors(content_html=f"<p>{{{_IMAGE}}}</p>", tags="{@size=0.3}") == [0.3]


def test_each_image_has_its_own_size_and_images_share_their_braces_size() -> None:
    content = f"<p>{{{_IMAGE} and {_IMAGE}}} then {_IMAGE}</p>"
    assert editing_image_size_factors(content_html=content, tags="{@size=0.5}") == [0.5, 0.5, 1.0]


def test_nested_sizes_multiply_as_the_view_does() -> None:
    content = f"<p>{{outer [{_IMAGE}]}}</p>"
    assert editing_image_size_factors(content_html=content, tags="{@size=0.5} [@size=0.5]") == [0.25]


def test_a_note_without_images_has_no_sizes() -> None:
    assert editing_image_size_factors(content_html="<p>No images {here}</p>", tags="{@size=2}") == []


def test_saving_drops_the_editors_display_size() -> None:
    from app.security.note_html import sanitize_note_html
    stored = sanitize_note_html('<p><img src="data:image/png;base64,AAAA" style="--editing-image-size: 0.25; width: 10px"></p>')
    assert "editing-image-size" not in stored and "width" in stored, stored
