"""Safe SVG presentation for validated diagram-v2 documents."""
from html import escape
import math


def edge_point(shape: dict, toward: tuple[float, float]) -> tuple[float, float]:
    cx, cy = shape["x"] + shape["width"] / 2, shape["y"] + shape["height"] / 2
    dx, dy = toward[0] - cx, toward[1] - cy
    if dx == 0 and dy == 0:
        return cx, cy
    rx, ry = shape["width"] / 2, shape["height"] / 2
    if shape["type"] == "ellipse":
        scale = 1 / math.hypot(dx / rx, dy / ry)
    elif shape["type"] == "diamond":
        scale = 1 / (abs(dx) / rx + abs(dy) / ry)
    else:
        scale = 1 / max(abs(dx) / rx, abs(dy) / ry)
    return cx + dx * scale, cy + dy * scale


def diagram_bounds(shapes: list[dict]) -> tuple[float, float, float, float]:
    if not shapes:
        return 0, 0, 900, 540
    left = min(shape["x"] for shape in shapes) - 40
    top = min(shape["y"] for shape in shapes) - 40
    right = max(shape["x"] + shape["width"] for shape in shapes) + 40
    bottom = max(shape["y"] + shape["height"] for shape in shapes) + 40
    return left, top, right - left, bottom - top


def wrap_label(shape: dict) -> list[str]:
    """Use the same deterministic wrapping as the browser preview."""
    columns = max(1, int((shape["width"] - 24) / (shape["font_size"] * 0.6)))
    lines = []
    for paragraph in shape["label"].split("\n"):
        if not paragraph.strip():
            lines.append("")
            continue
        line = ""
        for word in paragraph.split():
            if line and len(line) + 1 + len(word) > columns:
                lines.append(line)
                line = ""
            while len(word) > columns:
                lines.append(word[:columns])
                word = word[columns:]
            if line:
                line += " " + word
            else:
                line = word
        if line:
            lines.append(line)
    max_lines = max(1, int((shape["height"] - 12) / (shape["font_size"] * 1.25)))
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = lines[-1][:-1] + "…"
    return lines


def _shape_svg(shape: dict) -> str:
    x, y, width, height = (shape[key] for key in ("x", "y", "width", "height"))
    attrs = f'fill="{shape["fill"]}" stroke="{shape["stroke"]}" stroke-width="{shape["stroke_width"]}"'
    geometry = ""
    if shape["type"] == "ellipse":
        geometry = f'<ellipse cx="{x + width / 2}" cy="{y + height / 2}" rx="{width / 2}" ry="{height / 2}" {attrs}/>'
    elif shape["type"] == "diamond":
        geometry = f'<polygon points="{x + width / 2},{y} {x + width},{y + height / 2} {x + width / 2},{y + height} {x},{y + height / 2}" {attrs}/>'
    elif shape["type"] != "text":
        radius = 0
        if shape["type"] == "rounded":
            radius = 12
        geometry = f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="{radius}" {attrs}/>'
    font_size = shape["font_size"]
    lines = wrap_label(shape)
    start_y = y + height / 2 - (len(lines) - 1) * font_size * 0.625
    text = ''.join(f'<tspan x="{x + width / 2}" y="{start_y + index * font_size * 1.25}">{escape(line)}</tspan>' for index, line in enumerate(lines))
    return geometry + f'<text text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="{font_size}" fill="{shape["stroke"]}">{text}</text>'


def render_current_diagram_svg(source: dict) -> str:
    shapes = source["shapes"]
    lookup = {shape["id"]: shape for shape in shapes}
    left, top, width, height = diagram_bounds(shapes)
    elements = []
    for arrow in source["arrows"]:
        first, second = lookup[arrow["from_id"]], lookup[arrow["to_id"]]
        start = edge_point(first, (second["x"] + second["width"] / 2, second["y"] + second["height"] / 2))
        end = edge_point(second, (first["x"] + first["width"] / 2, first["y"] + first["height"] / 2))
        angle = math.atan2(end[1] - start[1], end[0] - start[0])
        size = 9 + arrow["stroke_width"]
        points = [end, (end[0] - size * math.cos(angle - 0.45), end[1] - size * math.sin(angle - 0.45)),
                  (end[0] - size * math.cos(angle + 0.45), end[1] - size * math.sin(angle + 0.45))]
        points_text = ' '.join(f'{x},{y}' for x, y in points)
        elements.append(f'<line x1="{start[0]}" y1="{start[1]}" x2="{end[0]}" y2="{end[1]}" stroke="{arrow["stroke"]}" stroke-width="{arrow["stroke_width"]}"/><polygon points="{points_text}" fill="{arrow["stroke"]}"/>')
    elements.extend(_shape_svg(shape) for shape in shapes)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{left} {top} {width} {height}"><rect x="{left}" y="{top}" width="{width}" height="{height}" fill="#fff"/>' + ''.join(elements) + '</svg>'
