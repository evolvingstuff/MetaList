"""V3 SVG geometry and rich labels, matching diagram-document.js."""
from html import escape
import math

from app.services.diagram_rendering import edge_point


def endpoint_center(lookup, endpoint):
    if endpoint["kind"] == "free":
        return endpoint["x"], endpoint["y"]
    shape = lookup[endpoint["shape_id"]]
    return shape["x"] + shape["width"] / 2, shape["y"] + shape["height"] / 2


def endpoint_position(lookup, endpoint, toward):
    if endpoint["kind"] == "free":
        return endpoint["x"], endpoint["y"]
    shape = lookup[endpoint["shape_id"]]
    if endpoint["kind"] == "floating":
        return edge_point(shape, toward)
    return shape["x"] + endpoint["u"] * shape["width"], shape["y"] + endpoint["v"] * shape["height"]


def route_points(lookup, arrow):
    points = [(point["x"], point["y"]) for point in arrow["points"]]
    first_toward = endpoint_center(lookup, arrow["end"])
    last_toward = endpoint_center(lookup, arrow["start"])
    if points:
        first_toward, last_toward = points[0], points[-1]
    placed = [endpoint_position(lookup, arrow["start"], first_toward), *points,
              endpoint_position(lookup, arrow["end"], last_toward)]
    result = [placed[0]]
    for index, point in enumerate(placed[1:], 1):
        previous = result[-1]
        if arrow["routing"] == "orthogonal" and previous[0] != point[0] and previous[1] != point[1]:
            vertical_first = False
            if index == 1 and arrow["start"]["kind"] == "attached":
                vertical_first = arrow["start"]["v"] in (0, 1)
            if index == len(placed) - 1 and arrow["end"]["kind"] == "attached":
                vertical_first = arrow["end"]["u"] in (0, 1)
            if vertical_first:
                result.append((previous[0], point[1]))
            else:
                result.append((point[0], previous[1]))
        if math.dist(result[-1], point) > 0.001:
            result.append(point)
    return result


def rounded_path(points):
    assert points
    path = f'M {points[0][0]} {points[0][1]}'
    for a, b, c in zip(points, points[1:], points[2:]):
        ab, bc = math.dist(a, b), math.dist(b, c)
        radius = min(10, ab / 2, bc / 2)
        if not radius:
            continue
        before = (b[0] + (a[0] - b[0]) * radius / ab, b[1] + (a[1] - b[1]) * radius / ab)
        after = (b[0] + (c[0] - b[0]) * radius / bc, b[1] + (c[1] - b[1]) * radius / bc)
        path += f' L {before[0]} {before[1]} Q {b[0]} {b[1]} {after[0]} {after[1]}'
    if len(points) > 1:
        path += f' L {points[-1][0]} {points[-1][1]}'
    return path


def glyph_width(char, style, size):
    width = 0.6
    if char in " ilI.,!'`|:;":
        width = 0.32
    elif char in "MW@#%":
        width = 0.9
    elif ord(char) > 0x2fff:
        width = 1
    if style["bold"]:
        width *= 1.08
    if style["italic"]:
        width *= 1.03
    return size * width


def label_lines(item, width):
    tokens = []
    for run in item["runs"]:
        for char in run["text"]:
            styled = {**run, "text": char}
            if char.isspace():
                tokens.append([styled])
            elif tokens and not tokens[-1][0]["text"].isspace():
                tokens[-1].append(styled)
            else:
                tokens.append([styled])
    lines, used = [[]], 0
    for token in tokens:
        if token[0]["text"] == "\n":
            lines.append([])
            used = 0
            continue
        token_width = sum(glyph_width(char["text"], char, item["font_size"]) for char in token)
        if used and used + token_width > width and not token[0]["text"].isspace():
            lines.append([])
            used = 0
        for char in token:
            advance = glyph_width(char["text"], char, item["font_size"])
            if used and used + advance > width:
                lines.append([])
                used = 0
            lines[-1].append({**char, "advance": advance})
            used += advance
    return lines


def midpoint(points):
    lengths = [math.dist(a, b) for a, b in zip(points, points[1:])]
    remaining = sum(lengths) / 2
    for index, length in enumerate(lengths):
        if remaining <= length and length > 0:
            a, b = points[index], points[index + 1]
            return a[0] + (b[0] - a[0]) * remaining / length, a[1] + (b[1] - a[1]) * remaining / length
        remaining -= length
    return points[0]


def label_box(item, points):
    if "width" in item:
        return tuple(item[key] for key in ("x", "y", "width", "height"))
    x, y = midpoint(points)
    width = item["label_width"]
    height = len(label_lines(item, width - 24)) * item["font_size"] * 1.25 + 24
    return x - width / 2, y - height / 2, width, height


def text_svg(item, box):
    x, y, width, height = box
    lines = label_lines(item, width - 24)
    fragments = []
    for index, line in enumerate(lines):
        cursor = x + (width - sum(char["advance"] for char in line)) / 2
        baseline = y + height / 2 + (index - (len(lines) - 1) / 2) * item["font_size"] * 1.25
        for char in line:
            weight, italic = "normal", "normal"
            if char["bold"]:
                weight = "bold"
            if char["italic"]:
                italic = "italic"
            fragments.append(f'<tspan x="{cursor}" y="{baseline}" fill="{char["color"]}" font-weight="{weight}" font-style="{italic}" textLength="{char["advance"]}" lengthAdjust="spacingAndGlyphs">{escape(char["text"])}</tspan>')
            cursor += char["advance"]
    return f'<text xml:space="preserve" dominant-baseline="central" font-family="sans-serif" font-size="{item["font_size"]}">' + ''.join(fragments) + '</text>'


def shape_svg(shape):
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
    return geometry + text_svg(shape, (x, y, width, height))


def head_svg(tip, previous, arrow):
    angle, size = math.atan2(tip[1] - previous[1], tip[0] - previous[0]), 9 + arrow["stroke_width"]
    points = [tip, (tip[0] - size * math.cos(angle - .45), tip[1] - size * math.sin(angle - .45)),
              (tip[0] - size * math.cos(angle + .45), tip[1] - size * math.sin(angle + .45))]
    coords = ' '.join(f'{x},{y}' for x, y in points)
    return f'<polygon points="{coords}" fill="{arrow["stroke"]}"/>'


def render_diagram(source):
    lookup = {shape["id"]: shape for shape in source["shapes"]}
    rendered = {shape["id"]: shape_svg(shape) for shape in source["shapes"]}
    boxes = [tuple(shape[key] for key in ("x", "y", "width", "height")) for shape in source["shapes"]]
    for arrow in source["arrows"]:
        points = route_points(lookup, arrow)
        boxes.extend((x, y, 0, 0) for x, y in points)
        drawing = f'<path d="{rounded_path(points)}" fill="none" stroke="{arrow["stroke"]}" stroke-width="{arrow["stroke_width"]}"/>'
        if len(points) > 1:
            if arrow["start_head"]:
                drawing += head_svg(points[0], points[1], arrow)
            if arrow["end_head"]:
                drawing += head_svg(points[-1], points[-2], arrow)
        if any(run["text"] for run in arrow["runs"]):
            box = label_box(arrow, points)
            boxes.append(box)
            drawing += text_svg(arrow, box)
        rendered[arrow["id"]] = drawing
    if not boxes:
        boxes = [(0, 0, 900, 540)]
    left, top = min(box[0] for box in boxes) - 40, min(box[1] for box in boxes) - 40
    width = max(box[0] + box[2] for box in boxes) + 40 - left
    height = max(box[1] + box[3] for box in boxes) + 40 - top
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{left} {top} {width} {height}"><rect x="{left}" y="{top}" width="{width}" height="{height}" fill="#fff"/>' + ''.join(rendered[id] for id in source["order"]) + '</svg>'
