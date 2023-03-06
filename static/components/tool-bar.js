'use strict';


class ToolBar extends HTMLElement {

    constructor() {
        super();
        this.myId = null;
    }


    render() {
        let content = `<div class="tool-bar">`;
        content += `<button type="button" id="edit" class="activeBtn btnDeactivated">EDIT</button>`;
        content += `<button type="button" id="move" class="activeBtn btnDeactivated">MOVE</button>`;
        content += `<button type="button" id="tags" class="activeBtn btnDeactivated">TAGS</button>`;
        content += `<button type="button" id="format" class="activeBtn btnDeactivated">FORMAT</button>`;
        content += `</div>`;
        this.innerHTML = content;
    }

    attachEventHandlers() {
        //TODO: move these into render function?
        this.querySelector('#edit').addEventListener('click', (event) => {
            //TODO: click event
            if (state.modeEdit) {
                state.modeEdit = false;
                PubSub.publish('exit-mode-edit', {});
            }
            else {
                if (state.selectedItemSubitemIds.size > 1) {
                    alert('You can only edit one item at a time. Please select only one item and try again.');
                    return;
                }
                state.modeEdit = true;  //important to set this BEFORE publishing the event
                PubSub.publish('enter-mode-edit', {});
            }
        });

        this.querySelector('#move').addEventListener('click', (event) => {
            if (state.modeMove) {
                state.modeMove = false;
                PubSub.publish('exit-mode-move', {});
            }
            else {
                state.modeMove = true;
                PubSub.publish('enter-mode-move', {});
            }
        });

        this.querySelector('#tags').addEventListener('click', (event) => {
            if (state.modeTags) {
                state.modeTags = false;
                PubSub.publish('exit-mode-tags', {});
            }
            else {
                state.modeTags = true;
                PubSub.publish('enter-mode-tags', {});
            }
        });

        this.querySelector('#format').addEventListener('click', (event) => {
            if (state.modeFormat) {
                state.modeFormat = false;
                PubSub.publish('exit-mode-format', {});
            }
            else {
                state.modeFormat = true;
                PubSub.publish('enter-mode-format', {});
            }
        });
    }

    subscribeToEvents() {
        PubSub.subscribe('enter-mode-edit', (msg, searchFilter) => {
            this.querySelector('#edit').classList.remove('btnDeactivated');
        });

        PubSub.subscribe('enter-mode-move', (msg, searchFilter) => {
            this.querySelector('#move').classList.remove('btnDeactivated');
        });

        PubSub.subscribe('enter-mode-tags', (msg, searchFilter) => {
            this.querySelector('#tags').classList.remove('btnDeactivated');
        });

        PubSub.subscribe('enter-mode-format', (msg, searchFilter) => {
            this.querySelector('#format').classList.remove('btnDeactivated');
        });

        PubSub.subscribe('exit-mode-edit', (msg, searchFilter) => {
            this.querySelector('#edit').classList.add('btnDeactivated');
        });

        PubSub.subscribe('exit-mode-move', (msg, searchFilter) => {
            this.querySelector('#move').classList.add('btnDeactivated');
        });

        PubSub.subscribe('exit-mode-tags', (msg, searchFilter) => {
            this.querySelector('#tags').classList.add('btnDeactivated');
        });

        PubSub.subscribe('exit-mode-format', (msg, searchFilter) => {
            this.querySelector('#format').classList.add('btnDeactivated');
        });
    }


    connectedCallback() {
        this.myId = this.getAttribute('id');
        this.render();
        this.attachEventHandlers();
        this.subscribeToEvents();
    }

    disconnectedCallback() {
        //TODO remove event listeners
    }

}

customElements.define('tool-bar', ToolBar);