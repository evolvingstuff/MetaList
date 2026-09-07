import { emptyDiagram, upgradeDocument, newShape, newArrow, objects, getObject, free, anchors, routePoints, cleanPoints,
    snapPoint, documentBounds, labelBox, growShape, expandSelection, moveObjects, groupObjects, ungroupObjects,
    reorder, removeObjects, copyObjects, connectionAt, endpointPosition, draggedArrow, geometryWithinLimits, run, DiagramHistory } from './diagram-document.js';
import { clamp } from './diagram-model.js';
import { renderScene, arrowNode, svgNode, icon } from './diagram-scene.js';
import { createTextEditor, readRuns, writeRuns } from './diagram-text-editor.js';
export { emptyDiagram };

const TOOLS = [['select', 'Select', 'V'], ['hand', 'Pan', 'H'], ['rectangle', 'Rectangle', 'R'],
    ['rounded', 'Rounded rectangle', 'U'], ['text', 'Text', 'T'], ['arrow', 'Arrow', 'A']];
const ACTIONS = [['label', 'Edit text'], ['duplicate', 'Duplicate'], ['delete', 'Delete'], ['group', 'Group'],
    ['ungroup', 'Ungroup'], ['front', 'Bring to front'], ['back', 'Send to back']];
const SHAPES = new Set(['rectangle', 'rounded', 'text', 'ellipse', 'diamond']);

export function mountDiagramEditor(container, state) {
    state.draft = upgradeDocument(state.draft);
    const history = new DiagramHistory(state);
    let selected = new Set(), tool = 'select', drag = null, pending = null, hover = null, textSession = null;
    let camera = { x: -80, y: -80, zoom: 1 }, space = false, fitted = false, disposed = false, lastFinish = -1000;
    let clipboard = null, contextPoint = null;
    const source = () => state.draft.source;
    const snapshot = () => structuredClone(state.draft);
    const chosen = () => objects(source()).filter(item => selected.has(item.id));
    const byId = id => getObject(source(), id);
    const button = ([id, label]) => `<button type="button" data-action="${id}">${label}</button>`;
    container.innerHTML = `
      <div class="diagram-toolstrip" role="toolbar" aria-label="Diagram tools">
        <div class="diagram-toolgroup">${TOOLS.map(([id, label, key]) => `<button type="button" data-tool="${id}" title="${label} (${key})" aria-label="${label}">${icon(id)}</button>`).join('')}
          <select data-more-shapes aria-label="Other shapes"><option value="">More shapes</option><option value="ellipse">Ellipse</option><option value="diamond">Diamond</option></select></div>
        <div class="diagram-toolgroup">${['undo', 'redo'].map(id => `<button type="button" data-action="${id}" title="${id}" aria-label="${id}">${icon(id)}</button>`).join('')}</div>
      </div>
      <div class="diagram-workspace">
        <div class="diagram-stage">
          <svg class="diagram-canvas" tabindex="0" role="application" aria-label="Diagram canvas. Arrow tool: click route points, Enter to finish, Escape to cancel.">
            <defs><pattern id="diagram-grid" width="10" height="10" patternUnits="userSpaceOnUse"><path data-grid-lines d="M 10 0 L 0 0 0 10" fill="none" stroke="#d8dee8" stroke-width="0.6"/></pattern></defs>
            <rect data-grid fill="url(#diagram-grid)" pointer-events="none"/><g data-scene></g><g data-overlay></g><g data-preview pointer-events="none"></g>
          </svg>
          <div class="diagram-rich-text" contenteditable="true" role="textbox" aria-label="Diagram label" aria-multiline="true" spellcheck="true" hidden></div>
          <div class="diagram-zoom">${[['zoom-out', '−'], ['actual', '100%'], ['zoom-in', '+'], ['fit', 'Fit']].map(button).join('')}</div>
          <div class="diagram-context" role="menu" hidden>${ACTIONS.map(button).join('')}${[['add-bend', 'Add bend here'], ['remove-bend', 'Remove bend'], ['detach-start', 'Detach start'], ['detach-end', 'Detach end']].map(button).join('')}</div>
        </div>
        <aside class="diagram-inspector" aria-label="Diagram properties">
          <strong data-selection-title>Nothing selected</strong>
          <fieldset data-appearance><legend>Appearance</legend>
            <label>Fill <input type="color" data-style="fill" value="#dbeafe"></label>
            <label><input type="checkbox" data-transparent>Transparent fill</label>
            <label>Outline / line <input type="color" data-style="stroke" value="#334155"></label>
            <label>Thickness <select data-style="stroke_width">${[1, 2, 3, 4, 5, 6].map(n => `<option>${n}</option>`).join('')}</select></label>
          </fieldset>
          <fieldset data-lettering><legend>Text</legend>
            <label>Size <select data-style="font_size">${[12, 14, 16, 18, 20, 24, 28, 32, 40, 48].map(n => `<option>${n}</option>`).join('')}</select></label>
            <div class="diagram-format-buttons"><button type="button" data-format="bold" title="Bold (⌘/Ctrl+B)"><b>Bold</b></button><button type="button" data-format="italic" title="Italic (⌘/Ctrl+I)"><i>Italic</i></button></div>
            <label>Font color <input type="color" data-format="color" value="#334155"></label>
            <button type="button" data-action="label">Edit text</button>
          </fieldset>
          <fieldset data-arrow-properties><legend>Arrow</legend>
            <label><input type="checkbox" data-style="start_head">Start arrowhead</label>
            <label><input type="checkbox" data-style="end_head">End arrowhead</label>
            <label>Path <select data-style="routing"><option value="orthogonal">Rounded bends</option><option value="straight">Straight</option></select></label>
          </fieldset>
          <div class="diagram-arrange">${ACTIONS.filter(([id]) => id !== 'label').map(button).join('')}</div>
        </aside>
      </div>
      <footer class="diagram-status"><span data-hint role="status"></span><div class="diagram-grid-options"><label><input type="checkbox" data-grid-option="visible">Grid</label><label><input type="checkbox" data-grid-option="snap">Snap</label><label>Spacing <input type="number" min="5" max="100" step="5" data-grid-option="size" autocomplete="off"></label></div></footer>`;
    const canvas = container.querySelector('.diagram-canvas'), stage = container.querySelector('.diagram-stage');
    const scene = container.querySelector('[data-scene]'), overlay = container.querySelector('[data-overlay]'), preview = container.querySelector('[data-preview]');
    const editor = container.querySelector('.diagram-rich-text'), inspector = container.querySelector('.diagram-inspector');
    const menu = container.querySelector('.diagram-context'), hint = container.querySelector('[data-hint]');
    const focus = () => canvas.focus({ preventScroll: true });
    const screen = event => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const world = event => { const p = screen(event); return { x: camera.x + p.x / camera.zoom, y: camera.y + p.y / camera.zoom }; };
    const snapped = (p, event) => snapPoint(p, source().grid, event.altKey);
    const connection = (p, event) => {
        if (!event.altKey) { const attached = connectionAt(source(), p, 14 / camera.zoom); if (attached.kind !== 'free') return attached; }
        return free(snapped(p, event));
    };
    function setHint(text) { hint.textContent = text; }
    function positionEditor() {
        if (!textSession) return;
        const item = byId(textSession.id), box = labelBox(source(), item);
        Object.assign(editor.style, { left: `${(box.x - camera.x) * camera.zoom}px`, top: `${(box.y - camera.y) * camera.zoom}px`,
            width: `${box.width * camera.zoom}px`, minHeight: `${box.height * camera.zoom}px`, fontSize: `${item.font_size * camera.zoom}px`, padding: `${12 * camera.zoom}px` });
    }
    function drawPreview() {
        preview.replaceChildren();
        if (pending) {
            const end = hover ? hover : pending.end;
            const arrow = newArrow(pending.start, end, pending.points, 'preview');
            preview.append(arrowNode(source(), arrow, camera.zoom));
        }
        if (hover && hover.kind !== 'free') {
            const p = endpointPosition(source(), hover, { x: 0, y: 0 });
            preview.append(svgNode('circle', { cx: p.x, cy: p.y, r: 7 / camera.zoom, fill: '#22c55e', stroke: '#fff', 'stroke-width': 2 / camera.zoom }));
        }
    }
    function renderView() {
        if (disposed || !canvas.clientWidth || !canvas.clientHeight) return;
        const width = canvas.clientWidth / camera.zoom, height = canvas.clientHeight / camera.zoom;
        canvas.setAttribute('viewBox', `${camera.x} ${camera.y} ${width} ${height}`);
        const grid = container.querySelector('[data-grid]');
        for (const [key, value] of Object.entries({ x: camera.x, y: camera.y, width, height })) grid.setAttribute(key, String(value));
        grid.style.display = source().grid.visible ? '' : 'none';
        const pattern = container.querySelector('pattern'), size = source().grid.size;
        pattern.setAttribute('width', size); pattern.setAttribute('height', size);
        container.querySelector('[data-grid-lines]').setAttribute('d', `M ${size} 0 L 0 0 0 ${size}`);
        container.querySelector('[data-action="actual"]').textContent = `${Math.round(camera.zoom * 100)}%`;
        let showPorts = tool === 'arrow';
        if (drag?.kind === 'endpoint') showPorts = true;
        renderScene(scene, overlay, source(), selected, camera.zoom, showPorts);
        positionEditor(); drawPreview();
    }
    function syncProperties() {
        const items = chosen(), shapes = items.filter(item => Object.hasOwn(item, 'width'));
        container.querySelector('[data-selection-title]').textContent = items.length ? `${items.length} selected` : 'Nothing selected';
        container.querySelector('[data-appearance]').disabled = !items.length;
        container.querySelector('[data-lettering]').disabled = !items.length;
        container.querySelector('[data-arrow-properties]').disabled = !items.some(item => Object.hasOwn(item, 'points'));
        for (const input of inspector.querySelectorAll('[data-style]')) {
            const key = input.dataset.style, values = items.filter(item => Object.hasOwn(item, key)).map(item => item[key]);
            const mixed = new Set(values).size > 1;
            input.disabled = !values.length; input.title = mixed ? 'Mixed values' : '';
            input.closest('label').classList.toggle('diagram-mixed', mixed);
            if (input.type === 'checkbox') { input.indeterminate = mixed; input.checked = values[0] === true; }
            else if (values.length && !mixed) {
                const value = values[0] === 'none' ? '#ffffff' : String(values[0]);
                if (input.tagName === 'SELECT' && !Array.from(input.options).some(option => option.value === value)) input.add(new Option(value, value));
                input.value = value;
            } else if (input.tagName === 'SELECT') input.selectedIndex = -1;
        }
        const transparent = inspector.querySelector('[data-transparent]');
        transparent.disabled = !shapes.length; transparent.checked = shapes.length > 0 && shapes.every(item => item.fill === 'none');
        transparent.indeterminate = shapes.some(item => item.fill === 'none') && !transparent.checked;
        const runs = items.flatMap(item => item.runs);
        for (const input of inspector.querySelectorAll('[data-format]')) {
            const key = input.dataset.format, values = runs.map(run => run[key]), mixed = new Set(values).size > 1;
            input.title = mixed ? 'Mixed values' : key;
            if (key === 'color') { input.closest('label').classList.toggle('diagram-mixed', mixed); if (values.length && !mixed) input.value = values[0]; }
            else input.setAttribute('aria-pressed', mixed ? 'mixed' : String(values.length > 0 && values.every(Boolean)));
        }
        for (const button of inspector.querySelectorAll('[data-action]')) {
            button.disabled = !items.length;
            if (button.dataset.action === 'label') button.disabled = items.length !== 1;
            if (button.dataset.action === 'group') button.disabled = items.length < 2;
            if (button.dataset.action === 'ungroup') button.disabled = !source().groups.some(g => g.members.some(id => selected.has(id)));
        }
    }
    function render() {
        const ids = new Set(source().order); selected = new Set([...selected].filter(id => ids.has(id)));
        for (const button of container.querySelectorAll('[data-tool]')) button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
        canvas.dataset.tool = space ? 'hand' : tool;
        container.querySelector('[data-action="undo"]').disabled = !history.past.length;
        container.querySelector('[data-action="redo"]').disabled = !history.future.length;
        for (const input of container.querySelectorAll('[data-grid-option]')) {
            const value = source().grid[input.dataset.gridOption];
            if (input.type === 'checkbox') input.checked = value; else input.value = value;
        }
        if (!textSession) syncProperties();
        setHint(pending ? 'Click bends · Enter or double-click to finish · Backspace removes a bend · Esc cancels' : tool === 'arrow'
            ? 'Start at a box connection point or empty space' : 'Double-click to edit text · Shift-click to select · Space-drag to pan · Option bypasses snap');
        renderView();
    }
    function commit(before) { history.commit(before); render(); }
    const textControl = createTextEditor(editor, () => {
        if (!textSession) return;
        const runs = readRuns(editor);
        if (Array.from(runs.map(r => r.text).join('')).length > 5000) { setHint('Labels are limited to 5,000 characters. Shorten this label before saving.'); return; }
        const item = byId(textSession.id); item.runs = runs;
        if (Object.hasOwn(item, 'height')) growShape(item);
        renderView();
    });
    function finishText(save) {
        if (!textSession) return true;
        if (save && Array.from(readRuns(editor).map(r => r.text).join('')).length > 5000) { setHint('Shorten this label to 5,000 characters before continuing.'); editor.focus(); return false; }
        const ended = textSession; textSession = null; editor.hidden = true; textControl.reset();
        if (save) history.commit(ended.before); else state.draft = ended.before;
        render(); return true;
    }
    function editText(id) {
        if (!finishText(true)) return;
        const item = byId(id); selected = new Set([id]); pending = null; tool = 'select'; render();
        textSession = { id, before: snapshot() };
        let initialFormat = run('', '#334155');
        if (item.runs.length) initialFormat = item.runs[0];
        Object.assign(editor.style, { color: initialFormat.color, fontWeight: initialFormat.bold ? 'bold' : 'normal', fontStyle: initialFormat.italic ? 'italic' : 'normal' });
        writeRuns(editor, item.runs); textControl.reset(); editor.hidden = false;
        positionEditor(); editor.focus();
        const range = document.createRange(); range.selectNodeContents(editor);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
    function setTool(next) { if (!finishText(true)) return; pending = null; hover = null; tool = next; render(); focus(); }
    function finishArrow() {
        if (!pending) return;
        const arrow = newArrow(pending.start, pending.end, pending.points, crypto.randomUUID());
        const points = routePoints(source(), arrow);
        if (points.length < 2) { pending = null; render(); return; }
        const before = snapshot(); source().arrows.push(arrow); source().order.push(arrow.id);
        selected = new Set([arrow.id]); pending = null; hover = null; tool = 'select'; lastFinish = performance.now(); commit(before);
    }
    function fit() {
        if (!canvas.clientWidth || !canvas.clientHeight) return;
        const box = documentBounds(source()); camera.zoom = clamp(Math.min(canvas.clientWidth / (box.width + 100), canvas.clientHeight / (box.height + 100)), .1, 1.5);
        camera.x = box.x + box.width / 2 - canvas.clientWidth / camera.zoom / 2;
        camera.y = box.y + box.height / 2 - canvas.clientHeight / camera.zoom / 2; fitted = true; renderView();
    }
    function zoomAt(zoom, p) {
        const next = clamp(zoom, .1, 4); camera.x += p.x / camera.zoom - p.x / next; camera.y += p.y / camera.zoom - p.y / next; camera.zoom = next; renderView();
    }
    function pasteSelection() {
        if (!clipboard) return;
        const copied = copyObjects(clipboard, new Set(clipboard.order), () => crypto.randomUUID());
        if (source().shapes.length + copied.shapes.length > 200 || source().arrows.length + copied.arrows.length > 400) { setHint('Diagram object limit reached.'); return; }
        const shifted = moveObjects(copied, new Set(copied.order), 20, 20);
        if (!geometryWithinLimits(shifted)) { setHint('The copy would exceed the diagram coordinate limits.'); return; }
        source().shapes.push(...shifted.shapes); source().arrows.push(...shifted.arrows); source().groups.push(...shifted.groups); source().order.push(...shifted.order);
        selected = new Set(shifted.order);
    }
    function act(action) {
        if (state.saving || drag || !finishText(true)) return;
        menu.hidden = true;
        if (pending) { pending = null; hover = null; }
        const before = snapshot();
        if (action === 'undo') history.undo();
        else if (action === 'redo') history.redo();
        else if (action === 'delete') state.draft.source = removeObjects(source(), selected);
        else if (action === 'copy') clipboard = copyObjects(source(), selected, () => crypto.randomUUID());
        else if (action === 'paste') pasteSelection();
        else if (action === 'duplicate') { clipboard = copyObjects(source(), selected, () => crypto.randomUUID()); pasteSelection(); }
        else if (action === 'group') { state.draft.source = groupObjects(source(), selected, crypto.randomUUID()); selected = expandSelection(source(), selected); }
        else if (action === 'ungroup') state.draft.source = ungroupObjects(source(), selected);
        else if (action === 'front' || action === 'back') state.draft.source = reorder(source(), selected, action === 'front');
        else if (action === 'label') { if (selected.size === 1) editText([...selected][0]); return; }
        else if (action === 'fit') fit();
        else if (['zoom-in', 'zoom-out', 'actual'].includes(action)) {
            let zoom = 1; if (action === 'zoom-in') zoom = camera.zoom * 1.25; if (action === 'zoom-out') zoom = camera.zoom / 1.25;
            zoomAt(zoom, { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });
        } else if (selected.size === 1 && contextPoint) {
            const item = byId([...selected][0]);
            if (Object.hasOwn(item, 'points')) {
                if (action.startsWith('detach-')) { const key = action.slice(7), points = anchors(source(), item); item[key] = free(key === 'start' ? points[0] : points.at(-1)); }
                else if (action === 'remove-bend' && contextPoint.bend > 0) {
                    const points = routePoints(source(), item); if (contextPoint.bend < points.length - 1) points.splice(contextPoint.bend, 1);
                    item.points = points.slice(1, -1); item.routing = 'orthogonal';
                } else if (action === 'add-bend') {
                    const points = routePoints(source(), item); let index = 0, distance = Infinity;
                    for (let i = 0; i < points.length - 1; i++) { const d = Math.hypot(contextPoint.x - (points[i].x + points[i + 1].x) / 2, contextPoint.y - (points[i].y + points[i + 1].y) / 2); if (d < distance) { distance = d; index = i; } }
                    points.splice(index + 1, 0, { x: contextPoint.x, y: contextPoint.y }); item.points = points.slice(1, -1); item.routing = 'orthogonal';
                }
            }
        }
        if (!geometryWithinLimits(source())) { state.draft = before; render(); setHint('Diagram route limit reached. Remove a bend before adding more.'); return; }
        if (!['undo', 'redo'].includes(action)) history.commit(before);
        render(); focus();
    }
    container.addEventListener('click', event => {
        const target = event.target.closest('button'); if (!target || state.saving) return;
        if (target.dataset.tool) setTool(target.dataset.tool);
        if (target.dataset.action) act(target.dataset.action);
        if (target.dataset.format) applyFormat(target.dataset.format, null);
    });
    function applyFormat(key, value) {
        if (textSession) { textControl.format(key, value); return; }
        const before = snapshot(), items = chosen();
        const formats = items.flatMap(item => item.runs);
        const enabled = !(formats.length > 0 && formats.every(r => r[key]));
        for (const item of items) {
            if (!item.runs.length) item.runs = [run('', '#334155')];
            item.runs = item.runs.map(r => ({ ...r, [key]: key === 'color' ? value : enabled })); if (Object.hasOwn(item, 'height')) growShape(item); }
        commit(before);
    }
    container.addEventListener('change', event => {
        if (state.saving) return;
        const input = event.target;
        if (input.hasAttribute('data-more-shapes')) { if (input.value) setTool(input.value); input.value = ''; return; }
        if (input.dataset.format) { applyFormat(input.dataset.format, input.value); return; }
        const before = snapshot();
        if (input.dataset.gridOption) {
            const key = input.dataset.gridOption;
            if (key === 'size') { if (!input.checkValidity() || !Number.isInteger(Number(input.value))) { render(); return; } source().grid.size = Number(input.value); }
            else source().grid[key] = input.checked;
        } else if (input.dataset.style) {
            const key = input.dataset.style; let value = input.value;
            if (['font_size', 'stroke_width'].includes(key)) value = Number(value);
            if (input.type === 'checkbox') value = input.checked;
            for (const item of chosen()) if (Object.hasOwn(item, key)) { item[key] = value; if (Object.hasOwn(item, 'height') && key === 'font_size') growShape(item); }
        } else if (input.hasAttribute('data-transparent')) for (const item of chosen()) if (Object.hasOwn(item, 'fill')) item.fill = input.checked ? 'none' : '#dbeafe';
        if (!textSession) commit(before); else renderView();
    });
    editor.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); finishText(false); focus(); }
        else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (finishText(true)) focus(); }
    });
    editor.addEventListener('focusout', event => {
        if (event.relatedTarget && inspector.contains(event.relatedTarget)) return;
        if (event.relatedTarget && container.contains(event.relatedTarget) && event.relatedTarget !== canvas) finishText(true);
    });
    canvas.addEventListener('pointerdown', event => {
        if (state.saving || drag || ![0, 1].includes(event.button) || !finishText(true)) return;
        menu.hidden = true; focus(); event.preventDefault();
        const start = world(event), pixel = screen(event), before = snapshot(), node = event.target.closest('[data-object]'), id = node ? node.dataset.object : '';
        if (space || tool === 'hand' || event.button === 1) drag = { kind: 'pan', pixel, camera: { ...camera }, before };
        else if (tool === 'arrow') {
            if (source().arrows.length >= 400) { setHint('Arrow limit reached.'); return; }
            const endpoint = connection(start, event);
            if (!pending) pending = { start: endpoint, end: endpoint, points: [] };
            else {
                pending.end = endpoint;
                if (endpoint.kind !== 'free' || event.detail >= 2) finishArrow();
                else {
                    pending.points = cleanPoints([...pending.points, { x: endpoint.x, y: endpoint.y }]);
                    if (pending.points.length > 254) { pending.points.pop(); setHint('Route limit reached; finish this arrow.'); }
                }
            }
            render(); return;
        } else if (SHAPES.has(tool)) {
            if (source().shapes.length >= 200) { setHint('Shape limit reached.'); return; }
            const shape = newShape(tool, snapped(start, event), crypto.randomUUID()); source().shapes.push(shape); source().order.push(shape.id); selected = new Set([shape.id]);
            drag = { kind: 'draw', before, start, pixel, id: shape.id, moved: false };
        } else if (node?.dataset.handle) drag = { kind: 'resize', before, start, id, handle: node.dataset.handle };
        else if (node && (Object.hasOwn(node.dataset, 'bend') || Object.hasOwn(node.dataset, 'segment'))) {
            const points = routePoints(source(), byId(id)), isBend = Object.hasOwn(node.dataset, 'bend'), index = Number(isBend ? node.dataset.bend : node.dataset.segment);
            let kind = 'segment'; if (isBend) kind = index === 0 || index === points.length - 1 ? 'endpoint' : 'bend';
            drag = { kind, before, start, id, points, index };
        } else if (id) {
            const ids = expandSelection(source(), new Set([id]));
            if (event.shiftKey) { const remove = selected.has(id); for (const member of ids) if (remove) selected.delete(member); else selected.add(member); }
            else if (!selected.has(id)) selected = ids;
            if (selected.has(id)) drag = { kind: 'move', before, start, selected: new Set(selected) };
        } else {
            if (!event.shiftKey) selected.clear();
            drag = { kind: 'marquee', before, start, selected: new Set(selected) };
        }
        if (drag) { drag.pointerId = event.pointerId; canvas.setPointerCapture(event.pointerId); }
        render();
    });
    function editRoute(event, point) {
        const item = draggedArrow(drag.before.source, drag.id, drag.kind, drag.index, snapped(point, event), connection(point, event));
        if (item.points.length > 256) { setHint('Route limit reached. Remove a bend before adding more.'); return; }
        Object.assign(byId(drag.id), item);
    }
    canvas.addEventListener('pointermove', event => {
        const point = world(event);
        if (!drag) { hover = tool === 'arrow' ? connection(point, event) : null; drawPreview(); return; }
        if (event.pointerId !== drag.pointerId) return;
        const dx = point.x - drag.start?.x, dy = point.y - drag.start?.y;
        if (drag.kind === 'pan') { const p = screen(event); camera.x = drag.camera.x - (p.x - drag.pixel.x) / camera.zoom; camera.y = drag.camera.y - (p.y - drag.pixel.y) / camera.zoom; }
        else if (drag.kind === 'move') {
            const offset = snapPoint({ x: dx, y: dy }, source().grid, event.altKey);
            const moved = moveObjects(drag.before.source, drag.selected, offset.x, offset.y);
            if (geometryWithinLimits(moved)) state.draft.source = moved;
        } else if (drag.kind === 'resize') {
            const old = getObject(drag.before.source, drag.id), next = byId(drag.id), p = snapped(point, event);
            let left = old.x, top = old.y, right = old.x + old.width, bottom = old.y + old.height;
            if (drag.handle.includes('w')) left = Math.min(right - 40, Math.max(right - 4000, p.x)); else right = Math.max(left + 40, Math.min(left + 4000, p.x));
            if (drag.handle.includes('n')) top = Math.min(bottom - 40, p.y); else bottom = Math.max(top + 40, p.y);
            Object.assign(next, { x: left, y: top, width: right - left, height: bottom - top }); growShape(next);
        } else if (drag.kind === 'draw') {
            const p = screen(event); if (Math.hypot(p.x - drag.pixel.x, p.y - drag.pixel.y) > 4) drag.moved = true;
            if (drag.moved) { const a = snapped(drag.start, event), b = snapped(point, event); Object.assign(byId(drag.id), { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: clamp(Math.abs(b.x - a.x), 40, 4000), height: clamp(Math.abs(b.y - a.y), 40, 4000) }); }
        } else if (['endpoint', 'bend', 'segment'].includes(drag.kind)) { editRoute(event, point); hover = drag.kind === 'endpoint' ? connection(point, event) : null; }
        else if (drag.kind === 'marquee') {
            const left = Math.min(drag.start.x, point.x), top = Math.min(drag.start.y, point.y), right = Math.max(drag.start.x, point.x), bottom = Math.max(drag.start.y, point.y);
            selected = new Set(drag.selected);
            for (const item of objects(source())) {
                const points = Object.hasOwn(item, 'width') ? [{ x: item.x, y: item.y }, { x: item.x + item.width, y: item.y + item.height }] : routePoints(source(), item);
                if (points.every(p => p.x >= left && p.x <= right && p.y >= top && p.y <= bottom)) selected.add(item.id);
            }
            selected = expandSelection(source(), selected); renderView();
            preview.append(svgNode('rect', { x: left, y: top, width: right - left, height: bottom - top, fill: '#6366f118', stroke: '#6366f1', 'stroke-width': 1 / camera.zoom })); return;
        }
        renderView();
    });
    function finishDrag(cancel) {
        if (!drag) return;
        const ended = drag; drag = null; hover = null;
        if (cancel) state.draft = ended.before; else history.commit(ended.before);
        if (canvas.hasPointerCapture(ended.pointerId)) canvas.releasePointerCapture(ended.pointerId);
        if (ended.kind === 'draw') tool = 'select'; render();
        if (!cancel && ended.kind === 'draw' && byId(ended.id).type === 'text') editText(ended.id);
    }
    canvas.addEventListener('pointerup', () => finishDrag(false));
    canvas.addEventListener('pointercancel', () => finishDrag(true));
    canvas.addEventListener('lostpointercapture', () => finishDrag(true));
    canvas.addEventListener('dblclick', event => {
        if (performance.now() - lastFinish < 400 || state.saving) return;
        const node = event.target.closest('[data-object]'); if (node && tool === 'select') editText(node.dataset.object);
    });
    canvas.addEventListener('contextmenu', event => {
        event.preventDefault(); event.stopPropagation(); if (state.saving || !finishText(true)) return;
        const node = event.target.closest('[data-object]');
        if (node && !selected.has(node.dataset.object)) selected = expandSelection(source(), new Set([node.dataset.object]));
        const p = snapped(world(event), event); contextPoint = { ...p, bend: node && Object.hasOwn(node.dataset, 'bend') ? Number(node.dataset.bend) : -1 };
        const item = selected.size === 1 ? byId([...selected][0]) : null;
        for (const button of menu.querySelectorAll('button')) {
            button.disabled = !selected.size;
            if (['add-bend', 'remove-bend', 'detach-start', 'detach-end'].includes(button.dataset.action)) button.hidden = !(item && Object.hasOwn(item, 'points'));
            if (button.dataset.action === 'remove-bend') {
                button.disabled = true;
                if (item && Object.hasOwn(item, 'points') && contextPoint.bend > 0) button.disabled = contextPoint.bend >= routePoints(source(), item).length - 1;
            }
        }
        render(); const pixel = screen(event); menu.hidden = false;
        menu.style.left = `${Math.max(0, Math.min(pixel.x, stage.clientWidth - menu.offsetWidth))}px`;
        menu.style.top = `${Math.max(0, Math.min(pixel.y, stage.clientHeight - menu.offsetHeight))}px`;
    });
    menu.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); });
    canvas.addEventListener('wheel', event => {
        event.preventDefault(); if (drag || !finishText(true)) return;
        menu.hidden = true;
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
        if (event.ctrlKey || event.metaKey) zoomAt(camera.zoom * Math.exp(-event.deltaY * unit * .005), screen(event));
        else { camera.x += event.deltaX * unit / camera.zoom; camera.y += event.deltaY * unit / camera.zoom; renderView(); }
    }, { passive: false });
    container.addEventListener('keydown', event => {
        if (state.saving || event.target.closest('input, select, [contenteditable="true"]')) return;
        const key = event.key.toLowerCase();
        let modifier = event.metaKey; if (event.ctrlKey) modifier = true;
        if (key === 'escape') {
            if (!menu.hidden) menu.hidden = true;
            else if (textSession) finishText(false);
            else if (drag) finishDrag(true);
            else if (pending || tool !== 'select') setTool('select');
            else return;
            event.preventDefault(); event.stopPropagation(); return;
        }
        if (pending && ['enter', 'backspace'].includes(key)) {
            event.preventDefault(); if (key === 'enter') { if (hover) pending.end = hover; finishArrow(); }
            else { pending.points.pop(); render(); } return;
        }
        if (modifier && ['z', 'y', 'd', 'a', 'g', 'c', 'v', 'x'].includes(key)) {
            event.preventDefault(); event.stopPropagation();
            if (key === 'a') { selected = new Set(source().order); render(); }
            else if (key === 'g') act(event.shiftKey ? 'ungroup' : 'group');
            else if (key === 'c') act('copy'); else if (key === 'v') act('paste');
            else if (key === 'x') { act('copy'); act('delete'); }
            else act(key === 'd' ? 'duplicate' : key === 'y' || event.shiftKey ? 'redo' : 'undo');
        } else if (!modifier && event.target === canvas) {
            if (key === ' ') { event.preventDefault(); space = true; render(); }
            else if (['delete', 'backspace'].includes(key)) { event.preventDefault(); act('delete'); }
            else if (key === 'enter' && selected.size === 1) { event.preventDefault(); editText([...selected][0]); }
            else if (key === 'f') { event.preventDefault(); fit(); }
            else if (key.startsWith('arrow') && !drag) {
                event.preventDefault(); const before = snapshot(), step = event.shiftKey ? source().grid.size : 1;
                let dx = 0, dy = 0; if (key === 'arrowleft') dx = -step; if (key === 'arrowright') dx = step; if (key === 'arrowup') dy = -step; if (key === 'arrowdown') dy = step;
                const moved = moveObjects(source(), selected, dx, dy);
                if (geometryWithinLimits(moved)) state.draft.source = moved;
                commit(before);
            } else { const match = TOOLS.find(([, , shortcut]) => shortcut.toLowerCase() === key); if (match) { event.preventDefault(); setTool(match[0]); } }
        }
    });
    // Keep system paste and note shortcuts out of the diagram canvas.
    container.addEventListener('paste', event => { if (event.target !== editor && !editor.contains(event.target)) event.preventDefault(); event.stopPropagation(); });
    container.addEventListener('keyup', event => { if (event.key === ' ') { space = false; render(); } });
    canvas.addEventListener('blur', () => { space = false; });
    const observer = new ResizeObserver(() => { if (!fitted) fit(); else renderView(); }); observer.observe(stage);
    render();
    return { focus: () => { fit(); focus(); }, flush: () => {
        if (!finishText(true)) return false;
        finishDrag(false); if (pending) finishArrow();
        return true;
    }, destroy: () => { disposed = true; observer.disconnect(); textControl.destroy(); } };
}
