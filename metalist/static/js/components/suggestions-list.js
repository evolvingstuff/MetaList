'use strict';


import { escapeTextForHtml } from '../misc/parsing';

class SuggestionsList extends HTMLElement {

    constructor() {
        super();
        this.myId = null;
        this.suggestions = [];
    }

    render() {
        let html = '';
        for (let i = 0; i < this.suggestions.length; i++) {
            let escapedHtml = escapeTextForHtml(this.suggestions[i]);
            html += `    <div class="suggestion">${escapedHtml}</div>`;
        }
        this.innerHTML = html;

        const suggestions = document.getElementById(this.myId);
        const attached_to = this.getAttribute('data-attached-to');
        const webComponent = document.getElementById(attached_to);
        const inputBox = webComponent.querySelector('input');
        const orientation = this.getAttribute('data-orientation');

        let gap = 3;
        let rect = inputBox.getBoundingClientRect();
        suggestions.style.left = rect.left + 'px';
        suggestions.style.width = rect.width + 'px';

        if (orientation === 'below') {
            suggestions.style.top = (rect.bottom + window.scrollY + gap) + 'px'; //TODO do we need scrollY?
        }
        else if (orientation === 'above') {
            suggestions.style.top = (rect.top - suggestions.offsetHeight - gap) + 'px';
        }
        else {
            throw Error(`unknown (or missing) orientation attribute: ${orientation}`);
        }
    }

    updateSuggestions(suggestions) {
        this.suggestions = suggestions;
        this.render();
    }

    attachEventHandlers() {

        const attached_to = this.getAttribute('data-attached-to');
        const webComponent = document.getElementById(attached_to);
        const inputBox = webComponent.querySelector('input');
        const suggestionsDiv = document.getElementById(this.myId);

        window.addEventListener('resize', (evt) => {
            this.render();
        }, false); // Use capture: false for bubbling behavior

        inputBox.addEventListener('focus', () => {
            suggestionsDiv.style.display = 'block'; //make it visible BEFORE render
            this.render();
        });

        inputBox.addEventListener('blur', () => {
            suggestionsDiv.style.display = 'none';
        });

        this.addEventListener('mousedown', (evt) => {
            evt.stopPropagation();
            evt.preventDefault();
            const suggestion = evt.target.innerText;
            const attached_to = this.getAttribute('data-attached-to');
            const webComponent = document.getElementById(attached_to);
            const inputBox = webComponent.querySelector('input');
            inputBox.value = suggestion;
            inputBox.focus();
            const event = new Event('input', { bubbles: true, cancelable: true });
            inputBox.dispatchEvent(event);
        });
    }

    connectedCallback() {
        this.myId = this.getAttribute('id');
        this.render();
        this.attachEventHandlers();
    }

    disconnectedCallback() {
        //TODO remove event listeners
    }
}

customElements.define('suggestions-list', SuggestionsList);