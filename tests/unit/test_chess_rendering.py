"""@chess draws a FEN position as a board (docs/ui/content-formatting.md, Chess)."""

import re

import pytest

from app.services.chess_rendering import parse_fen
from app.services.content_formatting import format_note_content_for_view
from app.services.content_formatting import list_known_meta_tag_terms

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def _render(content: str, tags: str) -> str:
    return format_note_content_for_view(content_html=f"<p>{content}</p>", tags=tags, redact_passwords=False)


def test_the_start_position_is_drawn_square_by_square() -> None:
    rendered = _render(START, "@chess")
    squares = re.findall(r'<span class="meta-chess-square (meta-chess-light|meta-chess-dark)" title="([a-h][1-8])([^"]*)"', rendered)
    assert len(squares) == 64
    by_square = {name: (shade, piece.strip()) for shade, name, piece in squares}
    # a1 is dark and h1 light; White's pieces are on ranks 1-2, Black's on 7-8.
    assert by_square["a1"] == ("meta-chess-dark", "white rook")
    assert by_square["h1"] == ("meta-chess-light", "white rook")
    assert by_square["e1"] == ("meta-chess-dark", "white king")
    assert by_square["d8"] == ("meta-chess-dark", "black queen")
    assert by_square["e4"] == ("meta-chess-light", "")
    assert rendered.count("meta-chess-piece meta-chess-white") == 16
    assert rendered.count("meta-chess-piece meta-chess-black") == 16
    # Ranks 8 to 1 down the side, files a to h along the bottom.
    assert re.findall(r'meta-chess-rank">(\d)<', rendered) == list("87654321")
    assert re.findall(r'meta-chess-file">([a-h])<', rendered) == list("abcdefgh")
    assert '<span class="meta-chess-caption">White to move · move 1 · castling KQkq</span>' in rendered


def test_pieces_never_render_as_emoji() -> None:
    rendered = _render(START, "@chess")
    assert "♟︎" in rendered
    assert "♟<" not in rendered


def test_the_caption_follows_the_fen_fields() -> None:
    after_e4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
    assert "Black to move · move 1 · castling KQkq · en passant e3" in _render(after_e4, "@chess")
    endgame = "8/8/8/8/8/8/8/K6k w - - 0 40"
    assert '<span class="meta-chess-caption">White to move · move 40</span>' in _render(endgame, "@chess")


def test_a_placement_alone_is_a_board_without_a_caption() -> None:
    rendered = _render("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR", "@chess")
    assert rendered.count("meta-chess-square") == 64
    assert "meta-chess-caption" not in rendered
    assert 'title="Chess position"' in rendered


@pytest.mark.parametrize(
    ("fen", "message"),
    [
        ("", "Write a FEN position"),
        ("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP", "The position needs 8 ranks separated by /, not 7"),
        ("rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR", "Rank 6 has '9', which is not a piece"),
        ("rnbqkbnr/ppppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR", "Rank 7 covers 9 squares; each rank needs exactly 8"),
        ("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBXKBNR", "Rank 1 has 'X', which is not a piece"),
        (START.replace(" w ", " x "), "Side to move must be w or b, not x"),
        (START.replace("KQkq", "QK"), "Castling must be - or letters from KQkq in that order, not QK"),
        (START.replace(" - 0", " e4 0"), "En passant must be - or a square on rank 3 or 6 such as e3, not e4"),
        (START.replace(" 0 1", " zero 1"), "Halfmove clock must be a whole number, not zero"),
        (START + " extra", "A FEN has at most 6 fields separated by spaces"),
    ],
)
def test_a_fen_that_does_not_parse_says_what_to_fix(fen: str, message: str) -> None:
    position, error = parse_fen(fen)
    assert position is None
    assert error.startswith(message)
    rendered = _render(fen, "@chess")
    assert '<span class="meta-chess-badge"' in rendered
    assert ">Invalid FEN</span>" in rendered
    assert "meta-chess-square" not in rendered


def test_invalid_input_is_shown_escaped() -> None:
    rendered = format_note_content_for_view(
        content_html="<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>", tags="@chess", redact_passwords=False,
    )
    assert "<script>" not in rendered
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in rendered


def test_a_wrapped_fen_draws_a_board_inside_the_sentence() -> None:
    # Spans only, so the paragraph is not split around the board.
    rendered = _render("Mate in one: ((8/8/8/8/8/8/8/K6k w - - 0 1)) Can you find it?", "((@chess))")
    assert rendered.startswith("<p>Mate in one: <span class=\"meta-chess\">")
    assert rendered.endswith(" Can you find it?</p>")
    assert "<div" not in rendered
    assert "<table" not in rendered


def test_chess_is_a_known_meta_tag() -> None:
    assert "@chess" in list_known_meta_tag_terms()
