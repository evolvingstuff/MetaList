// Pure document/geometry operations. Camera and selection never enter saved JSON.
export const SHAPE_LIMIT = 200;
export const ARROW_LIMIT = 400;
export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export const snap = (value, enabled) => enabled ? Math.round(value / 10) * 10 : value;

export function emptyDiagram() {
    return { kind: 'diagram', version: 2, source: { shapes: [], arrows: [] } };
}

export function upgradeDiagram(document) {
    if (document.version === 2) return structuredClone(document);
    if (document.version !== 1) throw new Error(`Unsupported diagram version ${document.version}`);
    return { kind: 'diagram', version: 2, source: { arrows: [], shapes: document.source.rectangles.map(rect => ({
        ...rect, type: 'rounded', width: 160, height: 80, fill: '#dbeafe', stroke: '#2563eb', font_size: 16, stroke_width: 2,
    })) } };
}

export function createShape(type, x, y, style, id) {
    return { id, type, x, y, width: 160, height: 90, label: '', ...style };
}

export function bounds(shapes) {
    if (!shapes.length) return { x: 0, y: 0, width: 900, height: 540 };
    const x = Math.min(...shapes.map(shape => shape.x));
    const y = Math.min(...shapes.map(shape => shape.y));
    return { x, y, width: Math.max(...shapes.map(shape => shape.x + shape.width)) - x,
        height: Math.max(...shapes.map(shape => shape.y + shape.height)) - y };
}

export function edgePoint(shape, toward) {
    const cx = shape.x + shape.width / 2, cy = shape.y + shape.height / 2;
    const dx = toward.x - cx, dy = toward.y - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const rx = shape.width / 2, ry = shape.height / 2;
    let scale;
    if (shape.type === 'ellipse') scale = 1 / Math.hypot(dx / rx, dy / ry);
    else if (shape.type === 'diamond') scale = 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry);
    else scale = 1 / Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry);
    return { x: cx + dx * scale, y: cy + dy * scale };
}

export function arrowGeometry(first, second, strokeWidth) {
    const start = edgePoint(first, { x: second.x + second.width / 2, y: second.y + second.height / 2 });
    const end = edgePoint(second, { x: first.x + first.width / 2, y: first.y + first.height / 2 });
    const angle = Math.atan2(end.y - start.y, end.x - start.x), size = 9 + strokeWidth;
    return { start, end, points: [end,
        { x: end.x - size * Math.cos(angle - .45), y: end.y - size * Math.sin(angle - .45) },
        { x: end.x - size * Math.cos(angle + .45), y: end.y - size * Math.sin(angle + .45) }].map(p => `${p.x},${p.y}`).join(' ') };
}

export function resizeShape(original, handle, dx, dy, grid) {
    const next = { ...original };
    if (handle.includes('e')) next.width = clamp(snap(original.width + dx, grid), 40, 4000);
    if (handle.includes('s')) next.height = clamp(snap(original.height + dy, grid), 40, 4000);
    if (handle.includes('w')) {
        next.width = clamp(snap(original.width - dx, grid), 40, 4000);
        next.x = original.x + original.width - next.width;
    }
    if (handle.includes('n')) {
        next.height = clamp(snap(original.height - dy, grid), 40, 4000);
        next.y = original.y + original.height - next.height;
    }
    next.x = clamp(next.x, -100000, 100000);
    next.y = clamp(next.y, -100000, 100000);
    return next;
}

export function removeSelection(source, selected) {
    const shapes = source.shapes.filter(shape => !selected.has(shape.id));
    const remaining = new Set(shapes.map(shape => shape.id));
    return { shapes, arrows: source.arrows.filter(arrow => !selected.has(arrow.id) && remaining.has(arrow.from_id) && remaining.has(arrow.to_id)) };
}

export function duplicateSelection(source, selected, nextId) {
    const copiedShapes = source.shapes.filter(shape => selected.has(shape.id));
    const ids = new Map(copiedShapes.map(shape => [shape.id, nextId()]));
    const arrows = source.arrows.filter(arrow => ids.has(arrow.from_id) && ids.has(arrow.to_id));
    if (source.shapes.length + copiedShapes.length > SHAPE_LIMIT || source.arrows.length + arrows.length > ARROW_LIMIT) return null;
    const shapes = copiedShapes.map(shape => ({ ...shape, id: ids.get(shape.id),
        x: clamp(shape.x + 24, -100000, 100000), y: clamp(shape.y + 24, -100000, 100000) }));
    const copies = arrows.map(arrow => ({ ...arrow, id: nextId(), from_id: ids.get(arrow.from_id), to_id: ids.get(arrow.to_id) }));
    return { source: { shapes: [...source.shapes, ...shapes], arrows: [...source.arrows, ...copies] }, selected: new Set(shapes.map(shape => shape.id)) };
}

export function wrapLabel(shape) {
    const columns = Math.max(1, Math.floor((shape.width - 24) / (shape.font_size * .6)));
    const lines = [];
    for (const paragraph of shape.label.split('\n')) {
        if (!paragraph.trim()) { lines.push(''); continue; }
        let line = '';
        for (let word of paragraph.trim().split(/\s+/)) {
            if (line && Array.from(line).length + 1 + Array.from(word).length > columns) { lines.push(line); line = ''; }
            while (Array.from(word).length > columns) {
                const characters = Array.from(word);
                lines.push(characters.slice(0, columns).join(''));
                word = characters.slice(columns).join('');
            }
            line = line ? `${line} ${word}` : word;
        }
        if (line) lines.push(line);
    }
    const maxLines = Math.max(1, Math.floor((shape.height - 12) / (shape.font_size * 1.25)));
    if (lines.length > maxLines) {
        lines.length = maxLines;
        lines[maxLines - 1] = Array.from(lines[maxLines - 1]).slice(0, -1).join('') + '…';
    }
    return lines;
}

export class DiagramHistory {
    constructor(state) { this.state = state; this.past = []; this.future = []; }
    commit(before) {
        if (JSON.stringify(before) === JSON.stringify(this.state.draft)) return false;
        this.past.push(before);
        if (this.past.length > 100) this.past.shift();
        this.future = [];
        return true;
    }
    undo() {
        if (!this.past.length) return;
        this.future.push(structuredClone(this.state.draft));
        this.state.draft = this.past.pop();
    }
    redo() {
        if (!this.future.length) return;
        this.past.push(structuredClone(this.state.draft));
        this.state.draft = this.future.pop();
    }
}
