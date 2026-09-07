"""Geometry, safe rendering, and strict v3 schema tests using shared JS fixtures."""
import json
from pathlib import Path
import xml.etree.ElementTree as ET

import pytest

from app.services.embedded_documents import render_diagram_svg, validate_document
from app.services.diagram_vector import route_points, label_lines, rounded_path


FIXTURE = Path(__file__).parent.parent / "fixtures" / "diagram-v3.json"


def diagram():
    return json.loads(FIXTURE.read_text())


def test_routed_geometry_and_rich_label_match_browser_fixture():
    source = diagram()["source"]
    lookup = {shape["id"]: shape for shape in source["shapes"]}
    points = route_points(lookup, source["arrows"][0])
    assert points == [(160, 45), (250, 45), (250, 245), (400, 245)]
    assert " Q " in rounded_path(points)
    lines = label_lines(source["shapes"][0], 136)
    assert [''.join(char["text"] for char in line) for line in lines] == ["Hello world!", "MW 中文"]
    assert [sum(char["advance"] for char in line) for line in lines] == pytest.approx([110.550528, 82.495584])
    assert lines[0][-1]["bold"] is True
    assert lines[0][-1]["color"] == "#ff0000"
    svg = render_diagram_svg(diagram())
    assert 'font-weight="bold"' in svg
    assert 'font-style="italic"' in svg
    assert 'textLength=' in svg
    assert '<path ' in svg and '<polygon ' in svg
    ET.fromstring(svg)


def test_svg_free_arrows_have_heads_and_bounds_without_shapes():
    payload = diagram()
    source = payload["source"]
    source["shapes"] = []
    source["order"] = ["ab"]
    arrow = source["arrows"][0]
    arrow["start"] = {"kind": "free", "x": -600, "y": 0}
    arrow["end"] = {"kind": "free", "x": 0, "y": 800}
    arrow["points"] = [{"x": -600, "y": 800}]
    arrow["runs"] = []
    svg = render_diagram_svg(payload)
    assert 'viewBox="-640.0 -40.0 680.0 880.0"' in svg
    assert '<polygon ' in svg
    assert ' Q ' in svg


def test_formatted_text_is_escaped_and_drawing_order_is_respected():
    payload = diagram()
    payload["source"]["shapes"][0]["runs"][0]["text"] = '<script>&"'
    payload["source"]["order"] = ["a", "b", "ab"]
    svg = render_diagram_svg(payload)
    assert '<script>' not in svg
    assert '&lt;' in svg and '&amp;' in svg
    assert svg.index('<path ') > svg.index('rx="12"')
    ET.fromstring(svg)


@pytest.mark.parametrize("violation", ["missing_endpoint", "unknown_shape", "duplicate_id", "order", "group_overlap", "group_unknown", "unsafe_color", "text_limit", "nan", "too_many_points"])
def test_invalid_v3_sources_fail_at_boundary(violation):
    payload = diagram()
    source = payload["source"]
    if violation == "missing_endpoint":
        del source["arrows"][0]["start"]
    elif violation == "unknown_shape":
        source["arrows"][0]["end"]["shape_id"] = "outside"
    elif violation == "duplicate_id":
        source["shapes"][1]["id"] = "a"
    elif violation == "order":
        source["order"] = ["a", "a", "ab"]
    elif violation == "group_overlap":
        source["groups"] = [{"id": "g", "members": ["a", "b"]}, {"id": "h", "members": ["a", "ab"]}]
    elif violation == "group_unknown":
        source["groups"] = [{"id": "g", "members": ["a", "outside"]}]
    elif violation == "unsafe_color":
        source["shapes"][0]["runs"][0]["color"] = 'url(https://example.com/image)'
    elif violation == "text_limit":
        source["shapes"][0]["runs"][0]["text"] = "x" * 5001
    elif violation == "nan":
        source["shapes"][0]["x"] = float("nan")
    elif violation == "too_many_points":
        source["arrows"][0]["points"] = [{"x": 1, "y": 1}] * 257
    with pytest.raises(ValueError):
        validate_document(payload)
