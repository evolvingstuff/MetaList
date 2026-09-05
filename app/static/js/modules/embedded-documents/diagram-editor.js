const SVG_NS = 'http://www.w3.org/2000/svg';

export function emptyDiagram() {
    return { kind: 'diagram', version: 1, source: { rectangles: [] } };
}

export function clampPosition(x, y) {
    return { x: Math.max(0, Math.min(720, x)), y: Math.max(0, Math.min(440, y)) };
}

export function mountDiagramEditor(container, state) {
    container.innerHTML = `
        <div class="diagram-tools" role="toolbar" aria-label="Diagram tools">
            <button type="button" data-add>Add rectangle</button>
            <button type="button" data-delete disabled>Delete</button>
            <label>Label <input data-label maxlength="120" autocomplete="off" disabled></label>
            <button type="button" data-undo disabled>Undo</button>
            <button type="button" data-redo disabled>Redo</button>
        </div>
        <div class="diagram-canvas-wrap"><svg class="diagram-canvas" viewBox="0 0 900 540"
            role="img" aria-label="Diagram canvas"></svg></div>`;
    const canvas = container.querySelector('svg');
    const label = container.querySelector('[data-label]');
    state.selectedId = '';
    state.history = [];
    state.future = [];
    state.drag = null;
    const rectangles = () => state.draft.source.rectangles;
    const selected = () => rectangles().find(rect => rect.id === state.selectedId);
    const checkpoint = () => {
        state.history.push(structuredClone(state.draft));
        state.future = [];
    };
    const render = () => {
        canvas.replaceChildren();
        for (const rect of rectangles()) {
            const group = document.createElementNS(SVG_NS, 'g');
            group.dataset.rectangleId = rect.id;
            const shape = document.createElementNS(SVG_NS, 'rect');
            for (const [key, value] of Object.entries({ x: rect.x, y: rect.y, width: 160, height: 80, rx: 10,
                fill: '#dbeafe', stroke: rect.id === state.selectedId ? '#1e40af' : '#60a5fa',
                'stroke-width': rect.id === state.selectedId ? 4 : 2 })) shape.setAttribute(key, String(value));
            const text = document.createElementNS(SVG_NS, 'text');
            text.setAttribute('x', String(rect.x + 80));
            text.setAttribute('y', String(rect.y + 44));
            text.setAttribute('text-anchor', 'middle');
            text.textContent = rect.label;
            group.append(shape, text);
            canvas.append(group);
        }
        const current = selected();
        label.disabled = !current;
        label.value = current ? current.label : '';
        container.querySelector('[data-delete]').disabled = !current;
        container.querySelector('[data-add]').disabled = rectangles().length >= 200;
        container.querySelector('[data-undo]').disabled = state.history.length === 0;
        container.querySelector('[data-redo]').disabled = state.future.length === 0;
    };
    const undo = () => {
        if (state.history.length === 0) return;
        state.future.push(structuredClone(state.draft));
        state.draft = state.history.pop();
        render();
    };
    const redo = () => {
        if (state.future.length === 0) return;
        state.history.push(structuredClone(state.draft));
        state.draft = state.future.pop();
        render();
    };
    container.querySelector('[data-add]').addEventListener('click', () => {
        checkpoint();
        const offset = (rectangles().length % 8) * 35;
        const rect = { id: crypto.randomUUID(), x: 100 + offset, y: 80 + offset, label: '' };
        rectangles().push(rect);
        state.selectedId = rect.id;
        render();
    });
    container.querySelector('[data-delete]').addEventListener('click', () => {
        checkpoint();
        state.draft.source.rectangles = rectangles().filter(rect => rect.id !== state.selectedId);
        state.selectedId = '';
        render();
    });
    container.querySelector('[data-undo]').addEventListener('click', undo);
    container.querySelector('[data-redo]').addEventListener('click', redo);
    label.addEventListener('input', () => {
        checkpoint();
        selected().label = label.value;
        render();
    });
    const position = (event) => {
        const point = new DOMPoint(event.clientX, event.clientY);
        return point.matrixTransform(canvas.getScreenCTM().inverse());
    };
    canvas.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const group = event.target.closest('[data-rectangle-id]');
        state.selectedId = group ? group.dataset.rectangleId : '';
        const rect = selected();
        if (rect) {
            const point = position(event);
            state.drag = { dx: point.x - rect.x, dy: point.y - rect.y, checkpointed: false };
            canvas.setPointerCapture(event.pointerId);
        }
        event.preventDefault();
        render();
    });
    canvas.addEventListener('pointermove', (event) => {
        if (!state.drag) return;
        const point = position(event);
        const next = clampPosition(point.x - state.drag.dx, point.y - state.drag.dy);
        const rect = selected();
        if (next.x === rect.x && next.y === rect.y) return;
        if (!state.drag.checkpointed) {
            checkpoint();
            state.drag.checkpointed = true;
        }
        Object.assign(rect, next);
        render();
    });
    const endDrag = () => { state.drag = null; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('lostpointercapture', endDrag);
    container.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
            event.preventDefault();
            if (event.shiftKey || event.key.toLowerCase() === 'y') redo();
            else undo();
        }
    });
    render();
}
