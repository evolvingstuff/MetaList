export function createFloatingNoteElements(id) {
    const element = document.createElement('section');
    element.className = 'floating-note-window';
    element.dataset.floatingNoteId = id;
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-label', 'Floating note');
    element.tabIndex = -1;

    const shadow = element.attachShadow({mode: 'open'});
    const sharedStyles = document.createElement('link');
    sharedStyles.rel = 'stylesheet';
    sharedStyles.href = '/static/css/main.css';
    const windowStyles = document.createElement('link');
    windowStyles.rel = 'stylesheet';
    windowStyles.href = '/static/css/floating-notes.css';
    shadow.append(sharedStyles, windowStyles);

    const header = document.createElement('header');
    header.className = 'floating-note-header';
    const title = document.createElement('a');
    title.className = 'floating-note-title';
    title.href = '#';
    title.textContent = '↗ Loading…';
    title.setAttribute('aria-disabled', 'true');
    const dragHandle = document.createElement('span');
    dragHandle.className = 'floating-note-drag-handle';
    dragHandle.textContent = '⠿';
    dragHandle.title = 'Drag window';
    dragHandle.setAttribute('aria-hidden', 'true');
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'floating-note-close';
    closeButton.textContent = '×';
    closeButton.setAttribute('aria-label', 'Close floating note');
    header.append(title, dragHandle, closeButton);

    const scroll = document.createElement('div');
    scroll.className = 'floating-note-scroll';
    scroll.tabIndex = 0;
    scroll.setAttribute('aria-label', 'Read-only note and children');
    const status = document.createElement('div');
    status.className = 'floating-note-status';
    status.setAttribute('role', 'status');
    status.textContent = 'Loading…';
    const tree = document.createElement('div');
    tree.className = 'floating-note-tree';
    scroll.append(status, tree);
    const resize = document.createElement('button');
    resize.type = 'button';
    resize.className = 'floating-note-resize';
    resize.setAttribute('aria-label', 'Resize floating note');
    resize.title = 'Drag to resize; arrow keys also resize';
    shadow.append(header, scroll, resize);
    return {element, tree, title, status, scroll};
}

export function getFloatingNoteTitle(tree) {
    const content = tree.querySelector(':scope > .note > .note-content');
    if (!content) throw new Error('Floating note is missing root content');
    const preview = content.cloneNode(true);
    // Passwords are only visually masked in the note; never expose their text
    // in the window chrome or its accessible label.
    for (const password of preview.querySelectorAll('.meta-credential-password')) password.textContent = '••••';
    const text = preview.textContent.replace(/\s+/g, ' ').trim();
    if (text.length === 0) return 'Untitled note';
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

export function applyFloatingNoteRect(element, rect) {
    element.style.left = `${rect.x}px`;
    element.style.top = `${rect.y}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
}
