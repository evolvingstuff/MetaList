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
        content += `</div>`;
        this.innerHTML = content;
    }

    attachEventHandlers() {
        //TODO: move these into render function?
        this.querySelector('#edit').addEventListener('click', (event) => {
            if (state.modeEdit) {
                state.modeEdit = false;
                PubSub.publish('exit-mode-edit', {});
            }
            else {
                if (state.selectedItemSubitemIds.size > 1) {
                    alert('You can only edit one item at a time. Please select only one item and try again.');
                    return;
                }
                state.modeEdit = true;
                PubSub.publish('enter-mode-edit', {});
                if (state.modeMove) {
                    state.modeMove = false;
                    PubSub.publish('exit-mode-move', {});
                }
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
                if (state.modeEdit) {
                    state.modeEdit = false;
                    PubSub.publish('exit-mode-edit', {});
                }
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

        PubSub.subscribe('exit-mode-edit', (msg, searchFilter) => {
            this.querySelector('#edit').classList.add('btnDeactivated');
        });

        PubSub.subscribe('exit-mode-move', (msg, searchFilter) => {
            this.querySelector('#move').classList.add('btnDeactivated');
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