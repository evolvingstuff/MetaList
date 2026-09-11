"""Deterministic vector pen strokes shared with diagram-theme.js."""
import math
import re


THEMES = {
    "clean": {"paper": "#ffffff", "grid": "#e0e0e0", "font": "sans-serif"},
    "hand-drawn": {"paper": "#ffffff", "grid": "#e0e0e0", "font": "Chalkboard SE, Comic Sans MS, cursive"},
}


def diagram_theme(source):
    name = "clean"
    if "theme" in source:
        name = source["theme"]
    return {"name": name, **THEMES[name]}


def _random_values(identity, pass_number):
    seed = 2166136261
    for char in f"{identity}:{pass_number}":
        seed = ((seed ^ ord(char)) * 16777619) & 0xffffffff
    while True:
        seed = (seed * 1664525 + 1013904223) & 0xffffffff
        yield seed / 4294967296 * 2 - 1


def _pen_line(start, end, random):
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = math.hypot(dx, dy)
    if length < .001:
        return []
    # A single broad bow preserves the confidence of a continuous pen gesture.
    variation, amount = next(random), min(7, length * .025)
    bow = math.copysign(1, variation) * (.35 + .65 * abs(variation)) * amount
    if variation == 0:
        bow = 0
    first, second = bow * (.9 + .1 * next(random)), bow * (.9 + .1 * next(random))
    return [f'C {start[0] + dx / 3 - dy / length * first} {start[1] + dy / 3 + dx / length * first} {start[0] + dx * 2 / 3 - dy / length * second} {start[1] + dy * 2 / 3 + dx / length * second} {end[0]} {end[1]}']


def _pen_transform(tokens, random):
    coordinates = [float(token) for token in tokens if token not in {"M", "L", "Q", "C", "Z"}]
    xs, ys = coordinates[::2], coordinates[1::2]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    skew_x, skew_y = next(random) * .012, next(random) * .012
    return lambda x, y: (x + (y - cy) * skew_x, y + (x - cx) * skew_y)


def sketch_path(path, identity, pass_number):
    tokens = re.findall(r"[MLQCZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?", path, re.IGNORECASE)
    if not tokens:
        return ''
    random = _random_values(identity, pass_number)
    is_closed = "Z" in tokens
    transform = _pen_transform(tokens, random)
    output, cursor, start, index = [], (0, 0), (0, 0), 0
    while index < len(tokens):
        command = tokens[index]
        index += 1
        if command == "Z":
            output.append("Z")
            cursor = start
            continue
        count = {"M": 2, "L": 2, "Q": 4, "C": 6}[command]
        values = [float(value) for value in tokens[index:index + count]]
        index += count
        if is_closed:
            for offset in range(0, count, 2):
                values[offset:offset + 2] = transform(values[offset], values[offset + 1])
        end = tuple(values[-2:])
        if command == "L":
            output.extend(_pen_line(cursor, end, random))
        else:
            if command == "M":
                start = end
            output.append(command + ' ' + ' '.join(str(value) for value in values))
        cursor = end
    return ' '.join(output)


def _sample_pen(path):
    tokens = re.findall(r"[MCQZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?", path, re.IGNORECASE)
    points, cursor, index = [], (0, 0), 0
    while index < len(tokens):
        command = tokens[index]
        index += 1
        if command == "Z":
            continue
        count = {"M": 2, "Q": 4, "C": 6}[command]
        values = [float(value) for value in tokens[index:index + count]]
        index += count
        end = tuple(values[-2:])
        if command == "M":
            points.append(end)
        else:
            for step in range(1, 21):
                t, u = step / 20, 1 - step / 20
                point = []
                for axis in range(2):
                    if command == "Q":
                        point.append(u * u * cursor[axis] + 2 * u * t * values[axis] + t * t * end[axis])
                    else:
                        point.append(u ** 3 * cursor[axis] + 3 * u * u * t * values[axis] + 3 * u * t * t * values[axis + 2] + t ** 3 * end[axis])
                if math.dist(point, points[-1]) > .001:
                    points.append(tuple(point))
        cursor = end
    return points


def ink_outline(path, identity, weight):
    """A filled ribbon models pen pressure instead of a uniform-width stroke."""
    points = _sample_pen(path)
    if len(points) < 2:
        return ''
    random = _random_values(identity, 7)
    phase = next(random) * math.pi
    is_closed = path.rstrip().endswith('Z')
    total = sum(math.dist(point, points[index]) for index, point in enumerate(points[1:]))
    left, right, distance = [], [], 0
    for index, point in enumerate(points):
        before, after = points[max(0, index - 1)], points[min(len(points) - 1, index + 1)]
        if is_closed and index == 0:
            before = points[-2]
        if is_closed and index == len(points) - 1:
            after = points[1]
        dx, dy = after[0] - before[0], after[1] - before[1]
        length = math.hypot(dx, dy)
        if length < .001:
            continue
        if index > 0:
            distance += math.dist(point, points[index - 1])
        t = distance / total
        pressure = .95 + .15 * math.sin(math.pi * t)
        if is_closed:
            pressure = 1.2 + .2 * math.cos(2 * math.pi * t + phase)
        radius = weight * pressure
        left.append(f'{point[0] - dy / length * radius} {point[1] + dx / length * radius}')
        right.append(f'{point[0] + dy / length * radius} {point[1] - dx / length * radius}')
    return 'M ' + ' L '.join(left) + ' L ' + ' L '.join(reversed(right)) + ' Z'


def shape_path(shape):
    x, y, w, h = (shape[key] for key in ("x", "y", "width", "height"))
    if shape["type"] == "diamond":
        return f'M {x + w / 2} {y} L {x + w} {y + h / 2} L {x + w / 2} {y + h} L {x} {y + h / 2} L {x + w / 2} {y} Z'
    if shape["type"] == "ellipse":
        cx, cy, rx, ry, k = x + w / 2, y + h / 2, w / 2, h / 2, .5522847498
        return f'M {cx + rx} {cy} C {cx + rx} {cy + ry * k} {cx + rx * k} {cy + ry} {cx} {cy + ry} C {cx - rx * k} {cy + ry} {cx - rx} {cy + ry * k} {cx - rx} {cy} C {cx - rx} {cy - ry * k} {cx - rx * k} {cy - ry} {cx} {cy - ry} C {cx + rx * k} {cy - ry} {cx + rx} {cy - ry * k} {cx + rx} {cy} Z'
    r = 0
    if shape["type"] == "rounded":
        r = 12
    return f'M {x + r} {y} L {x + w - r} {y} Q {x + w} {y} {x + w} {y + r} L {x + w} {y + h - r} Q {x + w} {y + h} {x + w - r} {y + h} L {x + r} {y + h} Q {x} {y + h} {x} {y + h - r} L {x} {y + r} Q {x} {y} {x + r} {y} Z'


def pen_svg(path, identity, color, weight):
    first = sketch_path(path, identity, 0)
    outline = ink_outline(first, identity, weight)
    return f'<g stroke-linecap="round" stroke-linejoin="round"><path data-sketch-ink="true" d="{outline}" fill="{color}"/></g>'
