"""Web addresses in a note count for tag matching only by their site's name."""

from __future__ import annotations

import pytest

from app.services.tag_term_matching import note_text_for_tag_matching
from app.services.tag_term_matching import site_name_of_url


@pytest.mark.parametrize(("url", "site"), [
    ("https://www.youtube.com/watch?v=GYx4OBbswTw", "youtube"),
    ("http://en.wikipedia.org/wiki/Tag_(metadata)", "wikipedia"),
    ("https://docs.python.org/3/library/re.html", "python"),
    ("https://www.bbc.co.uk/news", "bbc"),
    ("www.github.com/evolvingstuff/metalist", "github"),
    ("https://m.facebook.com/", "facebook"),
    ("http://localhost:8000/notes", "localhost"),
    ("http://127.0.0.1:8443/", ""),
    ("http://[::1", ""),
])
def test_the_site_name_of_a_web_address(url: str, site: str) -> None:
    assert site_name_of_url(url) == site


def test_a_note_reads_its_links_as_site_names() -> None:
    assert note_text_for_tag_matching(
        "<p>Watch https://www.youtube.com/watch?v=GYx4 and (www.bbc.co.uk/news) today</p>",
    ) == "watch youtube and bbc today"
    # Addresses without a scheme or www are ordinary words: "indeed.com" names the tag indeed.com.
    assert note_text_for_tag_matching("<p>Applied on indeed.com</p>") == "applied on indeed com"
