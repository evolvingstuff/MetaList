import { ApplicationState } from '../application-state.js';
/**
 * HelpModal - Display the keyboard shortcuts cheatsheet
 *
 * Shows the available keyboard shortcuts and command reminders
 * Triggered by pressing '?' in idle mode
 */

import { BaseModal } from './base-modal.js';

export class HelpModal extends BaseModal {
    constructor() {
        super('help', 'help-modal');

        ApplicationState.own(this, 'HelpModal', new.target === HelpModal);
    }

    /**
     * Create and show the modal element with shortcuts list
     */
    showModalElement() {
        let modalElement = document.getElementById(this.modalElementId);

        // Create modal element if it doesn't exist
        if (!modalElement) {
            modalElement = document.createElement('div');
            modalElement.id = this.modalElementId;
            modalElement.className = 'modal';
            modalElement.style.display = 'none';
            document.body.appendChild(modalElement);
        }

        // Build the shortcuts content
        const shortcutsHTML = this.buildShortcutsHTML();

        modalElement.innerHTML = `
            <div class="modal-content help-modal-content">
                <h2>Keyboard Shortcuts / Cheatsheet</h2>
                <div class="help-shortcuts-container">
                    ${shortcutsHTML}
                </div>
            </div>
        `;

        modalElement.style.display = 'flex';
    }

    /**
     * Build HTML for shortcuts list organized by category
     */
    buildShortcutsHTML() {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const modKey = isMac ? 'Cmd' : 'Ctrl';
        const shiftKey = 'Shift';
        const enterKey = 'Enter';
        const upArrowKey = 'Up';
        const downArrowKey = 'Down';
        const leftArrowKey = 'Left';
        const rightArrowKey = 'Right';

        const shortcuts = [
            {
                category: 'Global and Idle',
                columnCount: 2,
                items: [
                    { keys: `${modKey}+/`, description: 'Open command palette' },
                    { keys: '?', description: 'Open keyboard shortcuts / cheatsheet (idle only)' },
                    { keys: 'Esc', description: 'Defocus search, exit edit mode, or close top modal' },
                    { keys: 'Enter', description: 'Create new root note (idle or from search)' },
                    { keys: 'Tab', description: 'Focus search and select the current query (idle only)' },
                    { keys: `${modKey}+Z`, description: 'Undo' },
                    { keys: `${modKey}+${shiftKey}+Z / ${modKey}+Y`, description: 'Redo' },
                ]
            },
            {
                category: 'When Editing',
                columnCount: 2,
                items: [
                    { keys: 'Tab', description: 'Toggle focus between note content and tag bar' },
                    { keys: `${modKey}+${enterKey}`, description: 'Create sibling note' },
                    { keys: `${modKey}+${shiftKey}+${enterKey}`, description: 'Create child note' },
                    { keys: `${modKey}+${leftArrowKey}`, description: 'Outdent note' },
                    { keys: `${modKey}+${rightArrowKey}`, description: 'Indent note' },
                    { keys: `${modKey}+${upArrowKey}`, description: 'Move current note up' },
                    { keys: `${modKey}+${shiftKey}+${upArrowKey}`, description: 'Move current note to top' },
                    { keys: `${modKey}+${downArrowKey}`, description: 'Move current note down' },
                    { keys: `${modKey}+C`, description: 'Copy selection, or whole note if none' },
                    { keys: `${modKey}+X`, description: 'Cut selection, or whole note if none' },
                    { keys: `${modKey}+V`, description: 'Paste note as sibling in note-clipboard mode' },
                    { keys: `${modKey}+${shiftKey}+V`, description: 'Paste note as child in note-clipboard mode' },
                    { keys: `${modKey}+R`, description: 'Paste embedded reference from last copied note' },
                    { keys: `${modKey}+${shiftKey}+R`, description: 'Paste embedded reference as child note' },
                    { keys: `${modKey}+S`, description: 'Split note at selection/caret' },
                    { keys: `${modKey}+U`, description: 'Remove formatting from selection, or whole note if none' },
                    { keys: `${modKey}+Backspace/Delete`, description: 'Delete selected note' },
                ]
            }
        ];

        const splitItemsIntoColumns = (items, columnCount) => {
            if (!Array.isArray(items)) {
                throw new Error('Help modal section items must be an array');
            }
            if (!Number.isInteger(columnCount) || columnCount < 1) {
                throw new Error('Help modal section columnCount must be a positive integer');
            }

            const rowsPerColumn = Math.ceil(items.length / columnCount);
            const columns = [];

            let startIndex = 0;
            while (startIndex < items.length) {
                columns.push(items.slice(startIndex, startIndex + rowsPerColumn));
                startIndex += rowsPerColumn;
            }

            return columns;
        };

        const sectionsHTML = shortcuts.map((section) => `
            <section class="help-section">
                <h3 class="help-category">${section.category}</h3>
                <div class="help-section-grid help-section-grid-${section.columnCount}">
                    ${splitItemsIntoColumns(section.items, section.columnCount).map((columnItems) => `
                        <table class="help-shortcuts-table">
                            <tbody>
                                ${columnItems.map((item) => `
                                    <tr class="help-shortcut-row">
                                        <th scope="row" class="help-keys-cell">
                                            <span class="help-keys">${item.keys}</span>
                                        </th>
                                        <td class="help-description-cell">${item.description}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    `).join('')}
                </div>
            </section>
        `).join('');

        const footnotes = [
            isMac ? 'Use Ctrl instead of Cmd on Windows/Linux.' : 'Shown with Ctrl for this platform.',
            'Tag-bar focus still honors note-level editing shortcuts, including unformat.',
            'Paste-note shortcuts fall back to normal paste when note clipboard mode is inactive.',
        ];

        return `
            <div class="help-shortcuts-grid">
                ${sectionsHTML}
            </div>
            <div class="help-shortcuts-footnotes">
                ${footnotes.map((note) => `<p class="help-shortcuts-note">${note}</p>`).join('')}
            </div>
        `;
    }

    /**
     * Allow click outside to close the modal.
     */
    shouldCloseOnClickOutside() {
        return true;
    }
}
