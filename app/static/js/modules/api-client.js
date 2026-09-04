import { CONFIG } from './config.js';
import { DOMUtils } from './dom-utils.js';
import { ModeContextInstance as ModeContext } from './mode-manager/mode-context.js';
import { ErrorHandler } from './error-handler.js';
import { computeScrollAnchor } from './mode-manager/services/scroll-anchor-service.js';
import { CommandGate } from './mode-manager/services/command-gate-service.js';
import { buildSessionHeaders } from './session-auth.js';
import { sanitizeNoteHtmlForStorage } from './note-html-sanitizer.js';

function buildAuthHeaders(includeContentType) {
    return buildSessionHeaders(includeContentType);
}

function extractFilenameFromContentDisposition(disposition) {
    if (typeof disposition !== 'string' || disposition.length === 0) {
        return null;
    }

    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match) {
        return decodeURIComponent(utf8Match[1]);
    }

    const quotedMatch = disposition.match(/filename="([^"]+)"/i);
    if (quotedMatch) {
        return quotedMatch[1];
    }

    return null;
}

function captureViewportSnapshot() {
    return {
        scrollY: Math.max(0, Math.round(window.scrollY)),
        scrollAnchor: computeScrollAnchor({ anchorBias: 'auto' }),
    };
}

function captureUndoContext() {
    const tabId = ModeContext.activeTabId;
    if (typeof tabId !== 'string' || tabId.length === 0) {
        throw new Error('ModeContext.activeTabId must be a non-empty string');
    }

    const epoch = ModeContext.undoContextEpoch;
    if (!Number.isInteger(epoch) || epoch < 0) {
        throw new Error('ModeContext.undoContextEpoch must be a non-negative integer');
    }

    const searchQuery = ModeContext.getExecutedSearchQuery(tabId);
    if (typeof searchQuery !== 'string') {
        throw new Error('ModeContext.getExecutedSearchQuery() must return a string');
    }

    return `tab:${tabId}|search:${searchQuery}|epoch:${epoch}`;
}

export const NotesAPI = {
                
    async _apiCall(url, options) {
        if (typeof url !== 'string') {
            throw new Error('NotesAPI._apiCall requires url string');
        }
        if (options === null || typeof options !== 'object') {
            throw new Error('NotesAPI._apiCall requires options object');
        }
        try {
            const claimSession = Boolean(options.claimSession);
            const fetchOptions = { ...options };
            delete fetchOptions.claimSession;

            // Add sync context to request body for non-GET requests
            let requestBody = fetchOptions.body;
            let requestPayload = null;
            if (fetchOptions.method && fetchOptions.method !== 'GET') {
                const syncContext = {
                    clientId: ModeContext.clientId,
                    lastUpdateUUID: ModeContext.lastUpdateUUID,
                    undoContext: captureUndoContext(),
                };

                if (claimSession) {
                    syncContext.viewport = captureViewportSnapshot();
                }
                
                if (requestBody) {
                    // Merge sync context with existing body
                    const existingBody = JSON.parse(requestBody);
                    requestPayload = {
                        ...existingBody,
                        ...syncContext
                    };
                    requestBody = JSON.stringify(requestPayload);
                } else {
                    // Just send sync context
                    requestPayload = syncContext;
                    requestBody = JSON.stringify(syncContext);
                }
            }
                                                
            if (CONFIG.DEBUG.LOG_API_CALLS) {
                console.log(' [API] Request:', {
                    url: url,
                    method: fetchOptions.method || 'GET',
                    hasBody: requestBody !== null && typeof requestBody !== 'undefined',
                });
            }

            const headers = {
                ...buildSessionHeaders(true),
                ...fetchOptions.headers
            };

            if (claimSession) {
                headers['X-Metalist-Claim'] = '1';
            }

            const response = await fetch(url, {
                ...fetchOptions,
                body: requestBody,
                headers: headers
            });

            if (!response.ok) {
                // Use centralized error handling
                ErrorHandler.handleApiError(null, response);
                throw new Error(`API call failed: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();

            if (claimSession) {
                CommandGate.markCommandServerCall();
            }

            if (CONFIG.DEBUG.LOG_API_CALLS) {
                console.log(' [API] Response:', {
                    url: url,
                    status: response.status,
                });
            }
            
            // Extract and store update UUID if present
            if (data && data.updateUUID) {
                // Polling can return the same update UUID when nothing changed server-side.
                if (ModeContext.lastUpdateUUID !== data.updateUUID) {
                    ModeContext.setLastUpdateUUID(data.updateUUID);
                }
                if (CONFIG.DEBUG.LOG_API_CALLS) {
                    console.log(' [API] Updated sync UUID:', data.updateUUID);
                }
            }
                                                
            return data;
        } catch (error) {
            if (error && error.name === 'AbortError') {
                throw error;
            }
            console.error(' [API] request failed');
            
            // Handle network errors (when fetch throws)
			if (!error.message.includes('API call failed:')) {
				// This is a network/connectivity error, not an HTTP error response
				ErrorHandler.handleApiError(error, null);
			}
            
            throw error;
        }
    },

    async createNote(firstVisibleNoteId, searchQuery) {
        const body = {
            first_visible_note_id: firstVisibleNoteId,
            search_query: searchQuery,
        };

        return this._apiCall(CONFIG.API.NOTES.CREATE, {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify(body)
        });
    },

    async createSibling(noteId, searchQuery) {
        const body = {
            search_query: searchQuery,
        };

        return this._apiCall(CONFIG.API.NOTES.CREATE_SIBLING(noteId), { 
            method: 'POST',
            claimSession: true,
            body: JSON.stringify(body)
        });
    },

    async createChild(noteId, searchQuery) {
        const body = {
            search_query: searchQuery,
        };

        return this._apiCall(CONFIG.API.NOTES.CREATE_CHILD(noteId), { 
            method: 'POST',
            claimSession: true,
            body: JSON.stringify(body)
        });
    },

    async updateNote(noteId, content, tags) {
        const sanitizedContent = sanitizeNoteHtmlForStorage(content);
        return this._apiCall(CONFIG.API.NOTES.UPDATE(noteId), {
            method: 'PUT',
            claimSession: true,
            body: JSON.stringify({ content: sanitizedContent, tags })
        });
    },

    async saveNote(noteId, content, tags) {
        const sanitizedContent = sanitizeNoteHtmlForStorage(content);
        return this._apiCall(CONFIG.API.NOTES.SAVE(noteId), {
            method: 'PUT',
            claimSession: true,
            body: JSON.stringify({ content: sanitizedContent, tags })
        }); 
    },

    async addSelectedTextTag(noteId, selectedText) {
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('NotesAPI.addSelectedTextTag requires noteId string');
        }
        if (typeof selectedText !== 'string' || selectedText.length === 0) {
            throw new Error('NotesAPI.addSelectedTextTag requires selectedText string');
        }
        return this._apiCall(CONFIG.API.NOTES.ADD_SELECTED_TEXT_TAG(noteId), {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify({ selectedText }),
        });
    },

    async makePseudoTagProposals(noteId) {
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('NotesAPI.makePseudoTagProposals requires noteId string');
        }
        return this._apiCall(CONFIG.API.NOTES.MAKE_PSEUDO_TAG_PROPOSALS(noteId), {
            method: 'POST',
            claimSession: true,
        });
    },

    async acceptTagProposal(noteId, proposal) {
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('NotesAPI.acceptTagProposal requires noteId string');
        }
        if (typeof proposal !== 'string' || proposal.length === 0) {
            throw new Error('NotesAPI.acceptTagProposal requires proposal string');
        }
        return this._apiCall(CONFIG.API.NOTES.ACCEPT_TAG_PROPOSAL(noteId), {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify({ proposal }),
        });
    },

    async rejectTagProposal(noteId, proposal) {
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('NotesAPI.rejectTagProposal requires noteId string');
        }
        if (typeof proposal !== 'string' || proposal.length === 0) {
            throw new Error('NotesAPI.rejectTagProposal requires proposal string');
        }
        return this._apiCall(CONFIG.API.NOTES.REJECT_TAG_PROPOSAL(noteId), {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify({ proposal }),
        });
    },

    async splitNote(noteId, segments, tags) {
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('NotesAPI.splitNote requires noteId string');
        }
        if (!Array.isArray(segments) || segments.length < 2) {
            throw new Error('NotesAPI.splitNote requires at least two segments');
        }
        for (const segment of segments) {
            if (typeof segment !== 'string') {
                throw new Error('NotesAPI.splitNote segments must be strings');
            }
        }
        if (typeof tags !== 'string') {
            throw new Error('NotesAPI.splitNote requires tags string');
        }
        const sanitizedSegments = segments.map(segment => sanitizeNoteHtmlForStorage(segment));
        return this._apiCall(CONFIG.API.NOTES.SPLIT(noteId), {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify({ segments: sanitizedSegments, tags }),
        });
    },

    async toggleTodo(noteId) {
        return this._apiCall(CONFIG.API.NOTES.TOGGLE_TODO(noteId), {
            method: 'POST',
            claimSession: true
        });
    },

    async unformatNote(noteId) {
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('NotesAPI.unformatNote requires noteId string');
        }
        return this._apiCall(CONFIG.API.NOTES.UNFORMAT(noteId), {
            method: 'POST',
            claimSession: true,
        });
    },

    async resizeImage(noteId, sourceKind, occurrenceIndex, action) {
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('NotesAPI.resizeImage requires noteId string');
        }
        if (sourceKind !== 'inline' && sourceKind !== 'file') {
            throw new Error('NotesAPI.resizeImage requires inline or file sourceKind');
        }
        if (!Number.isInteger(occurrenceIndex) || occurrenceIndex < 0) {
            throw new Error('NotesAPI.resizeImage requires non-negative occurrenceIndex');
        }
        if (action !== 'bigger' && action !== 'smaller' && action !== 'reset') {
            throw new Error('NotesAPI.resizeImage requires bigger, smaller, or reset action');
        }
        return this._apiCall(CONFIG.API.NOTES.RESIZE_IMAGE(noteId), {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify({ sourceKind, occurrenceIndex, action }),
        });
    },

    async runShell(noteId, timeoutSeconds) {
        if (!noteId) {
            throw new Error('runShell requires noteId');
        }
        if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0) {
            throw new Error('runShell requires non-negative integer timeoutSeconds');
        }
        const body = { timeoutSeconds };

        return this._apiCall(CONFIG.API.NOTES.RUN_SHELL(noteId), {
            method: 'POST',
            body: JSON.stringify(body)
        });
    },

    async getShellRun(noteId, runId) {
        if (!noteId) {
            throw new Error('getShellRun requires noteId');
        }
        if (!runId) {
            throw new Error('getShellRun requires runId');
        }

        return this._apiCall(CONFIG.API.NOTES.RUN_SHELL_STATUS(noteId, runId), {
            method: 'GET',
        });
    },

    async toggleReferenceMode(hostNoteId, referenceNoteId, occurrenceIndex, mode) {
        if (typeof hostNoteId !== 'string' || hostNoteId.length === 0) {
            throw new Error('NotesAPI.toggleReferenceMode requires hostNoteId string');
        }
        if (typeof referenceNoteId !== 'string' || referenceNoteId.length === 0) {
            throw new Error('NotesAPI.toggleReferenceMode requires referenceNoteId string');
        }
        if (!Number.isInteger(occurrenceIndex) || occurrenceIndex < 0) {
            throw new Error('NotesAPI.toggleReferenceMode requires non-negative integer occurrenceIndex');
        }
        if (mode !== 'embed' && mode !== 'link') {
            throw new Error('NotesAPI.toggleReferenceMode requires mode embed|link');
        }
        const body = {
            reference_note_id: referenceNoteId,
            occurrence_index: occurrenceIndex,
            mode,
        };
        return this._apiCall(CONFIG.API.NOTES.REFERENCE_MODE(hostNoteId), {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify(body),
        });
    },

    async moveNote(noteId, siblingId, position, newParentId) {
        const body = {
            sibling_id: siblingId,
            position: position?.toUpperCase(),
            tab_id: ModeContext.activeTabId,
        };
                                
        if (newParentId !== undefined) {
            body.new_parent_id = newParentId;
        }

        return this._apiCall(CONFIG.API.NOTES.MOVE(noteId), {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify(body)
        });
    },

    async moveNoteRelative(noteId, direction) {
        console.log('Moving note:', { noteId, direction });
                                
        const noteElement = DOMUtils.getNoteById(noteId);
        if (!noteElement) {
            throw new Error('Note element not found');
        }

        const siblingElement = direction === 'before' ? 
            noteElement.previousElementSibling : 
            noteElement.nextElementSibling;
        console.log('Sibling element:', siblingElement);
                                                
        if (!siblingElement) {
            console.log('No sibling found in direction:', direction);
            return;
        }

        const siblingId = DOMUtils.getNoteId(siblingElement);
        console.log('Found sibling:', { siblingId });

        const payload = { 
            position: direction.toUpperCase(),
            sibling_id: siblingId
        };
        console.log('Sending payload:', payload);

        return this._apiCall(CONFIG.API.NOTES.MOVE(noteId), {
            method: 'POST',
            claimSession: true,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
    },

    async deleteNote(noteId) {
        return this._apiCall(CONFIG.API.NOTES.DELETE(noteId), { method: 'DELETE', claimSession: true });
    },

    async collapseNote(noteId) {
        return this._apiCall(CONFIG.API.NOTES.COLLAPSE(noteId), {
            method: 'POST',
            claimSession: true,
        });
    },

    async expandNote(noteId) {
        return this._apiCall(CONFIG.API.NOTES.EXPAND(noteId), {
            method: 'POST',
            claimSession: true,
        });
    },

    async setCollapsedBulk(noteIds, collapsed) {
        if (!Array.isArray(noteIds)) {
            throw new Error('NotesAPI.setCollapsedBulk requires noteIds array');
        }
        for (const noteId of noteIds) {
            if (typeof noteId !== 'string' || noteId.length === 0) {
                throw new Error('NotesAPI.setCollapsedBulk requires noteIds to be non-empty strings');
            }
        }
        if (typeof collapsed !== 'boolean') {
            throw new Error('NotesAPI.setCollapsedBulk requires collapsed boolean');
        }

        const body = {
            note_ids: noteIds,
            collapsed: collapsed,
        };

        return this._apiCall(CONFIG.API.NOTES.SET_COLLAPSED_BULK, {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify(body),
        });
    },

    async setCollapsedInContext(searchQuery, collapsed) {
        if (typeof searchQuery !== 'string') {
            throw new Error('NotesAPI.setCollapsedInContext requires searchQuery string');
        }
        if (typeof collapsed !== 'boolean') {
            throw new Error('NotesAPI.setCollapsedInContext requires collapsed boolean');
        }

        const body = {
            search_query: searchQuery,
            collapsed: collapsed,
        };

        return this._apiCall(CONFIG.API.NOTES.SET_COLLAPSED_IN_CONTEXT, {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify(body),
        });
    },

    async undo() {
        const undoContext = captureUndoContext();
        const url = `${CONFIG.API.NOTES.UNDO}?client_id=${encodeURIComponent(ModeContext.clientId)}&undoContext=${encodeURIComponent(undoContext)}`;
        return this._apiCall(url, { method: 'POST', claimSession: true });
    },

    async redo() {
        const undoContext = captureUndoContext();
        const url = `${CONFIG.API.NOTES.REDO}?client_id=${encodeURIComponent(ModeContext.clientId)}&undoContext=${encodeURIComponent(undoContext)}`;
        return this._apiCall(url, { method: 'POST', claimSession: true });
    },

    async recordNoteInteraction(noteId, interactionType) {
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('NotesAPI.recordNoteInteraction requires noteId string');
        }
        if (typeof interactionType !== 'string' || interactionType.length === 0) {
            throw new Error('NotesAPI.recordNoteInteraction requires interactionType string');
        }
        const body = {
            noteId,
            interactionType,
        };
        return this._apiCall(CONFIG.API.NOTES.TAG_INTERACTIONS, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    },

    async recordSearchSuggestionSelection(tag) {
        if (typeof tag !== 'string' || tag.length === 0) {
            throw new Error('NotesAPI.recordSearchSuggestionSelection requires tag string');
        }
        return this._apiCall(CONFIG.API.NOTES.SEARCH_SUGGESTION_INTERACTION, {
            method: 'POST',
            body: JSON.stringify({ tag }),
        });
    },

    async recordTabSearchSelection(searchQuery) {
        if (typeof searchQuery !== 'string') {
            throw new Error('NotesAPI.recordTabSearchSelection requires searchQuery string');
        }
        return this._apiCall(CONFIG.API.NOTES.TAB_SEARCH_INTERACTION, {
            method: 'POST',
            body: JSON.stringify({ searchQuery }),
        });
    },

    async resetSearchSuggestionHistory() {
        return this._apiCall(CONFIG.API.NOTES.TAG_INTERACTIONS, {
            method: 'DELETE',
        });
    },

    async getSearchSuggestionStatistics() {
        return this._apiCall(CONFIG.API.NOTES.TAG_INTERACTIONS, {
            method: 'GET',
        });
    },

    getNoteElement(noteId) {
        const noteElement = document.querySelector(`[data-note-id="${noteId}"]`);
        if (!noteElement) {
            throw new Error(`Note not found: ${noteId}`);
        }
        return noteElement;
    },

    getNoteContentElement(noteId) {
        const noteElement = document.querySelector(`[data-note-id="${noteId}"]`);
        if (!noteElement) {
            throw new Error(`Note not found: ${noteId}`);
        }
        return noteElement.querySelector('.note-content');
    },

    async fetchView(noteId, searchQuery, tabId, visibleRootAnchorId) {
        if (typeof noteId === 'undefined') {
            throw new Error('NotesAPI.fetchView requires noteId (use null when not editing)');
        }
        if (typeof searchQuery === 'undefined') {
            throw new Error('NotesAPI.fetchView requires searchQuery (use null when empty)');
        }
        if (typeof tabId !== 'string') {
            throw new Error('NotesAPI.fetchView requires tabId string');
        }
        if (typeof visibleRootAnchorId === 'undefined') {
            throw new Error('NotesAPI.fetchView requires visibleRootAnchorId (use null when unknown)');
        }
        const payload = {
            clientId: ModeContext.clientId,
            editingNoteId: noteId,
            search: searchQuery,
            tabId,
            isUntaggedView: ModeContext.isUntaggedView,
            clientNoteUuidHashes: ModeContext.getNoteHashPayload(),
            visibleRootAnchorId,
        };

        const response = await this._apiCall(CONFIG.API.NOTES.VIEW, {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        return response;
    },

    async fetchSearchSuggestions(query, windowDays) {
        if (typeof query !== 'string') {
            throw new Error('NotesAPI.fetchSearchSuggestions requires query string');
        }
        if (!Array.isArray(windowDays)) {
            throw new Error('NotesAPI.fetchSearchSuggestions requires windowDays array');
        }
        const payload = { query, windowDays };
        return this._apiCall(CONFIG.API.NOTES.SEARCH_SUGGESTIONS, {
            method: 'POST',
            body: JSON.stringify(payload)
        });
    },

    async fetchPrioritizeTagSuggestions(query, searchQuery) {
        if (typeof query !== 'string') {
            throw new Error('NotesAPI.fetchPrioritizeTagSuggestions requires query string');
        }
        if (searchQuery !== null && typeof searchQuery !== 'string') {
            throw new Error('NotesAPI.fetchPrioritizeTagSuggestions requires searchQuery string or null');
        }
        const payload = {
            query,
            search_query: searchQuery,
        };
        return this._apiCall(CONFIG.API.NOTES.PRIORITIZE_TAG_SUGGESTIONS, {
            method: 'POST',
            body: JSON.stringify(payload),
        });
    },

    async fetchTagSuggestions(noteId, anchors, explicitTags, prefix, contentHtml, signal) {
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('NotesAPI.fetchTagSuggestions requires noteId string');
        }
        if (!Array.isArray(anchors)) {
            throw new Error('NotesAPI.fetchTagSuggestions requires anchors array');
        }
        if (!Array.isArray(explicitTags)) {
            throw new Error('NotesAPI.fetchTagSuggestions requires explicitTags array');
        }
        if (typeof prefix !== 'string') {
            throw new Error('NotesAPI.fetchTagSuggestions requires prefix string');
        }
        if (typeof contentHtml !== 'string') {
            throw new Error('NotesAPI.fetchTagSuggestions requires contentHtml string');
        }
        if (typeof signal !== 'undefined' && (signal === null || typeof signal !== 'object')) {
            throw new Error('NotesAPI.fetchTagSuggestions requires signal object when provided');
        }
        const payload = {
            note_id: noteId,
            anchors: anchors,
            explicit_tags: explicitTags,
            prefix: prefix,
            content_html: contentHtml
        };
        const options = {
            method: 'POST',
            body: JSON.stringify(payload)
        };
        if (typeof signal !== 'undefined') {
            options.signal = signal;
        }
        return this._apiCall(CONFIG.API.NOTES.TAG_SUGGESTIONS, options);
    },

    async fetchBacklinks(noteId, searchQuery) {
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('NotesAPI.fetchBacklinks requires noteId string');
        }
        if (searchQuery !== null && typeof searchQuery !== 'string') {
            throw new Error('NotesAPI.fetchBacklinks requires searchQuery string or null');
        }
        let url = CONFIG.API.NOTES.BACKLINKS(noteId);
        if (typeof searchQuery === 'string' && searchQuery.length > 0) {
            url = `${url}?search=${encodeURIComponent(searchQuery)}`;
        }
        return this._apiCall(url, {
            method: 'GET',
        });
    },

    async moveNoteUp(noteId) {
        const noteElement = this.getNoteElement(noteId);
        const prevSibling = noteElement.previousElementSibling;
        if (!prevSibling || !prevSibling.classList.contains(CONFIG.CLASSES.NOTE)) {
            return { status: 'noop' };
        }

        const parentId = noteElement.dataset.parentId;
        let parentIdOrNull = null;
        if (typeof parentId === 'string' && parentId.length > 0) {
            parentIdOrNull = parentId;
        }
                                
        return await this.moveNote(
            noteId,
            DOMUtils.getNoteId(prevSibling),
            'BEFORE',
            parentIdOrNull
        );
    },

    async moveNoteDown(noteId) {
        const noteElement = this.getNoteElement(noteId);
        const nextSibling = noteElement.nextElementSibling;
        if (!nextSibling || !nextSibling.classList.contains(CONFIG.CLASSES.NOTE)) {
            return { status: 'noop' };
        }

        const parentId = noteElement.dataset.parentId;
        let parentIdOrNull = null;
        if (typeof parentId === 'string' && parentId.length > 0) {
            parentIdOrNull = parentId;
        }
                                
        return await this.moveNote(
            noteId,
            DOMUtils.getNoteId(nextSibling),
            'AFTER',
            parentIdOrNull
        );
    },

    async moveNoteToTop(noteId, searchQuery) {
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('NotesAPI.moveNoteToTop requires noteId string');
        }
        if (searchQuery !== null && typeof searchQuery !== 'string') {
            throw new Error('NotesAPI.moveNoteToTop requires searchQuery string or null');
        }
        const body = {
            search_query: searchQuery,
            tab_id: ModeContext.activeTabId,
        };
        return this._apiCall(CONFIG.API.NOTES.MOVE_TO_TOP(noteId), {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify(body),
        });
    },

    async prioritize(tag, direction, searchQuery) {
        if (typeof tag !== 'string' || tag.length === 0) {
            throw new Error('NotesAPI.prioritize requires tag string');
        }
        if (typeof direction !== 'string' || direction.length === 0) {
            throw new Error('NotesAPI.prioritize requires direction string');
        }
        if (searchQuery !== null && typeof searchQuery !== 'string') {
            throw new Error('NotesAPI.prioritize requires searchQuery string or null');
        }
        const body = {
            tag,
            direction,
            search_query: searchQuery,
            tab_id: ModeContext.activeTabId,
        };
        return this._apiCall(CONFIG.API.NOTES.PRIORITIZE, {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify(body),
        });
    },

    async alphabetizeRootNotes(direction, searchQuery) {
        if (typeof direction !== 'string' || direction.length === 0) {
            throw new Error('NotesAPI.alphabetizeRootNotes requires direction string');
        }
        if (searchQuery !== null && typeof searchQuery !== 'string') {
            throw new Error('NotesAPI.alphabetizeRootNotes requires searchQuery string or null');
        }
        const body = {
            direction,
            search_query: searchQuery,
            tab_id: ModeContext.activeTabId,
        };
        return this._apiCall(CONFIG.API.NOTES.ALPHABETIZE_ROOT_NOTES, {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify(body),
        });
    },

    async resetUpdatedAtToCreatedAt(searchQuery) {
        if (searchQuery !== null && typeof searchQuery !== 'string') {
            throw new Error('NotesAPI.resetUpdatedAtToCreatedAt requires searchQuery string or null');
        }
        const body = {
            search_query: searchQuery,
            tab_id: ModeContext.activeTabId,
        };
        return this._apiCall(CONFIG.API.NOTES.RESET_UPDATED_AT_TO_CREATED_AT, {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify(body),
        });
    },

    async indentNote(noteId, visiblePrevId) {
        if (typeof visiblePrevId !== 'string' || visiblePrevId.length === 0) {
            throw new Error('NotesAPI.indentNote requires visiblePrevId string');
        }
        const body = {
            visible_prev_id: visiblePrevId,
        };
        return this._apiCall(CONFIG.API.NOTES.INDENT(noteId), {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify(body)
        });
    },

    async outdentNote(noteId, searchQuery) {
        const body = {
            search_query: searchQuery,
        };
        return this._apiCall(CONFIG.API.NOTES.OUTDENT(noteId), {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify(body)
        });
    },

    async copyNote(noteId) {
        return this._apiCall(CONFIG.API.NOTES.COPY(noteId), {
            method: 'POST'
        });
    },

    async getNoteFullscreen(noteId) {
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('NotesAPI.getNoteFullscreen requires noteId string');
        }
        const response = await this._apiCall(CONFIG.API.NOTES.FULLSCREEN(noteId), {
            method: 'GET',
        });
        if (response === null || typeof response !== 'object') {
            throw new Error('Note fullscreen response must be an object');
        }
        if (typeof response.html !== 'string' || response.html.length === 0) {
            throw new Error('Note fullscreen response must include non-empty html');
        }
        return response;
    },

    async exportCurrentViewAsHtml(theme, options = {}) {
        if (theme !== 'dark' && theme !== 'light') {
            throw new Error("NotesAPI.exportCurrentViewAsHtml requires theme 'dark' or 'light'");
        }
        if (options === null || typeof options !== 'object') {
            throw new Error('NotesAPI.exportCurrentViewAsHtml requires options object');
        }

        const searchQuery = ModeContext.searchQuery;
        if (searchQuery !== null && typeof searchQuery !== 'string') {
            throw new Error('ModeContext.searchQuery must be a string or null');
        }
        const noteId = options.noteId;
        if (noteId !== undefined && (typeof noteId !== 'string' || noteId.length === 0)) {
            throw new Error('NotesAPI.exportCurrentViewAsHtml requires noteId string when provided');
        }

        const params = new URLSearchParams();
        params.set('theme', theme);
        params.set('search_query', typeof searchQuery === 'string' ? searchQuery : '');
        if (typeof noteId === 'string') {
            params.set('note_id', noteId);
        }

        const response = await fetch(`${CONFIG.API.NOTES.EXPORT_HTML}?${params.toString()}`, {
            method: 'GET',
            headers: buildAuthHeaders(false),
        });
        if (!response.ok) {
            ErrorHandler.handleApiError(null, response);
            throw new Error(`HTML export failed: ${response.status} ${response.statusText}`);
        }

        if (response.redirected) {
            throw new Error('HTML export request was redirected unexpectedly');
        }

        const exportMarker = response.headers.get('x-metalist-export');
        if (exportMarker !== 'notes-html-v1') {
            throw new Error('HTML export response missing export marker');
        }

        const filename = extractFilenameFromContentDisposition(
            response.headers.get('content-disposition')
        );
        if (typeof filename !== 'string' || filename.length === 0) {
            throw new Error('HTML export response missing filename');
        }

        const htmlText = await response.text();
        if (!htmlText.startsWith('<!DOCTYPE html>')) {
            throw new Error('HTML export response was not a standalone HTML document');
        }
        if (htmlText.includes('id="login-page"') || htmlText.includes('id="main-app"')) {
            throw new Error('HTML export response included app shell markup');
        }

        return {
            blob: new Blob([htmlText], { type: 'text/html' }),
            filename,
        };
    },

    async pasteNoteSibling(targetNoteId) {
        const body = {
            search_query: ModeContext.searchQuery,
        };
        return this._apiCall(CONFIG.API.NOTES.PASTE_SIBLING(targetNoteId), {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify(body),
        });
    },

    async pasteNoteChild(targetNoteId) {
        const body = {
            search_query: ModeContext.searchQuery,
        };
        return this._apiCall(CONFIG.API.NOTES.PASTE_CHILD(targetNoteId), {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify(body),
        });
    },

    // Note locks removed: single-tab session ownership enforces exclusivity.
};

export const FilesAPI = {
    async uploadFile(file) {
        if (!(file instanceof File)) {
            throw new Error('FilesAPI.uploadFile requires File');
        }

        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch(CONFIG.API.FILES.UPLOAD, {
            method: 'POST',
            headers: buildAuthHeaders(false),
            body: formData,
        });
        if (!response.ok) {
            ErrorHandler.handleApiError(null, response);
            throw new Error(`File upload failed: ${response.status} ${response.statusText}`);
        }

        return await response.json();
    },

    async downloadFile(fileId) {
        if (typeof fileId !== 'string' || fileId.length === 0) {
            throw new Error('FilesAPI.downloadFile requires fileId string');
        }

        const response = await fetch(CONFIG.API.FILES.DOWNLOAD(fileId), {
            method: 'GET',
            headers: buildAuthHeaders(false),
        });
        if (!response.ok) {
            ErrorHandler.handleApiError(null, response);
            throw new Error(`File download failed: ${response.status} ${response.statusText}`);
        }

        return {
            blob: await response.blob(),
            filename: extractFilenameFromContentDisposition(
                response.headers.get('content-disposition')
            ),
        };
    },

    async trimUnusedFiles() {
        const response = await fetch(CONFIG.API.FILES.TRIM_UNUSED, {
            method: 'POST',
            headers: buildAuthHeaders(true),
            body: JSON.stringify({}),
        });
        if (!response.ok) {
            ErrorHandler.handleApiError(null, response);
            throw new Error(`Trim unused files failed: ${response.status} ${response.statusText}`);
        }

        return await response.json();
    },
};

export const SoundsAPI = {
    async listSounds() {
        const response = await fetch(CONFIG.API.SOUNDS.LIST, {
            method: 'GET',
            headers: buildAuthHeaders(false),
        });
        if (!response.ok) {
            ErrorHandler.handleApiError(null, response);
            throw new Error(`Sound list failed: ${response.status} ${response.statusText}`);
        }
        return await response.json();
    },

    async uploadSound({ title, file }) {
        if (typeof title !== 'string' || title.trim().length === 0) {
            throw new Error('SoundsAPI.uploadSound requires title');
        }
        if (!(file instanceof File)) {
            throw new Error('SoundsAPI.uploadSound requires File');
        }
        const formData = new FormData();
        formData.append('title', title);
        formData.append('file', file);
        const response = await fetch(CONFIG.API.SOUNDS.UPLOAD, {
            method: 'POST',
            headers: buildAuthHeaders(false),
            body: formData,
        });
        if (!response.ok) {
            ErrorHandler.handleApiError(null, response);
            throw new Error(`Sound upload failed: ${response.status} ${response.statusText}`);
        }
        return await response.json();
    },

    async updateSound(soundId, { title }) {
        if (typeof soundId !== 'string' || soundId.length === 0) {
            throw new Error('SoundsAPI.updateSound requires soundId');
        }
        if (typeof title !== 'string' || title.trim().length === 0) {
            throw new Error('SoundsAPI.updateSound requires title');
        }
        const response = await fetch(CONFIG.API.SOUNDS.UPDATE(soundId), {
            method: 'PUT',
            headers: buildAuthHeaders(true),
            body: JSON.stringify({ title }),
        });
        if (!response.ok) {
            ErrorHandler.handleApiError(null, response);
            throw new Error(`Sound update failed: ${response.status} ${response.statusText}`);
        }
        return await response.json();
    },

    async deleteSound(soundId) {
        if (typeof soundId !== 'string' || soundId.length === 0) {
            throw new Error('SoundsAPI.deleteSound requires soundId');
        }
        const response = await fetch(CONFIG.API.SOUNDS.DELETE(soundId), {
            method: 'DELETE',
            headers: buildAuthHeaders(false),
        });
        if (!response.ok) {
            ErrorHandler.handleApiError(null, response);
            throw new Error(`Sound delete failed: ${response.status} ${response.statusText}`);
        }
        return await response.json();
    },
};

async function remindersJsonRequest(url, options) {
    if (typeof url !== 'string' || url.length === 0) {
        throw new Error('remindersJsonRequest requires url');
    }
    if (!options || typeof options !== 'object') {
        throw new Error('remindersJsonRequest requires options');
    }
    const response = await fetch(url, {
        ...options,
        headers: {
            ...buildAuthHeaders(true),
            ...options.headers,
        },
    });
    if (!response.ok) {
        ErrorHandler.handleApiError(null, response);
        throw new Error(`Reminder request failed: ${response.status} ${response.statusText}`);
    }
    return await response.json();
}

function reminderLocalDate(value) {
    if (!(value instanceof Date)) {
        throw new Error('reminderLocalDate requires Date');
    }
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function reminderLocalIso(value) {
    if (!(value instanceof Date)) {
        throw new Error('reminderLocalIso requires Date');
    }
    const dateText = reminderLocalDate(value);
    const hour = String(value.getHours()).padStart(2, '0');
    const minute = String(value.getMinutes()).padStart(2, '0');
    const second = String(value.getSeconds()).padStart(2, '0');
    const offsetMinutes = -value.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const absolute = Math.abs(offsetMinutes);
    const offsetHours = String(Math.floor(absolute / 60)).padStart(2, '0');
    const offsetRemainder = String(absolute % 60).padStart(2, '0');
    return `${dateText}T${hour}:${minute}:${second}${sign}${offsetHours}:${offsetRemainder}`;
}

function reminderActionBody(actionName, actionPayload) {
    if (!actionPayload || typeof actionPayload !== 'object') {
        throw new Error('reminderActionBody requires actionPayload');
    }
    if (actionName === 'acknowledge') {
        const now = new Date();
        return {
            now: reminderLocalIso(now),
            local_date: reminderLocalDate(now),
            activity_kind: 'non_idle_use',
        };
    }
    if (actionName === 'pre_acknowledge') {
        if (typeof actionPayload.pre_reminder_key !== 'string' || actionPayload.pre_reminder_key.length === 0) {
            throw new Error('pre_acknowledge requires pre_reminder_key');
        }
        return {
            now: reminderLocalIso(new Date()),
            pre_reminder_key: actionPayload.pre_reminder_key,
        };
    }
    return {};
}

export const RemindersAPI = {
    async list() {
        return remindersJsonRequest(CONFIG.API.REMINDERS.LIST, {
            method: 'GET',
        });
    },

    async create(payload) {
        return remindersJsonRequest(CONFIG.API.REMINDERS.CREATE, {
            method: 'POST',
            body: JSON.stringify(payload),
        });
    },

    async update(reminderId, payload) {
        if (typeof reminderId !== 'string' || reminderId.length === 0) {
            throw new Error('RemindersAPI.update requires reminderId');
        }
        return remindersJsonRequest(CONFIG.API.REMINDERS.UPDATE(reminderId), {
            method: 'PUT',
            body: JSON.stringify(payload),
        });
    },

    async delete(reminderId) {
        if (typeof reminderId !== 'string' || reminderId.length === 0) {
            throw new Error('RemindersAPI.delete requires reminderId');
        }
        return remindersJsonRequest(CONFIG.API.REMINDERS.DELETE(reminderId), {
            method: 'DELETE',
        });
    },

    async action(reminderId, actionName, actionPayload) {
        if (typeof reminderId !== 'string' || reminderId.length === 0) {
            throw new Error('RemindersAPI.action requires reminderId');
        }
        if (!actionPayload || typeof actionPayload !== 'object') {
            throw new Error('RemindersAPI.action requires actionPayload');
        }
        const actionUrls = {
            acknowledge: CONFIG.API.REMINDERS.ACKNOWLEDGE,
            pre_acknowledge: CONFIG.API.REMINDERS.PRE_ACKNOWLEDGE,
            dismiss: CONFIG.API.REMINDERS.DISMISS,
            done: CONFIG.API.REMINDERS.DONE,
            pause: CONFIG.API.REMINDERS.PAUSE,
            resume: CONFIG.API.REMINDERS.RESUME,
            skip_next: CONFIG.API.REMINDERS.SKIP_NEXT,
        };
        const urlBuilder = actionUrls[actionName];
        if (typeof urlBuilder !== 'function') {
            throw new Error(`Unsupported reminder action: ${actionName}`);
        }
        return remindersJsonRequest(urlBuilder(reminderId), {
            method: 'POST',
            body: JSON.stringify(reminderActionBody(actionName, actionPayload)),
        });
    },

    async evaluate(payload) {
        return remindersJsonRequest(CONFIG.API.REMINDERS.EVALUATE, {
            method: 'POST',
            body: JSON.stringify(payload),
        });
    },
};
