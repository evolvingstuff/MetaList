import { emptyDiagram, upgradeDiagram, createShape, bounds, resizeShape, removeSelection,
    duplicateSelection, DiagramHistory, clamp, snap, SHAPE_LIMIT, ARROW_LIMIT } from './diagram-model.js';
import { renderCanvas, svgNode, icon } from './diagram-canvas.js';
export { emptyDiagram };

const TOOLS = [['select', 'Select', 'V'], ['hand', 'Pan', 'H'], ['rectangle', 'Rectangle', 'R'],
    ['rounded', 'Rounded rectangle', 'U'], ['ellipse', 'Ellipse', 'O'], ['diamond', 'Diamond', 'D'],
    ['text', 'Text', 'T'], ['arrow', 'Connect shapes', 'A']];
const DRAW_TOOLS = new Set(['rectangle', 'rounded', 'ellipse', 'diamond', 'text']);
const STYLE = { fill: '#dbeafe', stroke: '#334155', font_size: 18, stroke_width: 2 };

export function mountDiagramEditor(container, state) {
    state.draft = upgradeDiagram(state.draft);
    const history = new DiagramHistory(state);
    let selected = new Set(), tool = 'select', connectingId = '', drag = null, space = false;
    let textSession = null, disposed = false, hasFitted = false;
    let camera = { x: -80, y: -80, zoom: 1 };
    const defaults = { ...STYLE };
    container.innerHTML = `
        <div class="diagram-toolstrip" role="toolbar" aria-label="Diagram tools">
            <div class="diagram-toolgroup">${TOOLS.map(([id, label, key]) => `<button type="button" data-tool="${id}" title="${label} (${key})" aria-label="${label}" aria-pressed="false">${icon(id)}</button>`).join('')}</div>
            <div class="diagram-toolgroup">${['undo', 'redo'].map(id => `<button type="button" data-action="${id}" title="${id === 'undo' ? 'Undo' : 'Redo'}" aria-label="${id === 'undo' ? 'Undo' : 'Redo'}">${icon(id)}</button>`).join('')}</div>
        </div>
        <div class="diagram-properties" aria-label="Selection properties" hidden>
            <span data-selection-count></span>
            <label data-fill-label>Fill <input type="color" data-style="fill" aria-label="Fill color"></label>
            <label data-transparent-label><input type="checkbox" data-transparent>None</label>
            <label>Stroke <input type="color" data-style="stroke" aria-label="Stroke and text color"></label>
            <label>Weight <select data-style="stroke_width"><option value="1">Thin</option><option value="2">Regular</option><option value="4">Thick</option></select></label>
            <label data-font-label>Text <select data-style="font_size"><option value="14">Small</option><option value="18">Medium</option><option value="24">Large</option><option value="32">Huge</option></select></label>
            <button type="button" data-action="label">Edit text</button>
            <button type="button" data-action="duplicate" aria-label="Duplicate selection" title="Duplicate (⌘/Ctrl+D)">${icon('duplicate')}</button>
            <button type="button" data-action="delete" aria-label="Delete selection" title="Delete">${icon('delete')}</button>
        </div>
        <div class="diagram-stage">
            <svg class="diagram-canvas" tabindex="0" role="application" aria-label="Diagram canvas. Select a tool to draw. Space and drag to pan. Control or Command and scroll to zoom.">
                <defs><pattern id="diagram-grid" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="0.65" fill="#d5dce8"/></pattern></defs>
                <rect data-grid fill="url(#diagram-grid)" pointer-events="none"/>
                <g data-scene></g><g data-overlay pointer-events="none"></g>
            </svg>
            <div class="diagram-empty" data-empty><strong>Make your first connection</strong><span>Choose a shape, then click or drag on the canvas.</span></div>
            <textarea class="diagram-inline-text" aria-label="Shape text" maxlength="500" spellcheck="true" hidden></textarea>
            <div class="diagram-zoom" aria-label="Canvas view">
                <button type="button" data-action="zoom-out" aria-label="Zoom out">−</button>
                <button type="button" data-action="actual" title="Reset zoom to 100%" data-zoom-label>100%</button>
                <button type="button" data-action="zoom-in" aria-label="Zoom in">+</button>
                <button type="button" data-action="fit" title="Fit diagram (F)">Fit</button>
            </div>
        </div>
        <footer class="diagram-status"><span data-hint role="status"></span><label><input type="checkbox" data-snap>Snap to grid</label></footer>`;
    const canvas = container.querySelector('.diagram-canvas');
    const stage = container.querySelector('.diagram-stage');
    const scene = container.querySelector('[data-scene]');
    const overlay = container.querySelector('[data-overlay]');
    const textarea = container.querySelector('textarea');
    const properties = container.querySelector('.diagram-properties');
    // Selection controls overlay the canvas, so showing them cannot shift a drag.
    stage.prepend(properties);
    const hint = container.querySelector('[data-hint]');
    const gridEnabled = () => container.querySelector('[data-snap]').checked;
    const source = () => state.draft.source;
    const shapeById = id => source().shapes.find(shape => shape.id === id);
    const selectedShapes = () => source().shapes.filter(shape => selected.has(shape.id));
    const snapshot = () => structuredClone(state.draft);
    const screen = event => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const world = event => { const point = screen(event); return { x: camera.x + point.x / camera.zoom, y: camera.y + point.y / camera.zoom }; };
    const focusCanvas = () => canvas.focus({ preventScroll: true });

    function positionText() {
        if (!textSession) return;
        const shape = shapeById(textSession.id);
        Object.assign(textarea.style, { left: `${(shape.x - camera.x) * camera.zoom}px`, top: `${(shape.y - camera.y) * camera.zoom}px`,
            width: `${shape.width * camera.zoom}px`, height: `${shape.height * camera.zoom}px`, fontSize: `${shape.font_size * camera.zoom}px`, color: shape.stroke });
    }
    function renderView() {
        if (disposed) return;
        // mount runs before showModal; wait for a measurable viewport.
        if (!canvas.clientWidth || !canvas.clientHeight) return;
        const width = canvas.clientWidth / camera.zoom, height = canvas.clientHeight / camera.zoom;
        canvas.setAttribute('viewBox', `${camera.x} ${camera.y} ${width} ${height}`);
        const grid = container.querySelector('[data-grid]');
        for (const [key, value] of Object.entries({ x: camera.x, y: camera.y, width, height })) grid.setAttribute(key, String(value));
        container.querySelector('[data-zoom-label]').textContent = `${Math.round(camera.zoom * 100)}%`;
        renderCanvas(scene, source(), selected, camera.zoom, connectingId);
        positionText();
    }
    function setHint(message) { hint.textContent = message; }
    function render() {
        const all = [...source().shapes, ...source().arrows];
        selected = new Set([...selected].filter(id => all.some(item => item.id === id)));
        if (connectingId && !shapeById(connectingId)) connectingId = '';
        for (const button of container.querySelectorAll('[data-tool]')) button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
        canvas.dataset.tool = space ? 'hand' : tool;
        container.querySelector('[data-action="undo"]').disabled = !history.past.length;
        container.querySelector('[data-action="redo"]').disabled = !history.future.length;
        container.querySelector('[data-empty]').hidden = source().shapes.length > 0;
        properties.hidden = !selected.size;
        container.querySelector('[data-selection-count]').textContent = `${selected.size} selected`;
        const shapes = selectedShapes();
        const chosen = all.find(item => selected.has(item.id));
        if (chosen) {
            for (const input of properties.querySelectorAll('[data-style]')) {
                const key = input.dataset.style;
                if (Object.hasOwn(chosen, key)) {
                    const value = chosen[key] === 'none' ? '#ffffff' : String(chosen[key]);
                    if (input.tagName === 'SELECT' && !Array.from(input.options).some(option => option.value === value)) {
                        input.add(new Option(value, value));
                    }
                    input.value = value;
                }
            }
            container.querySelector('[data-transparent]').checked = chosen.fill === 'none';
        }
        for (const key of ['fill', 'transparent', 'font']) container.querySelector(`[data-${key}-label]`).hidden = !shapes.length;
        container.querySelector('[data-action="label"]').disabled = shapes.length !== 1;
        container.querySelector('[data-action="duplicate"]').disabled = !shapes.length;
        setHint(connectingId ? 'Click the destination shape. Escape cancels the arrow.' : tool === 'arrow'
            ? 'Click a shape, then another shape to connect them.' : DRAW_TOOLS.has(tool)
                ? 'Click to place, or drag to choose a size.' : tool === 'hand' || space
                    ? 'Drag to pan.' : 'Double-click to edit text · Shift-click to select more · Space-drag to pan');
        renderView();
    }
    function commit(before) { history.commit(before); render(); }
    function finishText(save) {
        if (!textSession) return;
        const session = textSession;
        textSession = null;
        if (save) {
            const before = snapshot();
            shapeById(session.id).label = textarea.value;
            history.commit(before);
        }
        textarea.hidden = true;
        render();
    }
    function editText(id) {
        finishText(true);
        const shape = shapeById(id);
        if (!shape) return;
        selected = new Set([id]); tool = 'select'; connectingId = '';
        textSession = { id };
        textarea.value = shape.label;
        textarea.hidden = false;
        render();
        textarea.focus(); textarea.select();
    }
    function setTool(next) {
        finishText(true);
        tool = next; connectingId = ''; overlay.replaceChildren();
        render(); focusCanvas();
    }
    function zoomAt(zoom, point) {
        const next = clamp(zoom, .1, 4);
        camera.x += point.x / camera.zoom - point.x / next;
        camera.y += point.y / camera.zoom - point.y / next;
        camera.zoom = next;
        renderView();
    }
    function fit() {
        if (!canvas.clientWidth || !canvas.clientHeight) return;
        const box = bounds(source().shapes);
        camera.zoom = clamp(Math.min(canvas.clientWidth / (box.width + 120), canvas.clientHeight / (box.height + 120)), .1, 1.5);
        camera.x = box.x + box.width / 2 - canvas.clientWidth / camera.zoom / 2;
        camera.y = box.y + box.height / 2 - canvas.clientHeight / camera.zoom / 2;
        hasFitted = true; renderView();
    }
    function act(action) {
        finishText(true);
        if (drag) return;
        const before = snapshot();
        if (action === 'undo') history.undo();
        else if (action === 'redo') history.redo();
        else if (action === 'delete') { state.draft.source = removeSelection(source(), selected); selected.clear(); history.commit(before); }
        else if (action === 'duplicate') {
            const copy = duplicateSelection(source(), selected, () => crypto.randomUUID());
            if (!copy) { setHint('Diagram limit reached. Delete shapes or arrows before duplicating.'); return; }
            state.draft.source = copy.source; selected = copy.selected; history.commit(before);
        } else if (action === 'label') { if (selectedShapes().length === 1) editText(selectedShapes()[0].id); return; }
        else if (action === 'fit') fit();
        else if (['zoom-in', 'zoom-out', 'actual'].includes(action)) {
            let zoom = 1;
            if (action === 'zoom-in') zoom = camera.zoom * 1.25;
            if (action === 'zoom-out') zoom = camera.zoom / 1.25;
            zoomAt(zoom, { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });
        }
        render(); focusCanvas();
    }
    container.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button || state.saving) return;
        if (button.dataset.tool) setTool(button.dataset.tool);
        if (button.dataset.action) act(button.dataset.action);
    });
    properties.addEventListener('change', event => {
        const input = event.target;
        const key = input.dataset.style;
        const before = snapshot();
        if (key) {
            const value = ['font_size', 'stroke_width'].includes(key) ? Number(input.value) : input.value;
            defaults[key] = value;
            for (const item of [...source().shapes, ...source().arrows]) if (selected.has(item.id) && Object.hasOwn(item, key)) item[key] = value;
        } else if (input.hasAttribute('data-transparent')) {
            const fill = input.checked ? 'none' : defaults.fill;
            for (const shape of selectedShapes()) shape.fill = fill;
        }
        commit(before);
    });
    textarea.addEventListener('blur', () => finishText(true));
    textarea.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); finishText(false); focusCanvas(); }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); finishText(true); focusCanvas(); }
        event.stopPropagation();
    });

    canvas.addEventListener('pointerdown', event => {
        if (state.saving || drag || ![0, 1].includes(event.button)) return;
        finishText(true); focusCanvas(); event.preventDefault();
        const start = world(event), pixel = screen(event), before = snapshot();
        const node = event.target.closest('[data-shape-id], [data-arrow-id]');
        const id = node ? (node.dataset.shapeId || node.dataset.arrowId) : '';
        if (tool === 'hand' || space || event.button === 1) drag = { kind: 'pan', pixel, camera: { ...camera }, before };
        else if (tool === 'arrow') {
            if (!node?.dataset.shapeId) { connectingId = ''; render(); return; }
            if (!connectingId) connectingId = id;
            else if (connectingId !== id) {
                if (source().arrows.length >= ARROW_LIMIT) { setHint('This diagram has reached its arrow limit.'); return; }
                const arrow = { id: crypto.randomUUID(), from_id: connectingId, to_id: id, stroke: defaults.stroke, stroke_width: defaults.stroke_width };
                source().arrows.push(arrow); selected = new Set([arrow.id]); connectingId = ''; tool = 'select'; commit(before);
            }
            render(); return;
        } else if (DRAW_TOOLS.has(tool)) {
            if (source().shapes.length >= SHAPE_LIMIT) { setHint('This diagram has reached its shape limit.'); return; }
            const shape = createShape(tool, clamp(snap(start.x, gridEnabled()), -100000, 100000), clamp(snap(start.y, gridEnabled()), -100000, 100000), defaults, crypto.randomUUID());
            source().shapes.push(shape); selected = new Set([shape.id]);
            drag = { kind: 'draw', start, pixel, before, id: shape.id, moved: false };
        } else if (node?.dataset.resize) {
            selected = new Set([id]);
            drag = { kind: 'resize', start, before, original: { ...shapeById(id) }, handle: node.dataset.resize };
        } else if (id) {
            if (event.shiftKey) {
                if (selected.has(id)) selected.delete(id); else selected.add(id);
            } else if (!selected.has(id)) selected = new Set([id]);
            if (selected.has(id) && node.dataset.shapeId) drag = { kind: 'move', start, before, shapes: selectedShapes().map(shape => ({ ...shape })) };
        } else {
            if (!event.shiftKey) selected.clear();
            drag = { kind: 'marquee', start, before, selected: new Set(selected) };
        }
        if (drag) { drag.pointerId = event.pointerId; canvas.setPointerCapture(event.pointerId); }
        render();
    });
    canvas.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const point = world(event), dx = point.x - drag.start?.x, dy = point.y - drag.start?.y;
        if (drag.kind === 'pan') {
            const pixel = screen(event);
            camera.x = drag.camera.x - (pixel.x - drag.pixel.x) / camera.zoom;
            camera.y = drag.camera.y - (pixel.y - drag.pixel.y) / camera.zoom;
        } else if (drag.kind === 'move') {
            const box = bounds(drag.shapes);
            const moveX = clamp(snap(dx, gridEnabled()), -100000 - box.x, 100000 - Math.max(...drag.shapes.map(shape => shape.x)));
            const moveY = clamp(snap(dy, gridEnabled()), -100000 - box.y, 100000 - Math.max(...drag.shapes.map(shape => shape.y)));
            for (const original of drag.shapes) Object.assign(shapeById(original.id), { x: original.x + moveX, y: original.y + moveY });
        } else if (drag.kind === 'resize') Object.assign(shapeById(drag.original.id), resizeShape(drag.original, drag.handle, dx, dy, gridEnabled()));
        else if (drag.kind === 'draw') {
            const pixel = screen(event);
            if (Math.hypot(pixel.x - drag.pixel.x, pixel.y - drag.pixel.y) > 4) drag.moved = true;
            if (drag.moved) Object.assign(shapeById(drag.id), {
                x: clamp(snap(Math.min(drag.start.x, point.x), gridEnabled()), -100000, 100000),
                y: clamp(snap(Math.min(drag.start.y, point.y), gridEnabled()), -100000, 100000),
                width: clamp(snap(Math.abs(dx), gridEnabled()), 40, 4000), height: clamp(snap(Math.abs(dy), gridEnabled()), 40, 4000),
            });
        } else if (drag.kind === 'marquee') {
            const x = Math.min(drag.start.x, point.x), y = Math.min(drag.start.y, point.y), width = Math.abs(dx), height = Math.abs(dy);
            selected = new Set(drag.selected);
            for (const shape of source().shapes) if (shape.x >= x && shape.y >= y && shape.x + shape.width <= x + width && shape.y + shape.height <= y + height) selected.add(shape.id);
            overlay.replaceChildren(svgNode('rect', { x, y, width, height, fill: '#6366f118', stroke: '#6366f1', 'stroke-width': 1 / camera.zoom }));
        }
        renderView();
    });
    function finishDrag(cancel) {
        if (!drag) return;
        const ended = drag; drag = null;
        if (cancel) state.draft = ended.before;
        else history.commit(ended.before);
        if (canvas.hasPointerCapture(ended.pointerId)) canvas.releasePointerCapture(ended.pointerId);
        overlay.replaceChildren();
        if (ended.kind === 'draw') tool = 'select';
        render();
        if (!cancel && ended.kind === 'draw' && shapeById(ended.id).type === 'text') editText(ended.id);
    }
    canvas.addEventListener('pointerup', () => finishDrag(false));
    canvas.addEventListener('pointercancel', () => finishDrag(true));
    canvas.addEventListener('lostpointercapture', () => finishDrag(true));
    canvas.addEventListener('dblclick', event => {
        const node = event.target.closest('[data-shape-id]');
        if (node && tool === 'select') editText(node.dataset.shapeId);
    });
    canvas.addEventListener('wheel', event => {
        event.preventDefault();
        if (drag) return;
        finishText(true);
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
        if (event.ctrlKey || event.metaKey) zoomAt(camera.zoom * Math.exp(-event.deltaY * unit * .005), screen(event));
        else { camera.x += event.deltaX * unit / camera.zoom; camera.y += event.deltaY * unit / camera.zoom; renderView(); }
    }, { passive: false });
    container.addEventListener('keydown', event => {
        if (state.saving || event.target.closest('input, textarea, select')) return;
        const key = event.key.toLowerCase();
        let modifier = false;
        if (event.metaKey) modifier = true;
        else if (event.ctrlKey) modifier = true;
        if (event.key === 'Escape') {
            if (drag) finishDrag(true);
            else if (tool !== 'select' || connectingId) setTool('select');
            else return;
            event.preventDefault(); event.stopPropagation(); return;
        }
        if (modifier && ['z', 'y', 'd', 'a'].includes(key)) {
            event.preventDefault();
            if (key === 'a') { selected = new Set([...source().shapes, ...source().arrows].map(item => item.id)); render(); }
            else act(key === 'd' ? 'duplicate' : key === 'y' || event.shiftKey ? 'redo' : 'undo');
        } else if (!modifier && event.target === canvas) {
            if (key === ' ') { event.preventDefault(); space = true; render(); }
            else if (['delete', 'backspace'].includes(key)) { event.preventDefault(); act('delete'); }
            else if (key === 'enter' && selectedShapes().length === 1) { event.preventDefault(); editText(selectedShapes()[0].id); }
            else if (key === 'f') { event.preventDefault(); fit(); }
            else if (key.startsWith('arrow') && !drag) {
                event.preventDefault(); const before = snapshot(), step = event.shiftKey ? 10 : 1;
                for (const shape of selectedShapes()) {
                    if (key === 'arrowleft') shape.x = clamp(shape.x - step, -100000, 100000);
                    if (key === 'arrowright') shape.x = clamp(shape.x + step, -100000, 100000);
                    if (key === 'arrowup') shape.y = clamp(shape.y - step, -100000, 100000);
                    if (key === 'arrowdown') shape.y = clamp(shape.y + step, -100000, 100000);
                }
                commit(before);
            } else {
                const match = TOOLS.find(([, , shortcut]) => shortcut.toLowerCase() === key);
                if (match) { event.preventDefault(); setTool(match[0]); }
            }
        }
    });
    container.addEventListener('keyup', event => { if (event.key === ' ') { space = false; render(); } });
    canvas.addEventListener('blur', () => { space = false; });
    const observer = new ResizeObserver(() => { if (!hasFitted) fit(); else renderView(); });
    observer.observe(stage);
    render();
    return { focus: () => { fit(); focusCanvas(); }, flush: () => { finishText(true); finishDrag(false); },
        destroy: () => { disposed = true; observer.disconnect(); } };
}
