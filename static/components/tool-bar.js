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


    connectedCallback() {
        this.myId = this.getAttribute('id');

        this.render();

        //TODO: move these into render function?
        this.querySelector('#edit').addEventListener('click', (event) => {
            if (state.modeEdit) {
                PubSub.publish('exit-mode-edit', {});
            }
            else {
                if (state.selectedItemSubitemIds.size > 1) {
                    alert('You can only edit one item at a time. Please select only one item and try again.');
                    return;
                }
                PubSub.publish('enter-mode-edit', {});
            }
        });

        this.querySelector('#move').addEventListener('click', (event) => {
            if (state.modeMove) {
                PubSub.publish('exit-mode-move', {});
            }
            else {
                PubSub.publish('enter-mode-move', {});
            }
        });

        PubSub.subscribe('enter-mode-edit', (msg, searchFilter) => {
            state.modeEdit = true;
            state.modeMove = false;
            this.querySelector('#edit').classList.remove('btnDeactivated');
            this.querySelector('#move').classList.add('btnDeactivated');
        });

        PubSub.subscribe('exit-mode-edit', (msg, searchFilter) => {
            state.modeEdit = false;
            this.querySelector('#edit').classList.add('btnDeactivated');
        });

        PubSub.subscribe('enter-mode-move', (msg, searchFilter) => {
            state.modeEdit = false;
            state.modeMove = true;
            this.querySelector('#move').classList.remove('btnDeactivated');
            this.querySelector('#edit').classList.add('btnDeactivated');
        });

        PubSub.subscribe('exit-mode-move', (msg, searchFilter) => {
            state.modeMove = false;
            this.querySelector('#move').classList.add('btnDeactivated');
        });
    }

    disconnectedCallback() {
        //TODO remove event listeners
    }

}

customElements.define('tool-bar', ToolBar);