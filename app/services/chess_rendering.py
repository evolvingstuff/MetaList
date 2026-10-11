"""The @chess renderer: a FEN position drawn as a board (docs/ui/content-formatting.md).

FEN (Forsyth-Edwards Notation) describes one position in one line, for example
the start: rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1. The first
field (piece placement) is required; the other five are optional, as is common
when positions are copied from puzzles. A FEN that does not parse is shown as
text with an "Invalid FEN" badge naming what is wrong, like @json and @csv.
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass
from typing import FrozenSet, Tuple

from app.services.structured_note_renderers import _copyable_attr, _extract_plain_text


_FILES = "abcdefgh"
_PIECE_NAMES = {"k": "king", "q": "queen", "r": "rook", "b": "bishop", "n": "knight", "p": "pawn"}
# The solid glyphs for both colours (coloured by CSS), each followed by U+FE0E so
# the pawn is never drawn as an emoji.
_PIECE_GLYPHS = {"k": "♚", "q": "♛", "r": "♜", "b": "♝", "n": "♞", "p": "♟"}
_TEXT_PRESENTATION = "︎"
_CASTLING_RE = re.compile(r"^(?:-|K?Q?k?q?)$")
_EN_PASSANT_RE = re.compile(r"^(?:-|[a-h][36])$")


@dataclass(frozen=True)
class ChessPosition:
    # ranks[0] is rank 8, ranks[7] is rank 1; each holds 8 squares, "" for empty.
    ranks: Tuple[Tuple[str, ...], ...]
    side_to_move: str
    castling: str
    en_passant: str
    fullmove: str


def parse_fen(raw_text: str) -> tuple[ChessPosition | None, str]:
    """Return (position, "") or (None, a message saying what to fix)."""
    if not isinstance(raw_text, str):
        raise TypeError("raw_text must be a string")
    fields = raw_text.split()
    if not fields:
        return None, "Write a FEN position, for example the start: rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    if len(fields) > 6:
        return None, "A FEN has at most 6 fields separated by spaces"
    ranks, message = _parse_placement(fields[0])
    if ranks is None:
        return None, message
    side_to_move = "-"
    if len(fields) >= 2:
        if fields[1] not in {"w", "b"}:
            return None, f"Side to move must be w or b, not {fields[1]}"
        side_to_move = fields[1]
    castling = "-"
    if len(fields) >= 3:
        if fields[2] == "" or not _CASTLING_RE.match(fields[2]):
            return None, f"Castling must be - or letters from KQkq in that order, not {fields[2]}"
        castling = fields[2]
    en_passant = "-"
    if len(fields) >= 4:
        if not _EN_PASSANT_RE.match(fields[3]):
            return None, f"En passant must be - or a square on rank 3 or 6 such as e3, not {fields[3]}"
        en_passant = fields[3]
    for index, name in ((4, "Halfmove clock"), (5, "Move number")):
        if len(fields) > index and not fields[index].isdigit():
            return None, f"{name} must be a whole number, not {fields[index]}"
    fullmove = "-"
    if len(fields) == 6:
        fullmove = fields[5]
    position = ChessPosition(
        ranks=ranks, side_to_move=side_to_move, castling=castling, en_passant=en_passant, fullmove=fullmove,
    )
    return position, ""


def _parse_placement(placement: str) -> tuple[Tuple[Tuple[str, ...], ...] | None, str]:
    rank_texts = placement.split("/")
    if len(rank_texts) != 8:
        return None, f"The position needs 8 ranks separated by /, not {len(rank_texts)}"
    ranks = []
    for index, rank_text in enumerate(rank_texts):
        rank_number = 8 - index
        squares: list[str] = []
        for char in rank_text:
            if char in "12345678":
                squares.extend([""] * int(char))
                continue
            if char.lower() not in _PIECE_NAMES:
                return None, f"Rank {rank_number} has {char!r}, which is not a piece (KQRBNP for White, kqrbnp for Black) or a count of empty squares"
            squares.append(char)
        if len(squares) != 8:
            return None, f"Rank {rank_number} covers {len(squares)} squares; each rank needs exactly 8"
        ranks.append(tuple(squares))
    return tuple(ranks), ""


def render_chess_meta(*, content_html: str, formatting_tags: FrozenSet[str], extra_classes: str) -> str:
    # Spans only (laid out as a grid by main.css), so a board is valid HTML both
    # as a whole note and inside a sentence (((@chess)) wrapper); titles describe
    # the board and each square (the note HTML policy allows title, not aria-label).
    raw_text = _extract_plain_text(content_html)
    copy_attr = _copyable_attr(formatting_tags, raw_text)
    position, message = parse_fen(raw_text)
    if position is None:
        return (
            f'<span class="meta-chess meta-chess-error"{copy_attr}>'
            f'<span class="meta-chess-badge" title="{html.escape(message, quote=True)}">Invalid FEN</span>'
            f'<span class="meta-chess-error-message">{html.escape(message, quote=False)}</span>'
            f'<span class="meta-chess-raw">{html.escape(raw_text.strip(), quote=False)}</span>'
            "</span>"
        )
    board_class = "meta-chess-board"
    if extra_classes:
        board_class = f"{board_class} {extra_classes}"
    caption = _describe_position(position)
    label = "Chess position"
    if caption:
        label = f"Chess position, {caption}"
    squares = [_render_rank(position.ranks[index], rank_number=8 - index) for index in range(8)]
    squares.append('<span class="meta-chess-corner"></span>')
    squares.extend(f'<span class="meta-chess-file">{file_letter}</span>' for file_letter in _FILES)
    caption_html = ""
    if caption:
        caption_html = f'<span class="meta-chess-caption">{html.escape(caption, quote=False)}</span>'
    return (
        f'<span class="meta-chess"{copy_attr}>'
        f'<span class="{board_class}" title="{html.escape(label, quote=True)}">{"".join(squares)}</span>'
        f"{caption_html}"
        "</span>"
    )


def _render_rank(squares: Tuple[str, ...], *, rank_number: int) -> str:
    cells = [f'<span class="meta-chess-rank">{rank_number}</span>']
    for file_index, piece in enumerate(squares):
        # a1 is a dark square.
        shade = "meta-chess-light"
        if (file_index + rank_number) % 2 == 1:
            shade = "meta-chess-dark"
        square_name = f"{_FILES[file_index]}{rank_number}"
        if piece == "":
            cells.append(f'<span class="meta-chess-square {shade}" title="{square_name}"></span>')
            continue
        colour = "black"
        if piece.isupper():
            colour = "white"
        name = _PIECE_NAMES[piece.lower()]
        glyph = _PIECE_GLYPHS[piece.lower()] + _TEXT_PRESENTATION
        cells.append(
            f'<span class="meta-chess-square {shade}" title="{square_name} {colour} {name}">'
            f'<span class="meta-chess-piece meta-chess-{colour}" aria-hidden="true">{glyph}</span></span>'
        )
    return "".join(cells)


def _describe_position(position: ChessPosition) -> str:
    parts: list[str] = []
    if position.side_to_move == "w":
        parts.append("White to move")
    if position.side_to_move == "b":
        parts.append("Black to move")
    if position.fullmove != "-":
        parts.append(f"move {position.fullmove}")
    if position.castling != "-":
        parts.append(f"castling {position.castling}")
    if position.en_passant != "-":
        parts.append(f"en passant {position.en_passant}")
    return " · ".join(parts)


__all__ = ["ChessPosition", "parse_fen", "render_chess_meta"]
