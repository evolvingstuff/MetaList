import { ApplicationState } from '../application-state.js';
const MENU_PADDING_PX = 8;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const CONTEXT_MENU_ICONS = {
    add_top: [
        'M5 4h14',
        'M12 8v12',
        'M6 14h12',
    ],
    floating_window: [
        'M4 4h12v4',
        'M4 4v12h4',
        'M9 9h11v11H9z',
        'M9 12h11',
    ],
    fullscreen: [
        'M9 4H4v5',
        'M15 4h5v5',
        'M4 15v5h5',
        'M20 15v5h-5',
    ],
    expand_all: [
        'M7 8l5-5 5 5',
        'M7 16l5 5 5-5',
        'M4 12h16',
    ],
    collapse_all: [
        'M7 3l5 5 5-5',
        'M7 21l5-5 5 5',
        'M4 12h16',
    ],
    tabs: [
        // Same stacked folders as the top bar, with the hidden back outline
        // omitted so the icon works on both normal and hovered menu surfaces.
        'M9.5 9.5V6h8l3-3H32a2.5 2.5 0 0 1 2.5 2.5V20a2.5 2.5 0 0 1-2.5 2.5H30',
        'M4 9.5h9l3-3h11.5a2.5 2.5 0 0 1 2.5 2.5v14.5a2.5 2.5 0 0 1-2.5 2.5h-21A2.5 2.5 0 0 1 4 23.5z',
    ],
    sort: [
        'M4 6h16',
        'M4 12h11',
        'M4 18h6',
    ],
    manual_order: [
        'M9 5h11',
        'M9 12h11',
        'M9 19h11',
        'M4 4v16',
        'M2 6l2-2 2 2',
        'M2 18l2 2 2-2',
    ],
    calendar: [
        'M4 5h16v15H4z',
        'M8 3v4',
        'M16 3v4',
        'M4 10h16',
        'M8 14h2',
        'M14 14h2',
    ],
    clock: [
        'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18',
        'M12 7v5l3 2',
    ],
    alphabetical: [
        'M3 11l3-8 3 8',
        'M4 8h4',
        'M3 15h6l-6 6h6',
        'M17 4v16',
        'M14 17l3 3 3-3',
    ],
    volume: [
        'M4 5h16v3H4z',
        'M4 11h12v3H4z',
        'M4 17h8v3H4z',
    ],
    add_child: [
        'M6 4h8',
        'M10 8V2',
        'M6 18h12',
        'M12 14v8',
        'M4 10v4c0 2.2 1.8 4 4 4h4',
    ],
    add_sibling: [
        'M12 4v8',
        'M8 8h8',
        'M5 18h14',
    ],
    arrow_top: [
        'M12 20V5',
        'M6 11l6-6 6 6',
        'M5 4h14',
    ],
    copy: [
        'M8 8h10v12H8z',
        'M6 16H4V4h10v2',
    ],
    chat: [
        'M4 5h16v11H9l-5 4z',
    ],
    clear_formatting: [
        'M5 15 14 6l5 5-9 9H5z',
        'M12 18h8',
    ],
    download: [
        'M12 4v10',
        'M7 10l5 5 5-5',
        'M5 20h14',
    ],
    external: [
        'M14 4h6v6',
        'M10 14 20 4',
        'M18 13v7H4V6h7',
    ],
    image: [
        'M4 6h16v12H4z',
        'M8 10h.01',
        'M4 16l4-4 3 3 3-4 6 5',
    ],
    style: [
        'M4 17.5V20h2.5L18 8.5 15.5 6z',
        'M14 4l2-2 6 6-2 2',
        'M3 3l3 3',
    ],
    link: [
        'M9 12a3 3 0 0 1 3-3h3',
        'M15 12a3 3 0 0 1-3 3H9',
        'M8 8H7a4 4 0 0 0 0 8h1',
        'M16 8h1a4 4 0 0 1 0 8h-1',
    ],
    link_child: [
        'M9 8h4a3 3 0 0 1 0 6H9',
        'M8 11h6',
        'M6 4v10c0 2.2 1.8 4 4 4h4',
        'M14 16l2 2-2 2',
    ],
    paste: [
        'M8 5h8',
        'M9 3h6v4H9z',
        'M6 6h12v14H6z',
    ],
    paste_child: [
        'M8 5h8',
        'M9 3h6v4H9z',
        'M6 6h12v9H6z',
        'M10 19h8',
        'M14 15v8',
    ],
    tag: [
        'M4 4h7l9 9-7 7-9-9z',
        'M8 8h.01',
    ],
    trash: [
        'M5 7h14',
        'M9 7V4h6v3',
        'M8 10v9',
        'M12 10v9',
        'M16 10v9',
    ],
    zoom: [
        'M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14z',
        'M15 15l5 5',
        'M10 7v6',
        'M7 10h6',
    ],
    zoom_in: [
        'M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14z',
        'M15 15l5 5',
        'M10 7v6',
        'M7 10h6',
    ],
    zoom_out: [
        'M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14z',
        'M15 15l5 5',
        'M7 10h6',
    ],
    restart_alt: [
        'M5 9V4h5',
        'M5.8 8.7A7 7 0 1 1 5 15',
    ],
};

export function isContextMenuIconSupported(iconName) {
    if (typeof iconName !== 'string' || iconName.length === 0) {
        return false;
    }
    return Object.prototype.hasOwnProperty.call(CONTEXT_MENU_ICONS, iconName);
}

const moduleState = ApplicationState.createFields('context-menu-service', {
    menuElement: null,
    submenuElement: null,
    activeMenu: null,
    activeSubmenuItems: [],
    activeSubmenuParent: null,
    initialized: false,
});


function ensureMenuElement() {
    if (moduleState.menuElement) {
        return moduleState.menuElement;
    }

    const element = document.createElement('div');
    element.id = 'context-menu';
    element.className = 'context-menu';
    element.setAttribute('role', 'menu');
    element.style.display = 'none';
    document.body.appendChild(element);

    element.addEventListener('click', handleMenuClick);
    moduleState.menuElement = element;
    return element;
}

function ensureSubmenuElement() {
    if (moduleState.submenuElement) {
        return moduleState.submenuElement;
    }

    const element = document.createElement('div');
    element.id = 'context-submenu';
    element.className = 'context-menu context-menu-submenu';
    element.setAttribute('role', 'menu');
    element.style.display = 'none';
    document.body.appendChild(element);

    element.addEventListener('click', handleMenuClick);
    moduleState.submenuElement = element;
    return element;
}

function handleMenuClick(event) {
    if (!event) {
        throw new Error('handleMenuClick called without event');
    }
    const target = event.target;
    if (!(target instanceof Element)) {
        return;
    }

    const button = target.closest('.context-menu-item');
    if (!button) {
        return;
    }

    const menuLevel = button.dataset.menuLevel;
    if (menuLevel !== 'root' && menuLevel !== 'submenu') {
        throw new Error('Context menu item missing menu level');
    }
    const items = menuLevel === 'submenu' ? moduleState.activeSubmenuItems : moduleState.activeMenu.items;
    const indexAttr = button.dataset.index;
    if (typeof indexAttr !== 'string' || indexAttr.trim() === '') {
        throw new Error('Context menu item missing index');
    }
    const index = Number.parseInt(indexAttr, 10);
    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
        throw new Error(`Context menu item index invalid: ${indexAttr}`);
    }

    const item = items[index];
    if (!item) {
        throw new Error('Context menu item missing in active items');
    }
    if (!item.enabled) {
        return;
    }
    if (Array.isArray(item.submenu)) {
        if (menuLevel !== 'root') {
            throw new Error('Nested context submenus are not supported');
        }
        event.preventDefault();
        event.stopPropagation();
        showSubmenuForButton(button, item.submenu, true);
        return;
    }
    if (typeof item.onSelect !== 'function') {
        throw new Error('Context menu leaf item missing onSelect handler');
    }

    event.preventDefault();
    event.stopPropagation();
    hideContextMenu();
    item.onSelect();
}

function validateMenuItems(items, depth) {
    if (!Number.isInteger(depth) || depth < 0) {
        throw new Error('validateMenuItems requires non-negative depth');
    }
    if (!Array.isArray(items) || items.length === 0) {
        throw new Error('Context menu requires non-empty items array');
    }

    items.forEach((item, index) => {
        if (!item || typeof item !== 'object') {
            throw new Error(`Context menu item ${index} must be an object`);
        }
        if (typeof item.id !== 'string' || item.id.trim() === '') {
            throw new Error(`Context menu item ${index} missing id`);
        }
        if (typeof item.label !== 'string' || item.label.trim() === '') {
            throw new Error(`Context menu item ${index} missing label`);
        }
        if (item.kind === 'info') {
            if (!Array.isArray(item.rows) || item.rows.length === 0) {
                throw new Error(`Context menu info item ${index} missing rows`);
            }
            item.rows.forEach((row, rowIndex) => {
                if (!row || typeof row !== 'object') {
                    throw new Error(`Context menu info item ${index} row ${rowIndex} must be an object`);
                }
                if (typeof row.label !== 'string' || row.label.trim() === '') {
                    throw new Error(`Context menu info item ${index} row ${rowIndex} missing label`);
                }
                if (typeof row.value !== 'string' || row.value.trim() === '') {
                    throw new Error(`Context menu info item ${index} row ${rowIndex} missing value`);
                }
            });
            if (item.enabled !== undefined || item.onSelect !== undefined || item.submenu !== undefined) {
                throw new Error(`Context menu info item ${index} cannot be interactive`);
            }
            return;
        }
        if (item.kind !== undefined) {
            throw new Error(`Context menu item ${index} has unknown kind: ${item.kind}`);
        }
        if (typeof item.enabled !== 'boolean') {
            throw new Error(`Context menu item ${index} missing enabled boolean`);
        }
        const hasSubmenu = item.submenu !== undefined;
        if (hasSubmenu) {
            if (depth > 0) {
                throw new Error('Nested context submenus are not supported');
            }
            if (item.onSelect !== undefined) {
                throw new Error(`Context menu submenu item ${index} cannot have onSelect`);
            }
            validateMenuItems(item.submenu, depth + 1);
        } else if (typeof item.onSelect !== 'function') {
            throw new Error(`Context menu item ${index} missing onSelect handler`);
        }
        if (item.separated !== undefined && typeof item.separated !== 'boolean') {
            throw new Error(`Context menu item ${index} separated must be boolean when provided`);
        }
        if (item.icon !== undefined && typeof item.icon !== 'string') {
            throw new Error(`Context menu item ${index} icon must be string when provided`);
        }
    });
}

function resolvePosition(position, menuRect) {
    if (!position || typeof position !== 'object') {
        throw new Error('resolvePosition requires position object');
    }
    if (!menuRect) {
        throw new Error('resolvePosition requires menuRect');
    }

    const x = position.x;
    const y = position.y;
    if (typeof x !== 'number' || typeof y !== 'number') {
        throw new Error('Context menu position requires numeric x/y');
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    if (typeof viewportWidth !== 'number' || typeof viewportHeight !== 'number') {
        throw new Error('Viewport dimensions missing');
    }

    let left = x;
    let top = y;

    if (left + menuRect.width + MENU_PADDING_PX > viewportWidth) {
        left = viewportWidth - menuRect.width - MENU_PADDING_PX;
    }
    if (top + menuRect.height + MENU_PADDING_PX > viewportHeight) {
        top = viewportHeight - menuRect.height - MENU_PADDING_PX;
    }

    if (left < MENU_PADDING_PX) {
        left = MENU_PADDING_PX;
    }
    if (top < MENU_PADDING_PX) {
        top = MENU_PADDING_PX;
    }

    return { left, top };
}

function resolveSubmenuPosition(parentRect, submenuRect) {
    if (!parentRect || !submenuRect) {
        throw new Error('resolveSubmenuPosition requires menu rectangles');
    }
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    if (typeof viewportWidth !== 'number' || typeof viewportHeight !== 'number') {
        throw new Error('Viewport dimensions missing');
    }

    let left = parentRect.right - 1;
    if (left + submenuRect.width + MENU_PADDING_PX > viewportWidth) {
        left = parentRect.left - submenuRect.width + 1;
    }
    let top = parentRect.top - 6;
    if (top + submenuRect.height + MENU_PADDING_PX > viewportHeight) {
        top = viewportHeight - submenuRect.height - MENU_PADDING_PX;
    }
    if (left < MENU_PADDING_PX) {
        left = MENU_PADDING_PX;
    }
    if (top < MENU_PADDING_PX) {
        top = MENU_PADDING_PX;
    }
    return { left, top };
}

function renderMenuItems(menu, items, menuLevel) {
    if (menuLevel !== 'root' && menuLevel !== 'submenu') {
        throw new Error('renderMenuItems requires a valid menu level');
    }
    menu.innerHTML = '';
    items.forEach((item, index) => {
        if (item.kind === 'info') {
            const info = document.createElement('div');
            info.className = 'context-menu-info';
            info.setAttribute('role', 'group');
            info.setAttribute('aria-label', item.label);
            item.rows.forEach((rowData) => {
                const row = document.createElement('div');
                row.className = 'context-menu-info-row';
                const label = document.createElement('span');
                label.className = 'context-menu-info-label';
                label.textContent = rowData.label;
                const value = document.createElement('span');
                value.className = 'context-menu-info-value';
                value.textContent = rowData.value;
                row.appendChild(label);
                row.appendChild(value);
                info.appendChild(row);
            });
            menu.appendChild(info);
            return;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'context-menu-item';
        button.dataset.index = String(index);
        button.dataset.menuLevel = menuLevel;
        button.setAttribute('role', 'menuitem');

        const icon = createMenuIcon(item.icon);
        if (icon) {
            button.appendChild(icon);
        }

        const label = document.createElement('span');
        label.className = 'context-menu-item-label';
        label.textContent = item.label;
        button.appendChild(label);

        if (Array.isArray(item.submenu)) {
            button.classList.add('has-submenu');
            button.setAttribute('aria-haspopup', 'menu');
            button.setAttribute('aria-expanded', 'false');
            const arrow = document.createElement('span');
            arrow.className = 'context-menu-submenu-arrow';
            arrow.textContent = '›';
            arrow.setAttribute('aria-hidden', 'true');
            button.appendChild(arrow);
        }

        if (item.separated === true) {
            button.classList.add('is-separated');
        }
        if (!item.enabled) {
            button.disabled = true;
            button.classList.add('is-disabled');
        }
        if (menuLevel === 'root') {
            button.addEventListener('mouseenter', () => {
                if (Array.isArray(item.submenu) && item.enabled) {
                    showSubmenuForButton(button, item.submenu, false);
                    return;
                }
                hideSubmenu();
            });
            button.addEventListener('focus', () => {
                if (Array.isArray(item.submenu) && item.enabled) {
                    showSubmenuForButton(button, item.submenu, true);
                    return;
                }
                hideSubmenu();
            });
        }
        menu.appendChild(button);
    });
}

function showSubmenuForButton(parentButton, submenuItems, focusFirstItem) {
    if (!(parentButton instanceof HTMLButtonElement)) {
        throw new Error('showSubmenuForButton requires parent button');
    }
    if (typeof focusFirstItem !== 'boolean') {
        throw new Error('showSubmenuForButton requires focusFirstItem boolean');
    }
    validateMenuItems(submenuItems, 1);

    hideSubmenu();
    const submenu = ensureSubmenuElement();
    moduleState.activeSubmenuItems = submenuItems;
    moduleState.activeSubmenuParent = parentButton;
    parentButton.classList.add('is-submenu-open');
    parentButton.setAttribute('aria-expanded', 'true');

    renderMenuItems(submenu, submenuItems, 'submenu');
    submenu.style.display = 'block';
    submenu.style.visibility = 'hidden';
    submenu.style.left = '0px';
    submenu.style.top = '0px';

    const parentRect = parentButton.getBoundingClientRect();
    const submenuRect = submenu.getBoundingClientRect();
    const resolved = resolveSubmenuPosition(parentRect, submenuRect);
    submenu.style.left = `${resolved.left}px`;
    submenu.style.top = `${resolved.top}px`;
    submenu.style.visibility = 'visible';
    submenu.classList.add('is-visible');
    if (focusFirstItem) {
        const firstEnabledItem = submenu.querySelector('.context-menu-item:not(:disabled)');
        if (firstEnabledItem instanceof HTMLButtonElement) {
            firstEnabledItem.focus();
        }
    }
}

function hideSubmenu() {
    // Pointer movement repeatedly asks to dismiss a submenu that may never have opened.
    if (moduleState.activeSubmenuParent === null) return;
    if (moduleState.activeSubmenuParent) {
        moduleState.activeSubmenuParent.classList.remove('is-submenu-open');
        moduleState.activeSubmenuParent.setAttribute('aria-expanded', 'false');
    }
    moduleState.activeSubmenuParent = null;
    moduleState.activeSubmenuItems = [];
    if (!moduleState.submenuElement) {
        return;
    }
    moduleState.submenuElement.classList.remove('is-visible');
    moduleState.submenuElement.style.display = 'none';
    moduleState.submenuElement.style.visibility = 'hidden';
    moduleState.submenuElement.innerHTML = '';
}

function createMenuIcon(iconName) {
    if (typeof iconName !== 'string' || iconName.length === 0) {
        return null;
    }
    if (!isContextMenuIconSupported(iconName)) {
        throw new Error(`Unknown context menu icon: ${iconName}`);
    }
    const paths = CONTEXT_MENU_ICONS[iconName];
    assertMenuIconPaths(paths, iconName);

    const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
    svg.classList.add('context-menu-item-icon');
    svg.setAttribute('viewBox', iconName === 'tabs' ? '0 0 40 30' : '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    paths.forEach((pathData) => {
        const path = document.createElementNS(SVG_NAMESPACE, 'path');
        path.setAttribute('d', pathData);
        svg.appendChild(path);
    });
    return svg;
}

function assertMenuIconPaths(paths, iconName) {
    if (!Array.isArray(paths) || paths.length === 0) {
        throw new Error(`Context menu icon has no paths: ${iconName}`);
    }
    for (const pathData of paths) {
        if (typeof pathData !== 'string' || pathData.length === 0) {
            throw new Error(`Context menu icon has an invalid path: ${iconName}`);
        }
    }
}

function isContextMenuOpen() {
    return Boolean(moduleState.menuElement && moduleState.menuElement.classList.contains('is-visible'));
}

function handleGlobalMouseDown(event) {
    if (!isContextMenuOpen()) {
        return;
    }
    if (!event) {
        throw new Error('handleGlobalMouseDown called without event');
    }
    const target = event.target;
    if (!(target instanceof Element)) {
        hideContextMenu();
        return;
    }
    const menu = moduleState.menuElement;
    if (!menu) {
        hideContextMenu();
        return;
    }
    if (menu.contains(target) || (moduleState.submenuElement && moduleState.submenuElement.contains(target))) {
        return;
    }
    hideContextMenu();
}

function handleGlobalContextMenu(event) {
    if (!isContextMenuOpen()) {
        return;
    }
    if (!event) {
        throw new Error('handleGlobalContextMenu called without event');
    }
    const target = event.target;
    if (!(target instanceof Element)) {
        hideContextMenu();
        return;
    }
    const menu = moduleState.menuElement;
    if (!menu) {
        hideContextMenu();
        return;
    }
    if (menu.contains(target) || (moduleState.submenuElement && moduleState.submenuElement.contains(target))) {
        return;
    }
    hideContextMenu();
}

function handleGlobalKeyDown(event) {
    if (!isContextMenuOpen()) {
        return;
    }
    if (!event) {
        throw new Error('handleGlobalKeyDown called without event');
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        hideContextMenu();
        return;
    }
    if (event.key !== 'Enter') {
        return;
    }
    let actionButton = document.activeElement;
    const isFocusedMenuButton = actionButton instanceof HTMLButtonElement
        && ((moduleState.menuElement && moduleState.menuElement.contains(actionButton))
            || (moduleState.submenuElement && moduleState.submenuElement.contains(actionButton)));
    if (!isFocusedMenuButton) {
        actionButton = moduleState.menuElement.querySelector('.context-menu-item:not(:disabled)');
    }
    if (!(actionButton instanceof HTMLButtonElement)) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    actionButton.click();
}

function handleGlobalScroll() {
    if (isContextMenuOpen()) {
        hideContextMenu();
    }
}

function handleGlobalResize() {
    if (isContextMenuOpen()) {
        hideContextMenu();
    }
}

export function initContextMenuService() {
    if (moduleState.initialized) {
        return;
    }

    document.addEventListener('mousedown', handleGlobalMouseDown, { capture: true });
    document.addEventListener('contextmenu', handleGlobalContextMenu, { capture: true });
    document.addEventListener('keydown', handleGlobalKeyDown, { capture: true });
    document.addEventListener('scroll', handleGlobalScroll, { capture: true });
    window.addEventListener('resize', handleGlobalResize);
    moduleState.initialized = true;
}

export function showContextMenu(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('showContextMenu requires payload object');
    }

    const items = payload.items;
    const position = payload.position;
    validateMenuItems(items, 0);

    const menu = ensureMenuElement();
    moduleState.activeMenu = { items, onClose: payload.onClose };

    hideSubmenu();
    renderMenuItems(menu, items, 'root');
    menu.style.display = 'block';
    menu.style.visibility = 'hidden';
    menu.style.left = '0px';
    menu.style.top = '0px';

    const rect = menu.getBoundingClientRect();
    const resolved = resolvePosition(position, rect);

    menu.style.left = `${resolved.left}px`;
    menu.style.top = `${resolved.top}px`;
    menu.style.visibility = 'visible';
    menu.classList.add('is-visible');
}

export function hideContextMenu() {
    if (moduleState.activeMenu === null) return;
    hideSubmenu();
    if (!moduleState.menuElement) {
        return;
    }
    if (moduleState.menuElement.classList.contains('is-visible')) {
        moduleState.menuElement.classList.remove('is-visible');
    }
    moduleState.menuElement.style.display = 'none';
    moduleState.menuElement.style.visibility = 'hidden';
    moduleState.menuElement.innerHTML = '';
    const onClose = moduleState.activeMenu.onClose;
    moduleState.activeMenu = null;
    if (typeof onClose === 'function') {
        onClose();
    }
}
