// Diagram v3: explicit routes, rich labels, logical groups, and unified drawing order.
import { upgradeDiagram, edgePoint, clamp } from './diagram-model.js';
export { DiagramHistory } from './diagram-model.js';
export const DEFAULT_STYLE = Object.freeze({ fill: '#ffffff', stroke: '#222222', font_size: 18, stroke_width: 2 });
export const snapPoint = (p, grid, bypass) => ({ x: clamp(bypass || !grid.snap ? p.x : Math.round(p.x / grid.size) * grid.size, -100000, 100000), y: clamp(bypass || !grid.snap ? p.y : Math.round(p.y / grid.size) * grid.size, -100000, 100000) });
export const run = (text, color) => ({ text, bold: false, italic: false, color });
export const free = p => ({ kind: 'free', x: p.x, y: p.y });
export const emptyDiagram = () => ({ kind: 'diagram', version: 4, source: { theme: 'hand-drawn', shapes: [], arrows: [], groups: [], order: [], grid: { visible: true, snap: true, size: 10 } } });
export function upgradeDocument(document) {
    if (document.version === 4) return structuredClone(document);
    if (document.version === 3) return { ...structuredClone(document), version: 4, source: { ...structuredClone(document.source), theme: 'clean' } };
    const old = upgradeDiagram(document).source, draft = emptyDiagram();
    draft.source.theme = 'clean';
    draft.source.shapes = old.shapes.map(({ label, ...shape }) => ({ ...shape, runs: [run(label, shape.stroke)] }));
    draft.source.arrows = old.arrows.map(({ from_id, to_id, ...arrow }) => ({ ...arrow,
        start: { kind: 'floating', shape_id: from_id }, end: { kind: 'floating', shape_id: to_id },
        points: [], routing: 'straight', start_head: false, end_head: true, runs: [], font_size: 18, label_width: 180 }));
    draft.source.order = [...old.arrows, ...old.shapes].map(item => item.id);
    return draft;
}
export function newShape(type, p, id) {
    return { id, type, x: p.x, y: p.y, width: 160, height: 90, ...DEFAULT_STYLE, runs: [run('', DEFAULT_STYLE.stroke)] };
}
export function newArrow(start, end, points, id) {
    return { id, start, end, points, routing: 'orthogonal', start_head: false, end_head: true,
        stroke: DEFAULT_STYLE.stroke, stroke_width: 2, runs: [], font_size: 18, label_width: 180 };
}
export const objects = source => [...source.shapes, ...source.arrows];
export function getObject(source, id) {
    const found = objects(source).find(item => item.id === id);
    if (!found) throw new Error(`Missing diagram object ${id}`);
    return found;
}
export function endpointPosition(source, endpoint, toward) {
    if (endpoint.kind === 'free') return { x: endpoint.x, y: endpoint.y };
    const shape = getObject(source, endpoint.shape_id);
    if (endpoint.kind === 'floating') return edgePoint(shape, toward);
    return { x: shape.x + endpoint.u * shape.width, y: shape.y + endpoint.v * shape.height };
}
function endpointCenter(source, endpoint) {
    if (endpoint.kind === 'free') return endpoint;
    const shape = getObject(source, endpoint.shape_id);
    return { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
}
export function anchors(source, arrow) {
    const firstToward = arrow.points.length ? arrow.points[0] : endpointCenter(source, arrow.end);
    const lastToward = arrow.points.length ? arrow.points.at(-1) : endpointCenter(source, arrow.start);
    return [endpointPosition(source, arrow.start, firstToward), ...arrow.points, endpointPosition(source, arrow.end, lastToward)];
}
export function cleanPoints(points) {
    const result = [];
    for (const point of points) if (!result.length || Math.hypot(point.x - result.at(-1).x, point.y - result.at(-1).y) > .001) result.push({ ...point });
    return result;
}
export function routePoints(source, arrow) {
    const placed = anchors(source, arrow);
    if (arrow.routing === 'straight') return cleanPoints(placed);
    const result = [placed[0]];
    for (let i = 1; i < placed.length; i++) {
        const a = result.at(-1), b = placed[i];
        if (a.x !== b.x && a.y !== b.y) {
            let verticalFirst = false;
            if (i === 1 && arrow.start.kind === 'attached') verticalFirst = [0, 1].includes(arrow.start.v);
            if (i === placed.length - 1 && arrow.end.kind === 'attached') verticalFirst = [0, 1].includes(arrow.end.u);
            result.push(verticalFirst ? { x: a.x, y: b.y } : { x: b.x, y: a.y });
        }
        result.push(b);
    }
    return cleanPoints(result);
}
export function roundedPath(points) {
    if (!points.length) return '';
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length - 1; i++) {
        const a = points[i - 1], b = points[i], c = points[i + 1];
        const ab = Math.hypot(b.x - a.x, b.y - a.y), bc = Math.hypot(c.x - b.x, c.y - b.y);
        const radius = Math.min(10, ab / 2, bc / 2);
        if (!radius) continue;
        path += ` L ${b.x + (a.x - b.x) * radius / ab} ${b.y + (a.y - b.y) * radius / ab} Q ${b.x} ${b.y} ${b.x + (c.x - b.x) * radius / bc} ${b.y + (c.y - b.y) * radius / bc}`;
    }
    if (points.length > 1) path += ` L ${points.at(-1).x} ${points.at(-1).y}`;
    return path;
}
export function headPoints(tip, previous, weight) {
    const angle = Math.atan2(tip.y - previous.y, tip.x - previous.x), size = 9 + weight;
    return [tip, { x: tip.x - size * Math.cos(angle - .45), y: tip.y - size * Math.sin(angle - .45) },
        { x: tip.x - size * Math.cos(angle + .45), y: tip.y - size * Math.sin(angle + .45) }];
}
export function midpoint(points) {
    if (!points.length) throw new Error('A route requires an endpoint');
    const lengths = points.slice(1).map((point, i) => Math.hypot(point.x - points[i].x, point.y - points[i].y));
    let remaining = lengths.reduce((a, b) => a + b, 0) / 2;
    for (let i = 0; i < lengths.length; i++) {
        if (remaining <= lengths[i] && lengths[i] > 0) return { x: points[i].x + (points[i + 1].x - points[i].x) * remaining / lengths[i], y: points[i].y + (points[i + 1].y - points[i].y) * remaining / lengths[i] };
        remaining -= lengths[i];
    }
    return points[0];
}
// Shared conservative glyph advances; SVG textLength makes preview layout deterministic.
export function glyphWidth(char, style, size) {
    let width = .6;
    if (' ilI.,!\'`|:;'.includes(char)) width = .32;
    else if ('MW@#%'.includes(char)) width = .9;
    else if (char.codePointAt(0) > 0x2fff) width = 1;
    return size * width * (style.bold ? 1.08 : 1) * (style.italic ? 1.03 : 1);
}
export function labelLines(item, width) {
    const lines = [[]]; let used = 0;
    const chars = item.runs.flatMap(style => Array.from(style.text, char => ({ ...style, text: char })));
    const tokens = [];
    for (const char of chars) {
        if (char.text === '\n' || /\s/u.test(char.text)) tokens.push([char]);
        else if (tokens.length && !/\s/u.test(tokens.at(-1)[0].text)) tokens.at(-1).push(char);
        else tokens.push([char]);
    }
    for (const token of tokens) {
        if (token[0].text === '\n') { lines.push([]); used = 0; continue; }
        const tokenWidth = token.reduce((sum, c) => sum + glyphWidth(c.text, c, item.font_size), 0);
        if (used && used + tokenWidth > width && !/\s/u.test(token[0].text)) { lines.push([]); used = 0; }
        for (const char of token) {
            const advance = glyphWidth(char.text, char, item.font_size);
            if (used && used + advance > width) { lines.push([]); used = 0; }
            lines.at(-1).push({ ...char, advance }); used += advance;
        }
    }
    return lines;
}
export function growShape(shape) {
    shape.height = Math.max(shape.height, labelLines(shape, shape.width - 24).length * shape.font_size * 1.25 + 24);
}
export function labelBox(source, item) {
    if (Object.hasOwn(item, 'width')) return { x: item.x, y: item.y, width: item.width, height: item.height };
    const center = midpoint(routePoints(source, item)), width = item.label_width;
    const height = labelLines(item, width - 24).length * item.font_size * 1.25 + 24;
    return { x: center.x - width / 2, y: center.y - height / 2, width, height };
}
export function documentBounds(source) {
    const boxes = source.shapes.map(shape => ({ ...shape }));
    for (const arrow of source.arrows) {
        for (const point of routePoints(source, arrow)) boxes.push({ ...point, width: 0, height: 0 });
        if (arrow.runs.some(r => r.text)) boxes.push(labelBox(source, arrow));
    }
    if (!boxes.length) return { x: 0, y: 0, width: 900, height: 540 };
    const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
    return { x, y, width: Math.max(...boxes.map(box => box.x + box.width)) - x, height: Math.max(...boxes.map(box => box.y + box.height)) - y };
}
export function expandSelection(source, selected) {
    const expanded = new Set(selected);
    for (const group of source.groups) if (group.members.some(id => expanded.has(id))) for (const id of group.members) expanded.add(id);
    return expanded;
}
export function internalArrows(source, selected) {
    const expanded = new Set(selected);
    for (const arrow of source.arrows) if (arrow.start.kind !== 'free' && arrow.end.kind !== 'free' && selected.has(arrow.start.shape_id) && selected.has(arrow.end.shape_id)) expanded.add(arrow.id);
    return expanded;
}
export function moveObjects(source, selected, dx, dy) {
    const next = structuredClone(source), moved = internalArrows(source, expandSelection(source, selected));
    for (const shape of next.shapes) if (moved.has(shape.id)) { shape.x += dx; shape.y += dy; }
    for (const arrow of next.arrows) {
        const both = [arrow.start, arrow.end].every(endpoint => endpoint.kind !== 'free' && moved.has(endpoint.shape_id));
        if (moved.has(arrow.id) || both) {
            arrow.points = arrow.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
            for (const key of ['start', 'end']) if (arrow[key].kind === 'free') { arrow[key].x += dx; arrow[key].y += dy; }
        }
    }
    return next;
}
export function groupObjects(source, selected, id) {
    const members = internalArrows(source, expandSelection(source, selected));
    if (members.size < 2) return source;
    return { ...source, groups: [...source.groups.filter(g => !g.members.some(member => members.has(member))), { id, members: [...members] }] };
}
export function ungroupObjects(source, selected) { return { ...source, groups: source.groups.filter(g => !g.members.some(id => selected.has(id))) }; }
export function reorder(source, selected, front) {
    const ids = expandSelection(source, selected), moved = source.order.filter(id => ids.has(id)), others = source.order.filter(id => !ids.has(id));
    return { ...source, order: front ? [...others, ...moved] : [...moved, ...others] };
}
export function removeObjects(source, selected) {
    const removed = expandSelection(source, selected);
    for (const arrow of source.arrows) if ([arrow.start, arrow.end].some(end => end.kind !== 'free' && removed.has(end.shape_id))) removed.add(arrow.id);
    return { ...source, shapes: source.shapes.filter(s => !removed.has(s.id)), arrows: source.arrows.filter(a => !removed.has(a.id)),
        order: source.order.filter(id => !removed.has(id)), groups: source.groups.map(g => ({ ...g, members: g.members.filter(id => !removed.has(id)) })).filter(g => g.members.length > 1) };
}
export function copyObjects(source, selected, nextId) {
    const chosen = internalArrows(source, expandSelection(source, selected));
    const map = new Map([...chosen].map(id => [id, nextId()]));
    const shapes = source.shapes.filter(s => chosen.has(s.id)).map(s => ({ ...structuredClone(s), id: map.get(s.id) }));
    const arrows = source.arrows.filter(a => chosen.has(a.id)).map(a => {
        const next = structuredClone(a); next.id = map.get(a.id);
        for (const key of ['start', 'end']) if (next[key].kind !== 'free') {
            if (map.has(next[key].shape_id)) next[key].shape_id = map.get(next[key].shape_id);
            else next[key] = free(anchors(source, a)[key === 'start' ? 0 : anchors(source, a).length - 1]);
        }
        return next;
    });
    return { shapes, arrows, groups: source.groups.filter(g => g.members.every(id => chosen.has(id))).map(g => ({ id: nextId(), members: g.members.map(id => map.get(id)) })), order: source.order.filter(id => chosen.has(id)).map(id => map.get(id)), grid: { ...source.grid } };
}
export function connectionAt(source, p, tolerance) {
    for (const id of [...source.order].reverse()) {
        const shape = source.shapes.find(s => s.id === id);
        if (!shape || shape.type === 'text') continue;
        let best = null, distance = tolerance;
        for (const [u, v] of [[0, 0], [.5, 0], [1, 0], [1, .5], [1, 1], [.5, 1], [0, 1], [0, .5]]) {
            const point = { x: shape.x + u * shape.width, y: shape.y + v * shape.height };
            const d = Math.hypot(p.x - point.x, p.y - point.y);
            if (d <= distance) { distance = d; best = { kind: 'attached', shape_id: id, u, v }; }
        }
        if (best) return best;
    }
    return free(p);
}

export function draggedArrow(source, id, kind, index, point, endpoint) {
    const original = getObject(source, id), item = structuredClone(original), points = routePoints(source, original);
    if (kind === 'endpoint') { item[index === 0 ? 'start' : 'end'] = endpoint; return item; }
    if (kind === 'bend') points[index] = point;
    else if (kind === 'segment') {
        const originals = structuredClone(points), vertical = points[index].x === points[index + 1].x;
        const a = { ...points[index] }, b = { ...points[index + 1] };
        if (vertical) { a.x = point.x; b.x = point.x; } else { a.y = point.y; b.y = point.y; }
        points.splice(index, 2, a, b);
        if (index === 0) points.unshift(originals[0]);
        if (index === originals.length - 2) points.push(originals.at(-1));
    } else throw new Error(`Unknown arrow gesture ${kind}`);
    item.points = cleanPoints(points).slice(1, -1); item.routing = 'orthogonal';
    return item;
}
export function geometryWithinLimits(source) {
    if (source.shapes.some(shape => Math.abs(shape.x) > 100000 || Math.abs(shape.y) > 100000)) return false;
    for (const arrow of source.arrows) {
        if (arrow.points.length > 256) return false;
        const points = [...arrow.points, ...[arrow.start, arrow.end].filter(endpoint => endpoint.kind === 'free')];
        if (points.some(p => Math.abs(p.x) > 200000 || Math.abs(p.y) > 200000)) return false;
    }
    return true;
}
