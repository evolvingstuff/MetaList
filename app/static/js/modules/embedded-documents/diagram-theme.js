// Presentation only: stable pen strokes never change saved geometry or hit targets.
export const THEMES = Object.freeze({
    clean: Object.freeze({ label: 'Clean', paper: '#ffffff', grid: '#e0e0e0', font: 'sans-serif' }),
    'hand-drawn': Object.freeze({ label: 'Hand-drawn', paper: '#ffffff', grid: '#e0e0e0', font: 'Chalkboard SE, Comic Sans MS, cursive' }),
});
export function diagramTheme(source) {
    // V3 sources intentionally had no theme. V4 validation requires it.
    const name = Object.hasOwn(source, 'theme') ? source.theme : 'clean';
    if (!Object.hasOwn(THEMES, name)) throw new Error(`Unknown diagram theme ${name}`);
    return { name, ...THEMES[name] };
}
function randomFor(id, pass) {
    let seed = 2166136261;
    for (const char of `${id}:${pass}`) seed = Math.imul(seed ^ char.codePointAt(0), 16777619) >>> 0;
    return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
}
function penLine(start, end, random) {
    const dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy);
    if (length < .001) return [];
    // One continuous gesture per edge: a broad bow, never a chain of wiggles.
    const variation = random(), amount = Math.min(7, length * .025);
    const bow = Math.sign(variation) * (.35 + .65 * Math.abs(variation)) * amount;
    const first = bow * (.9 + .1 * random()), second = bow * (.9 + .1 * random());
    return [`C ${start.x + dx / 3 - dy / length * first} ${start.y + dy / 3 + dx / length * first} ${start.x + dx * 2 / 3 - dy / length * second} ${start.y + dy * 2 / 3 + dx / length * second} ${end.x} ${end.y}`];
}
function penTransform(tokens, random) {
    const coordinates = tokens.filter(token => !/^[MLQCZ]$/.test(token)).map(Number);
    const xs = coordinates.filter((_, index) => index % 2 === 0), ys = coordinates.filter((_, index) => index % 2 === 1);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const skewX = random() * .012, skewY = random() * .012;
    // Transform corners and curve controls together so rounded corners stay smooth.
    return (x, y) => [x + (y - cy) * skewX, y + (x - cx) * skewY];
}
export function sketchPath(path, id, pass) {
    const tokens = path.match(/[MLQCZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi);
    if (!tokens) return '';
    const random = randomFor(id, pass);
    const closed = tokens.includes('Z');
    const transform = penTransform(tokens, random);
    const output = []; let cursor = { x: 0, y: 0 }, start = cursor;
    for (let i = 0; i < tokens.length;) {
        const command = tokens[i++];
        if (command === 'Z') { output.push('Z'); cursor = start; continue; }
        const count = { M: 2, L: 2, Q: 4, C: 6 }[command];
        if (!count) throw new Error(`Unsupported sketch path command ${command}`);
        const values = tokens.slice(i, i + count).map(Number); i += count;
        if (closed) for (let j = 0; j < count; j += 2) {
            const transformed = transform(values[j], values[j + 1]);
            values[j] = transformed[0]; values[j + 1] = transformed[1];
        }
        const end = { x: values.at(-2), y: values.at(-1) };
        if (command === 'L') {
            output.push(...penLine(cursor, end, random));
        } else {
            if (command === 'M') start = end;
            output.push(`${command} ${values.join(' ')}`);
        }
        cursor = end;
    }
    return output.join(' ');
}
function samplePen(path) {
    const tokens = path.match(/[MCQZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi);
    const points = []; let cursor = { x: 0, y: 0 };
    for (let index = 0; index < tokens.length;) {
        const command = tokens[index++];
        if (command === 'Z') continue;
        const count = { M: 2, Q: 4, C: 6 }[command];
        const values = tokens.slice(index, index + count).map(Number); index += count;
        const end = { x: values.at(-2), y: values.at(-1) };
        if (command === 'M') points.push(end);
        else for (let step = 1; step <= 20; step++) {
            const t = step / 20, u = 1 - t, point = {};
            for (const [axis, offset] of [['x', 0], ['y', 1]]) {
                if (command === 'Q') point[axis] = u * u * cursor[axis] + 2 * u * t * values[offset] + t * t * end[axis];
                else point[axis] = u ** 3 * cursor[axis] + 3 * u * u * t * values[offset] + 3 * u * t * t * values[offset + 2] + t ** 3 * end[axis];
            }
            if (Math.hypot(point.x - points.at(-1).x, point.y - points.at(-1).y) > .001) points.push(point);
        }
        cursor = end;
    }
    return points;
}
// Filled ink ribbons vary in thickness, unlike a uniform SVG stroke. The same
// outline is generated in Python for saved previews; no raster filter is used.
export function inkOutline(path, id, weight) {
    const points = samplePen(path);
    if (points.length < 2) return '';
    const random = randomFor(id, 7), phase = random() * Math.PI;
    const closed = path.trim().endsWith('Z');
    const total = points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);
    const left = [], right = []; let distance = 0;
    points.forEach((point, index) => {
        let before = points[Math.max(0, index - 1)], after = points[Math.min(points.length - 1, index + 1)];
        if (closed && index === 0) before = points.at(-2);
        if (closed && index === points.length - 1) after = points[1];
        const dx = after.x - before.x, dy = after.y - before.y, length = Math.hypot(dx, dy);
        if (length < .001) return;
        if (index > 0) distance += Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y);
        const t = distance / total;
        let pressure = .95 + .15 * Math.sin(Math.PI * t);
        if (closed) pressure = 1.2 + .2 * Math.cos(2 * Math.PI * t + phase);
        const radius = weight * pressure;
        left.push(`${point.x - dy / length * radius} ${point.y + dx / length * radius}`);
        right.push(`${point.x + dy / length * radius} ${point.y - dx / length * radius}`);
    });
    return `M ${left.join(' L ')} L ${right.reverse().join(' L ')} Z`;
}
export function shapePath(shape) {
    const { x, y, width: w, height: h } = shape;
    if (shape.type === 'diamond') return `M ${x + w / 2} ${y} L ${x + w} ${y + h / 2} L ${x + w / 2} ${y + h} L ${x} ${y + h / 2} L ${x + w / 2} ${y} Z`;
    if (shape.type === 'ellipse') {
        const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2, k = .5522847498;
        return `M ${cx + rx} ${cy} C ${cx + rx} ${cy + ry * k} ${cx + rx * k} ${cy + ry} ${cx} ${cy + ry} C ${cx - rx * k} ${cy + ry} ${cx - rx} ${cy + ry * k} ${cx - rx} ${cy} C ${cx - rx} ${cy - ry * k} ${cx - rx * k} ${cy - ry} ${cx} ${cy - ry} C ${cx + rx * k} ${cy - ry} ${cx + rx} ${cy - ry * k} ${cx + rx} ${cy} Z`;
    }
    const r = shape.type === 'rounded' ? 12 : 0;
    return `M ${x + r} ${y} L ${x + w - r} ${y} Q ${x + w} ${y} ${x + w} ${y + r} L ${x + w} ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} L ${x + r} ${y + h} Q ${x} ${y + h} ${x} ${y + h - r} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} Z`;
}
