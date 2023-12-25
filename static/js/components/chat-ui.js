'use strict';

class ChatUi extends HTMLElement {

    constructor() {
        super();
        this.myId = null;
    }

    render(searchString) {
        let html = '<img class="chat-icon" src="../../img/chat-left-svgrepo-com.svg"/>';
        this.innerHTML = html;
    }

    attachEventHandlers() {

        document.getElementById('my-chat-ui').addEventListener('mousedown', (evt) => {
            evt.stopPropagation();
            evt.preventDefault();
            alert("let's chat!");
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

customElements.define('chat-ui', ChatUi);