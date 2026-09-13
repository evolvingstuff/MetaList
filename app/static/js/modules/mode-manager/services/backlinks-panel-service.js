import { ApplicationState } from '../../application-state.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { NotesAPI } from '../../api-client.js';
import { isSearchContextsOverlayBottomLeft } from './search-contexts-overlay-service.js';

const moduleState = ApplicationState.createFields('backlinks-panel-service', {
    backlinksRequestSerial: 0,
    lastRenderedKey: null,
});


function getBacklinksPanelElement() {
    const panel = document.getElementById('backlinks-panel');
    if (!panel) {
        throw new Error('backlinks-panel element missing from DOM');
    }
    if (!(panel instanceof HTMLElement)) {
        throw new Error('backlinks-panel must be an HTMLElement');
    }
    return panel;
}

function isBacklinksPreferenceEnabled() {
    return document.body.classList.contains('pref-show-backlinks');
}

function isTabUiVisible() {
    return document.body.classList.contains('pref-show-tab-ui');
}

function updateBacklinksPanelTop(panel) {
    if (!(panel instanceof HTMLElement)) {
        throw new Error('updateBacklinksPanelTop requires panel element');
    }

    const fallbackTop = 'calc(1.5rem - 6px)';
    panel.style.bottom = 'auto';
    panel.style.left = '10px';
    panel.style.right = 'auto';
    if (!isTabUiVisible()) {
        panel.style.top = fallbackTop;
        return;
    }

    const tabList = document.getElementById('search-contexts-list');
    if (!(tabList instanceof HTMLElement)) {
        panel.style.top = fallbackTop;
        return;
    }

    const tabListVisible = window.getComputedStyle(tabList).display !== 'none';
    if (!tabListVisible) {
        panel.style.top = fallbackTop;
        return;
    }

    const rect = tabList.getBoundingClientRect();
    if (isSearchContextsOverlayBottomLeft()) {
        const viewportHeight = window.innerHeight;
        if (typeof viewportHeight !== 'number' || Number.isNaN(viewportHeight) || viewportHeight <= 0) {
            throw new Error('window.innerHeight must be a positive number');
        }
        const aboveTabListBottom = Math.max(8, Math.round(viewportHeight - rect.top + 8));
        const alignedLeft = Math.max(8, Math.round(rect.left));

        panel.style.top = 'auto';
        panel.style.left = `${alignedLeft}px`;
        panel.style.right = 'auto';
        panel.style.bottom = `${aboveTabListBottom}px`;
        return;
    }

    panel.style.top = `${Math.round(rect.bottom + 8)}px`;
}

export function syncBacklinksPanelPlacement() {
    const panel = document.getElementById('backlinks-panel');
    if (!(panel instanceof HTMLElement)) {
        return;
    }
    updateBacklinksPanelTop(panel);
}

function clearPanel(panel) {
    panel.innerHTML = '';
}

function showPanel(panel) {
    panel.style.display = 'block';
}

function hidePanel(panel) {
    panel.style.display = 'none';
}

function createTitleElement(targetNoteId, backlinkCount) {
    const title = document.createElement('div');
    title.className = 'backlinks-title';
    title.textContent = `Backlinks (${backlinkCount})`;
    title.title = targetNoteId;
    return title;
}

function createBacklinkItemElement(entry) {
    if (!entry || typeof entry !== 'object') {
        throw new Error('Backlink entry must be an object');
    }
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
        throw new Error('Backlink entry id must be a non-empty string');
    }
    if (typeof entry.preview !== 'string') {
        throw new Error('Backlink entry preview must be a string');
    }

    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'backlink-item interactive';
    item.dataset.backlinkNoteId = entry.id;
    item.title = entry.id;

    const preview = document.createElement('span');
    preview.className = 'backlink-item-preview';
    preview.textContent = entry.preview.length > 0 ? entry.preview : '(empty note)';
    item.appendChild(preview);

    return item;
}

function renderPanelWithEntries(panel, targetNoteId, entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error('renderPanelWithEntries requires non-empty entries');
    }

    clearPanel(panel);
    panel.appendChild(createTitleElement(targetNoteId, entries.length));

    const list = document.createElement('div');
    list.className = 'backlinks-list';
    for (const entry of entries) {
        list.appendChild(createBacklinkItemElement(entry));
    }
    panel.appendChild(list);
}

function validateBacklinksResponse(payload, targetNoteId) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Backlinks response must be an object');
    }
    if (payload.targetNoteId !== targetNoteId) {
        throw new Error('Backlinks response targetNoteId mismatch');
    }
    if (!Array.isArray(payload.backlinks)) {
        throw new Error('Backlinks response must include backlinks array');
    }
    return payload.backlinks;
}

function buildRenderKey(targetNoteId) {
    const updateUuid = ModeContext.lastUpdateUUID;
    const stableUpdateUuid = typeof updateUuid === 'string' ? updateUuid : '';
    const searchQuery = typeof ModeContext.searchQuery === 'string' ? ModeContext.searchQuery : '';
    return `${targetNoteId}|${searchQuery}|${stableUpdateUuid}|${isBacklinksPreferenceEnabled() ? 'on' : 'off'}|${isTabUiVisible() ? 'tabs' : 'notabs'}`;
}

export function invalidateBacklinksPanelCache() {
    if (moduleState.lastRenderedKey !== null) moduleState.lastRenderedKey = null;
}

export async function refreshBacklinksPanel(...args) {
    let options = {};
    if (args.length > 0) {
        options = args[0];
    }
    if (options === null || typeof options !== 'object') {
        throw new Error('refreshBacklinksPanel requires options object');
    }
    const force = options.force === true;

    const panel = getBacklinksPanelElement();
    updateBacklinksPanelTop(panel);

    if (!isBacklinksPreferenceEnabled()) {
        hidePanel(panel);
        clearPanel(panel);
        if (moduleState.lastRenderedKey !== null) moduleState.lastRenderedKey = null;
        return;
    }

    if (!ModeContext.isEditing || typeof ModeContext.currentNoteId !== 'string' || ModeContext.currentNoteId.length === 0) {
        hidePanel(panel);
        clearPanel(panel);
        const emptyKey = buildRenderKey('none');
        if (moduleState.lastRenderedKey !== emptyKey) moduleState.lastRenderedKey = emptyKey;
        return;
    }

    const targetNoteId = ModeContext.currentNoteId;
    const renderKey = buildRenderKey(targetNoteId);
    if (!force && renderKey === moduleState.lastRenderedKey) {
        return;
    }

    const requestId = ++moduleState.backlinksRequestSerial;
    const searchQuery = typeof ModeContext.searchQuery === 'string' ? ModeContext.searchQuery : '';
    const payload = await NotesAPI.fetchBacklinks(targetNoteId, searchQuery);
    if (requestId !== moduleState.backlinksRequestSerial) {
        return;
    }

    const entries = validateBacklinksResponse(payload, targetNoteId);
    if (entries.length === 0) {
        hidePanel(panel);
        clearPanel(panel);
        if (moduleState.lastRenderedKey !== renderKey) moduleState.lastRenderedKey = renderKey;
        return;
    }

    showPanel(panel);
    renderPanelWithEntries(panel, targetNoteId, entries);
    if (moduleState.lastRenderedKey !== renderKey) moduleState.lastRenderedKey = renderKey;
}
