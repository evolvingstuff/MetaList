import { arrowGeometry, wrapLabel } from './diagram-model.js';
const SVG_NS = 'http://www.w3.org/2000/svg';
export function svgNode(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
}

export function drawShape(shape) {
    const group = svgNode('g', { 'data-shape-id': shape.id });
    const { x, y, width, height } = shape;
    const attrs = { fill: shape.fill, stroke: shape.stroke, 'stroke-width': shape.stroke_width };
    let geometry;
    if (shape.type === 'ellipse') geometry = svgNode('ellipse', { cx: x + width / 2, cy: y + height / 2, rx: width / 2, ry: height / 2, ...attrs });
    else if (shape.type === 'diamond') geometry = svgNode('polygon', { points: `${x + width / 2},${y} ${x + width},${y + height / 2} ${x + width / 2},${y + height} ${x},${y + height / 2}`, ...attrs });
    else geometry = svgNode('rect', { x, y, width, height, rx: shape.type === 'rounded' ? 12 : 0, ...attrs });
    if (shape.type === 'text') { geometry.setAttribute('fill', 'transparent'); geometry.setAttribute('stroke', 'none'); }
    geometry.setAttribute('pointer-events', 'all');
    group.append(geometry);
    const text = svgNode('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'sans-serif', 'font-size': shape.font_size, fill: shape.stroke });
    const lines = wrapLabel(shape);
    lines.forEach((line, index) => {
        const span = svgNode('tspan', { x: x + width / 2, y: y + height / 2 + (index - (lines.length - 1) / 2) * shape.font_size * 1.25 });
        span.textContent = line;
        text.append(span);
    });
    group.append(text);
    return group;
}

export function renderCanvas(layer, source, selected, zoom, connectingId) {
    const children = [];
    const lookup = new Map(source.shapes.map(shape => [shape.id, shape]));
    for (const arrow of source.arrows) {
        const { start, end, points } = arrowGeometry(lookup.get(arrow.from_id), lookup.get(arrow.to_id), arrow.stroke_width);
        const group = svgNode('g', { 'data-arrow-id': arrow.id });
        const coords = { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
        group.append(svgNode('line', { ...coords, stroke: 'transparent', 'stroke-width': 14 / zoom, 'pointer-events': 'stroke' }));
        group.append(svgNode('line', { ...coords, stroke: selected.has(arrow.id) ? '#6366f1' : arrow.stroke, 'stroke-width': arrow.stroke_width }));
        group.append(svgNode('polygon', { points, fill: selected.has(arrow.id) ? '#6366f1' : arrow.stroke }));
        children.push(group);
    }
    for (const shape of source.shapes) children.push(drawShape(shape));
    const selectedShapes = source.shapes.filter(shape => selected.has(shape.id));
    for (const shape of source.shapes) {
        if (!selected.has(shape.id) && connectingId !== shape.id) continue;
        children.push(svgNode('rect', { x: shape.x - 3 / zoom, y: shape.y - 3 / zoom,
            width: shape.width + 6 / zoom, height: shape.height + 6 / zoom,
            fill: 'none', stroke: '#6366f1', 'stroke-width': 1.5 / zoom, 'pointer-events': 'none' }));
        if (selectedShapes.length !== 1 || !selected.has(shape.id)) continue;
        for (const [handle, hx, hy] of [['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1]]) {
            children.push(svgNode('rect', { x: shape.x + hx * shape.width - 4 / zoom, y: shape.y + hy * shape.height - 4 / zoom,
                width: 8 / zoom, height: 8 / zoom, rx: 1 / zoom, fill: 'white', stroke: '#6366f1', 'stroke-width': 1 / zoom,
                'data-resize': handle, 'data-shape-id': shape.id, style: `cursor:${handle}-resize` }));
        }
    }
    layer.replaceChildren(...children);
}

export const ICONS = {
    select: '<path d="m5 3 14 9-7 1-3 7z"/>',
    hand: '<path d="M8 12V6a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v7-5a2 2 0 0 1 4 0v8c0 5-3 7-7 7-3 0-4-2-6-5l-3-4a2 2 0 0 1 3-2l1 2"/>',
    rectangle: '<rect x="4" y="5" width="16" height="14"/>',
    rounded: '<rect x="4" y="5" width="16" height="14" rx="4"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
    diamond: '<path d="m12 3 9 9-9 9-9-9z"/>',
    text: '<path d="M5 5h14M12 5v15M8 20h8"/>',
    arrow: '<path d="M4 20 20 4M9 4h11v11"/>',
    undo: '<path d="M8 4 3 9l5 5M3 9h10a7 7 0 0 1 0 14"/>',
    redo: '<path d="m16 4 5 5-5 5M21 9H11a7 7 0 0 0 0 14"/>',
    duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
    delete: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
};
export function icon(name) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}
