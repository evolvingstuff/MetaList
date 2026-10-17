// A floating note is at least this size, unless the viewport is smaller.
const MIN_FLOATING_NOTE_WIDTH_PX = 260;
const MIN_FLOATING_NOTE_HEIGHT_PX = 160;

export function constrainFloatingNoteRect(rect, viewport) {
    for (const value of [rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height]) {
        if (!Number.isFinite(value)) throw new Error('Floating note geometry must be finite');
    }
    if (viewport.width <= 0 || viewport.height <= 0) throw new Error('Viewport must have positive dimensions');
    const width = Math.min(viewport.width, Math.max(MIN_FLOATING_NOTE_WIDTH_PX, rect.width));
    const height = Math.min(viewport.height, Math.max(MIN_FLOATING_NOTE_HEIGHT_PX, rect.height));
    return {
        x: Math.max(0, Math.min(rect.x, viewport.width - width)),
        y: Math.max(0, Math.min(rect.y, viewport.height - height)),
        width,
        height,
    };
}

export function moveFloatingNoteRect(gesture, x, y, viewport) {
    const rect = {...gesture.rect};
    if (gesture.kind === 'move') {
        rect.x += x - gesture.x;
        rect.y += y - gesture.y;
    } else if (gesture.kind === 'resize') {
        rect.width += x - gesture.x;
        rect.height += y - gesture.y;
    } else {
        throw new Error('Unknown floating note gesture');
    }
    return constrainFloatingNoteRect(rect, viewport);
}
