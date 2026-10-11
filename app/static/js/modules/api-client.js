import { FileEditSessionExpiredError, FileRevisionConflictError, HttpRequestError, ServerInputRejectedError, rethrowUnexpectedError } from './expected-errors.js';
import { CONFIG } from './config.js';
import { DOMUtils } from './dom-utils.js';
import { ModeContextInstance as ModeContext } from './mode-manager/mode-context.js';
import { ErrorHandler } from './error-handler.js';
import { computeScrollAnchor } from './mode-manager/services/scroll-anchor-service.js';
import { CommandGate } from './mode-manager/services/command-gate-service.js';
import { buildSessionHeaders } from './session-auth.js';
import { sanitizeNoteHtmlForStorage } from './note-html-sanitizer.js';
import { describeApiFailure } from './api-error-diagnostics.js';

function buildAuthHeaders(includeContentType) {
    return buildSessionHeaders(includeContentType);
}

const FILE_REVISION_HEADER = 'X-MetaList-File-Revision';
const FILE_PREVIEW_VARIANTS = ['light', 'dark'];

function readFileRevision(response) {
    const revision = Number(response.headers.get(FILE_REVISION_HEADER));
    if (!Number.isInteger(revision) || revision < 1) {
        throw new Error(`Response is missing a valid ${FILE_REVISION_HEADER} header`);
    }
    return revision;
}

function requireFileId(fileId, methodName) {
    if (typeof fileId !== 'string' || fileId.length === 0) {
        throw new Error(`FilesAPI.${methodName} requires fileId string`);
    }
}

function requireRevision(revision, methodName) {
    if (!Number.isInteger(revision) || revision < 1) {
        throw new Error(`FilesAPI.${methodName} requires a positive integer revision`);
    }
}

async function throwFileRevisionConflict(response, description) {
    const body = await response.json();
    throw new FileRevisionConflictError(`${description}: ${body.detail}`, body.currentRevision);
}

function requireSessionId(sessionId, methodName) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error(`FilesAPI.${methodName} requires sessionId string`);
    }
}

// Diagram editing sessions answer with the sync UUID, which this window adopts as its own change.
async function postFileEditSession(url, body, description) {
    const response = await fetch(url, {
        method: 'POST',
        headers: buildSessionHeaders(true),
        body: JSON.stringify(body),
    });
    if (response.status === 409) {
        await throwFileRevisionConflict(response, description);
    }
    if (response.status === 410) {
        throw new FileEditSessionExpiredError(`${description}: the editing session is no longer open`);
    }
    if (!response.ok) {
        ErrorHandler.handleApiError(null, response);
        throw new HttpRequestError(`${description} failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (typeof data.updateUUID !== 'string' || data.updateUUID.length === 0) {
        throw new Error(`${description} response is missing updateUUID`);
    }
    if (!Number.isInteger(data.contentRevision) || data.contentRevision < 1) {
        throw new Error(`${description} response is missing contentRevision`);
    }
    if (ModeContext.lastUpdateUUID !== data.updateUUID) {
        ModeContext.setLastUpdateUUID(data.updateUUID);
    }
    return data;
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

export function captureViewportSnapshot() {
    return {
        scrollY: Math.max(0, Math.round(window.scrollY)),
        scrollAnchor: computeScrollAnchor({ anchorBias: 'auto' }),
    };
}

export function captureUndoContext() {
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

            if (response.status === 400 && response.headers.get('content-type')?.includes('application/json')) {
                const rejection = await response.clone().json();
                if (rejection.inputRejected === true && typeof rejection.detail === 'string') {
                    throw new ServerInputRejectedError(rejection.detail);
                }
            }
            if (!response.ok) {
                // Use centralized error handling
                ErrorHandler.handleApiError(null, response);
                throw new HttpRequestError(await describeApiFailure(response));
            }

            const data = await response.json();

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
            rethrowUnexpectedError(error);
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

    async createFilePreviewChild(noteId, fileId, searchQuery) {
        return this._apiCall(CONFIG.API.NOTES.CREATE_FILE_PREVIEW_CHILD(noteId), {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify({ fileId, search_query: searchQuery }),
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

    async setCollapsedInContext(searchQuery, collapsed, recursive) {
        if (typeof searchQuery !== 'string') {
            throw new Error('NotesAPI.setCollapsedInContext requires searchQuery string');
        }
        if (typeof collapsed !== 'boolean') {
            throw new Error('NotesAPI.setCollapsedInContext requires collapsed boolean');
        }
        if (typeof recursive !== 'boolean') {
            throw new Error('NotesAPI.setCollapsedInContext requires recursive boolean');
        }

        const body = {
            search_query: searchQuery,
            collapsed: collapsed,
            recursive: recursive,
        };

        return this._apiCall(CONFIG.API.NOTES.SET_COLLAPSED_IN_CONTEXT, {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify(body),
        });
    },

    async setCollapsedSubtree(noteId, collapsed) {
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('NotesAPI.setCollapsedSubtree requires noteId string');
        }
        if (typeof collapsed !== 'boolean') {
            throw new Error('NotesAPI.setCollapsedSubtree requires collapsed boolean');
        }
        return this._apiCall(CONFIG.API.NOTES.SET_COLLAPSED_SUBTREE(noteId), {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify({ collapsed }),
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

    async fetchView(noteId, searchQuery, tabId, visibleRootRange, startAtListEnd) {
        if (typeof noteId === 'undefined') {
            throw new Error('NotesAPI.fetchView requires noteId (use null when not editing)');
        }
        if (typeof searchQuery === 'undefined') {
            throw new Error('NotesAPI.fetchView requires searchQuery (use null when empty)');
        }
        if (typeof tabId !== 'string') {
            throw new Error('NotesAPI.fetchView requires tabId string');
        }
        if (!visibleRootRange || typeof visibleRootRange !== 'object'
            || typeof visibleRootRange.topRootId === 'undefined'
            || typeof visibleRootRange.bottomRootId === 'undefined') {
            throw new Error('NotesAPI.fetchView requires visibleRootRange {topRootId, bottomRootId} (null when unknown)');
        }
        if (typeof startAtListEnd !== 'boolean') {
            throw new Error('NotesAPI.fetchView requires startAtListEnd boolean');
        }
        const payload = {
            clientId: ModeContext.clientId,
            editingNoteId: noteId,
            search: searchQuery,
            tabId,
            isUntaggedView: ModeContext.isUntaggedView,
            // The server keeps this tab's warm view, so the browser sends only
            // where it is. A tab holding no view (fresh, or reset locally)
            // gets its initial window instead of a diff.
            tabViewEmpty: ModeContext.getTabNoteHashCount(tabId) === 0,
            visibleTopRootId: visibleRootRange.topRootId,
            visibleBottomRootId: visibleRootRange.bottomRootId,
            // Go to Bottom: the band that ends at the view's last root.
            startAtListEnd,
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

    // Retry failed link titles: progress (status "idle" before any run), start, stop.
    async getLinkTitleRetry() {
        return this._apiCall(CONFIG.API.NOTES.LINK_TITLE_RETRY, { method: 'GET' });
    },

    async startLinkTitleRetry() {
        return this._apiCall(CONFIG.API.NOTES.LINK_TITLE_RETRY, { method: 'POST' });
    },

    async stopLinkTitleRetry() {
        return this._apiCall(CONFIG.API.NOTES.LINK_TITLE_RETRY_STOP, { method: 'POST' });
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

    async moveNoteToBottom(noteId, searchQuery) {
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('NotesAPI.moveNoteToBottom requires noteId string');
        }
        if (searchQuery !== null && typeof searchQuery !== 'string') {
            throw new Error('NotesAPI.moveNoteToBottom requires searchQuery string or null');
        }
        return this._apiCall(CONFIG.API.NOTES.MOVE_TO_BOTTOM(noteId), {
            method: 'POST',
            claimSession: true,
            body: JSON.stringify({ search_query: searchQuery, tab_id: ModeContext.activeTabId }),
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

    async getFloatingNote(noteId, revision) {
        if (typeof noteId !== 'string' || noteId.length === 0 || typeof revision !== 'string') {
            throw new Error('getFloatingNote requires noteId and revision strings');
        }
        return this._apiCall(`${CONFIG.API.NOTES.FLOATING(noteId)}?revision=${encodeURIComponent(revision)}`, {
            method: 'GET',
        });
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
            throw new HttpRequestError(`HTML export failed: ${response.status} ${response.statusText}`);
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
            throw new HttpRequestError(`File upload failed: ${response.status} ${response.statusText}`);
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
            throw new HttpRequestError(`File download failed: ${response.status} ${response.statusText}`);
        }

        return {
            blob: await response.blob(),
            filename: extractFilenameFromContentDisposition(
                response.headers.get('content-disposition')
            ),
            revision: readFileRevision(response),
        };
    },

    // Replace an Excalidraw scene in place; throws FileRevisionConflictError if it was saved elsewhere first.
    async replaceFileContent(fileId, contentBlob, filename, expectedRevision) {
        requireFileId(fileId, 'replaceFileContent');
        requireRevision(expectedRevision, 'replaceFileContent');
        if (!(contentBlob instanceof Blob)) {
            throw new Error('FilesAPI.replaceFileContent requires a Blob');
        }
        if (typeof filename !== 'string' || filename.length === 0) {
            throw new Error('FilesAPI.replaceFileContent requires filename string');
        }

        const formData = new FormData();
        formData.append('file', contentBlob, filename);
        formData.append('expected_revision', String(expectedRevision));
        const response = await fetch(CONFIG.API.FILES.CONTENT(fileId), {
            method: 'PUT',
            headers: buildAuthHeaders(false),
            body: formData,
        });
        if (response.status === 409) {
            await throwFileRevisionConflict(response, 'File changed elsewhere');
        }
        if (!response.ok) {
            ErrorHandler.handleApiError(null, response);
            throw new HttpRequestError(`File update failed: ${response.status} ${response.statusText}`);
        }
        return await response.json();
    },

    // Store the light and dark SVG previews rendered from contentRevision.
    async storeFilePreviews(fileId, previewSvgByVariant, contentRevision) {
        requireFileId(fileId, 'storeFilePreviews');
        requireRevision(contentRevision, 'storeFilePreviews');
        const formData = new FormData();
        for (const variant of FILE_PREVIEW_VARIANTS) {
            const svgText = previewSvgByVariant[variant];
            if (typeof svgText !== 'string' || !svgText.startsWith('<svg')) {
                throw new Error(`FilesAPI.storeFilePreviews requires an SVG string for ${variant}`);
            }
            formData.append(variant, new Blob([svgText], { type: 'image/svg+xml' }), `${variant}.svg`);
        }
        formData.append('content_revision', String(contentRevision));
        const response = await fetch(CONFIG.API.FILES.PREVIEWS(fileId), {
            method: 'PUT',
            headers: buildAuthHeaders(false),
            body: formData,
        });
        if (response.status === 409) {
            await throwFileRevisionConflict(response, 'File changed before its preview was saved');
        }
        if (!response.ok) {
            ErrorHandler.handleApiError(null, response);
            throw new HttpRequestError(`File preview save failed: ${response.status} ${response.statusText}`);
        }
        return await response.json();
    },

    // Snapshots the diagram on the server so the whole editing session undoes as one step.
    // Returns { sessionId, contentRevision }.
    async startEditSession(fileId) {
        requireFileId(fileId, 'startEditSession');
        const data = await postFileEditSession(CONFIG.API.FILES.EDIT_SESSIONS(fileId), {}, 'Opening the diagram');
        if (typeof data.sessionId !== 'string' || data.sessionId.length === 0) {
            throw new Error('Opening the diagram response is missing sessionId');
        }
        return { sessionId: data.sessionId, contentRevision: data.contentRevision };
    },

    // Ends the session after Done. Returns { undoStepRecorded, contentRevision }. A new diagram's
    // first session records no step of its own: undoing its insertion removes it entirely.
    async finishEditSession(fileId, sessionId, hostNoteId, contentRevision, isNewDiagram) {
        requireFileId(fileId, 'finishEditSession');
        requireSessionId(sessionId, 'finishEditSession');
        requireRevision(contentRevision, 'finishEditSession');
        if (typeof hostNoteId !== 'string' || hostNoteId.length === 0) {
            throw new Error('FilesAPI.finishEditSession requires hostNoteId string');
        }
        if (typeof isNewDiagram !== 'boolean') {
            throw new Error('FilesAPI.finishEditSession requires isNewDiagram boolean');
        }
        const data = await postFileEditSession(CONFIG.API.FILES.EDIT_SESSION_FINISH(fileId, sessionId), {
            clientId: ModeContext.clientId,
            hostNoteId,
            contentRevision,
            isNewDiagram,
            undoContext: captureUndoContext(),
            viewport: captureViewportSnapshot(),
        }, 'Saving the diagram to undo history');
        if (typeof data.undoStepRecorded !== 'boolean') {
            throw new Error('Finishing the diagram edit response is missing undoStepRecorded');
        }
        return { undoStepRecorded: data.undoStepRecorded, contentRevision: data.contentRevision };
    },

    // Restores the diagram the session opened with. Returns { contentRevision }.
    async discardEditSession(fileId, sessionId, contentRevision) {
        requireFileId(fileId, 'discardEditSession');
        requireSessionId(sessionId, 'discardEditSession');
        requireRevision(contentRevision, 'discardEditSession');
        const data = await postFileEditSession(CONFIG.API.FILES.EDIT_SESSION_DISCARD(fileId, sessionId), {
            contentRevision,
        }, 'Discarding the diagram changes');
        return { contentRevision: data.contentRevision };
    },

    // Returns { status: 'missing' } until a preview has been saved, else { status: 'ready', blob, revision }.
    async downloadFilePreview(fileId, variant) {
        requireFileId(fileId, 'downloadFilePreview');
        if (!FILE_PREVIEW_VARIANTS.includes(variant)) {
            throw new Error(`FilesAPI.downloadFilePreview unknown variant: ${variant}`);
        }
        const response = await fetch(CONFIG.API.FILES.PREVIEW(fileId, variant), {
            method: 'GET',
            headers: buildAuthHeaders(false),
        });
        if (response.status === 404) {
            return { status: 'missing' };
        }
        if (!response.ok) {
            ErrorHandler.handleApiError(null, response);
            throw new HttpRequestError(`File preview download failed: ${response.status} ${response.statusText}`);
        }
        return { status: 'ready', blob: await response.blob(), revision: readFileRevision(response) };
    },

    async trimUnusedFiles() {
        const response = await fetch(CONFIG.API.FILES.TRIM_UNUSED, {
            method: 'POST',
            headers: buildAuthHeaders(true),
            body: JSON.stringify({}),
        });
        if (!response.ok) {
            ErrorHandler.handleApiError(null, response);
            throw new HttpRequestError(`Trim unused files failed: ${response.status} ${response.statusText}`);
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
        throw new HttpRequestError(`Reminder request failed: ${response.status} ${response.statusText}`);
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
