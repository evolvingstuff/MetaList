import { svgNode, drawShape } from './diagram-canvas.js';
import { getObject, routePoints, roundedPath, headPoints, labelLines, labelBox, expandSelection } from './diagram-document.js';
export { svgNode, icon } from './diagram-canvas.js';
export function drawLabel(source, item) {
    const box = labelBox(source, item), lines = labelLines(item, box.width - 24);
    const text = svgNode('text', { 'xml:space': 'preserve', 'dominant-baseline': 'central', 'font-family': 'sans-serif', 'font-size': item.font_size });
    lines.forEach((line, index) => {
        let cursor = box.x + (box.width - line.reduce((sum, char) => sum + char.advance, 0)) / 2;
        const y = box.y + box.height / 2 + (index - (lines.length - 1) / 2) * item.font_size * 1.25;
        for (const char of line) {
            const span = svgNode('tspan', { x: cursor, y, fill: char.color, 'font-weight': char.bold ? 'bold' : 'normal',
                'font-style': char.italic ? 'italic' : 'normal', textLength: char.advance, lengthAdjust: 'spacingAndGlyphs' });
            span.textContent = char.text; text.append(span); cursor += char.advance;
        }
    });
    return text;
}
export function arrowNode(source, arrow, zoom) {
    const points = routePoints(source, arrow), d = roundedPath(points), group = svgNode('g', { 'data-object': arrow.id });
    group.append(svgNode('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': 16 / zoom, 'pointer-events': 'stroke' }));
    group.append(svgNode('path', { d, fill: 'none', stroke: arrow.stroke, 'stroke-width': arrow.stroke_width, 'pointer-events': 'none' }));
    if (points.length > 1) for (const [enabled, tip, previous] of [[arrow.start_head, points[0], points[1]], [arrow.end_head, points.at(-1), points.at(-2)]]) {
        if (enabled) group.append(svgNode('polygon', { points: headPoints(tip, previous, arrow.stroke_width).map(p => `${p.x},${p.y}`).join(' '), fill: arrow.stroke }));
    }
    if (arrow.runs.some(run => run.text)) {
        group.append(svgNode('rect', { ...labelBox(source, arrow), fill: 'transparent', 'pointer-events': 'all' }));
        group.append(drawLabel(source, arrow));
    }
    return group;
}
function handle(point, attributes, zoom, square) {
    const common = { fill: '#fff', stroke: '#6366f1', 'stroke-width': 1.5 / zoom, ...attributes };
    if (square) return svgNode('rect', { x: point.x - 4 / zoom, y: point.y - 4 / zoom, width: 8 / zoom, height: 8 / zoom, ...common });
    return svgNode('circle', { cx: point.x, cy: point.y, r: 4 / zoom, ...common });
}
export function renderScene(scene, overlay, source, selected, zoom, showPorts) {
    const nodes = [], chrome = [];
    for (const id of source.order) {
        const item = getObject(source, id);
        if (Object.hasOwn(item, 'width')) {
            const node = drawShape({ ...item, label: '' });
            node.querySelector('text').remove(); node.removeAttribute('data-shape-id'); node.dataset.object = id;
            node.append(drawLabel(source, item)); nodes.push(node);
        } else nodes.push(arrowNode(source, item, zoom));
    }
    const expanded = expandSelection(source, selected);
    const grouped = source.groups.some(g => g.members.some(id => expanded.has(id)));
    for (const id of expanded) {
        const item = getObject(source, id);
        if (Object.hasOwn(item, 'width')) {
            chrome.push(svgNode('rect', { x: item.x - 3 / zoom, y: item.y - 3 / zoom, width: item.width + 6 / zoom, height: item.height + 6 / zoom,
                fill: 'none', stroke: '#6366f1', 'stroke-width': 1 / zoom, 'pointer-events': 'none' }));
            if (expanded.size === 1 && !grouped) for (const [name, u, v] of [['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1]]) {
                chrome.push(handle({ x: item.x + u * item.width, y: item.y + v * item.height }, { 'data-object': id, 'data-handle': name, style: `cursor:${name}-resize` }, zoom, true));
            }
        } else if (expanded.size === 1) {
            const points = routePoints(source, item);
            points.forEach((p, index) => chrome.push(handle(p, { 'data-object': id, 'data-bend': index, style: 'cursor:crosshair' }, zoom, false)));
            for (let i = 0; i < points.length - 1; i++) chrome.push(handle({ x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 },
                { 'data-object': id, 'data-segment': i, fill: '#c7d2fe', style: points[i].x === points[i + 1].x ? 'cursor:ew-resize' : 'cursor:ns-resize' }, zoom, true));
        }
    }
    if (showPorts) for (const shape of source.shapes) {
        if (shape.type === 'text') continue;
        for (const [u, v] of [[0, 0], [.5, 0], [1, 0], [1, .5], [1, 1], [.5, 1], [0, 1], [0, .5]]) {
            chrome.push(handle({ x: shape.x + u * shape.width, y: shape.y + v * shape.height }, { fill: '#e0e7ff', 'pointer-events': 'none' }, zoom, false));
        }
    }
    scene.replaceChildren(...nodes); overlay.replaceChildren(...chrome);
}
