"""Theme persistence boundaries and deterministic SVG presentation."""
import json
from pathlib import Path
import re

import pytest

from app.services.embedded_documents import render_diagram_svg, validate_document
from app.services.diagram_theme import sketch_path, diagram_theme, ink_outline


def fixture():
    payload = json.loads((Path(__file__).parent.parent / 'fixtures' / 'diagram-v3.json').read_text())
    payload['version'] = 4
    payload['source']['theme'] = 'hand-drawn'
    return payload


def test_theme_changes_pen_strokes_paper_and_font_without_mutating_source():
    payload = fixture()
    before = json.dumps(payload, sort_keys=True)
    svg = render_diagram_svg(payload)
    assert svg == render_diagram_svg(payload)
    assert 'Comic Sans MS' in svg
    assert 'fill="#ffffff"' in svg
    assert 'stroke-linecap="round"' in svg
    assert 'data-sketch-ink="true"' in svg
    assert json.dumps(payload, sort_keys=True) == before
    payload['source']['theme'] = 'clean'
    clean = render_diagram_svg(payload)
    assert 'Comic Sans MS' not in clean
    assert 'font-family="sans-serif"' in clean
    assert 'data-sketch-ink="true"' not in clean
    assert clean != svg


@pytest.mark.parametrize('violation', ['missing', 'unknown'])
def test_v4_requires_a_known_theme(violation):
    payload = fixture()
    if violation == 'missing':
        del payload['source']['theme']
    else:
        payload['source']['theme'] = 'unknown'
    with pytest.raises(ValueError):
        validate_document(payload)


def test_legacy_v3_stays_clean_and_does_not_gain_persisted_fields():
    payload = fixture()
    payload['version'] = 3
    del payload['source']['theme']
    assert validate_document(payload) == payload
    assert diagram_theme(payload['source'])['name'] == 'clean'
    assert 'Comic Sans MS' not in render_diagram_svg(payload)


def test_pen_paths_keep_endpoints_and_bends_and_are_repeatable():
    path = 'M 0 0 L 120 0 Q 130 0 130 10 L 130 90'
    first = sketch_path(path, 'sample', 0)
    assert first == sketch_path(path, 'sample', 0)
    assert first != sketch_path(path, 'sample', 1)
    assert first.startswith('M 0.0 0.0 C ')
    assert 'Q 130.0 0.0 130.0 10.0 C' in first
    assert first.endswith('130.0 90.0')


def test_hand_drawn_fill_follows_the_irregular_outline():
    svg = render_diagram_svg(fixture())
    assert 'data-sketch-fill="true"' in svg


def test_long_pen_strokes_use_one_continuous_gesture():
    path = sketch_path('M 0 0 L 600 0', 'long-arrow', 0)
    assert path.count('C ') == 1
    assert path.endswith('600.0 0.0')


def test_ink_pressure_changes_width_along_a_stroke():
    path = 'M 0 0 C 200 0 400 0 600 0'
    outline = ink_outline(path, 'pressure', 2)
    assert outline == ink_outline(path, 'pressure', 2)
    assert outline.endswith(' Z')
    coordinates = [float(value) for value in re.findall(r'[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?', outline)]
    radii = [abs(value) for value in coordinates[1::2]]
    assert min(radii) * 1.1 < max(radii) < min(radii) * 1.5
    assert ink_outline('M 0 0', 'empty', 2) == ''
