'use strict';

import {state} from "../js/state.js";
import {
    EVT_ENTER_MODE_EDIT,
    EVT_ENTER_MODE_MOVE,
    EVT_ENTER_MODE_TAGS,
    EVT_ENTER_MODE_FORMAT,
    EVT_EXIT_MODE_EDIT,
    EVT_EXIT_MODE_MOVE,
    EVT_EXIT_MODE_TAGS,
    EVT_EXIT_MODE_FORMAT,
    EVT_EXIT_ALL_MODES
} from '../js/events.js';

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
                PubSub.publish(EVT_EXIT_MODE_EDIT, {});
                PubSub.publish(EVT_EXIT_ALL_MODES, {});
            }
            else {
                if (state.selectedItemSubitemIds.size > 1) {
                    alert('You can only edit one item at a time. Please select only one item and try again.');
                    return;
                }
                state.modeEdit = true;  //important to set this BEFORE publishing the event
                PubSub.publish(EVT_ENTER_MODE_EDIT, {});
            }
        });

        this.querySelector('#move').addEventListener('click', (event) => {
            if (state.modeMove) {
                state.modeMove = false;
                PubSub.publish(EVT_EXIT_MODE_MOVE, {});
                PubSub.publish(EVT_EXIT_ALL_MODES, {});
            }
            else {
                state.modeMove = true;
                PubSub.publish(EVT_ENTER_MODE_MOVE, {});
            }
        });

        this.querySelector('#tags').addEventListener('click', (event) => {
            if (state.modeTags) {
                state.modeTags = false;
                PubSub.publish(EVT_EXIT_MODE_TAGS, {});
                PubSub.publish(EVT_EXIT_ALL_MODES, {});
            }
            else {
                state.modeTags = true;
                PubSub.publish(EVT_ENTER_MODE_TAGS, {});
            }
        });

        this.querySelector('#format').addEventListener('click', (event) => {
            if (state.modeFormat) {
                state.modeFormat = false;
                PubSub.publish(EVT_EXIT_MODE_FORMAT, {});
                PubSub.publish(EVT_EXIT_ALL_MODES, {});
            }
            else {
                state.modeFormat = true;
                PubSub.publish(EVT_ENTER_MODE_FORMAT, {});
            }
        });
    }

    subscribeToEvents() {
        PubSub.subscribe(EVT_ENTER_MODE_EDIT, (msg, searchFilter) => {
            this.querySelector('#edit').classList.remove('btnDeactivated');
        });

        PubSub.subscribe(EVT_ENTER_MODE_MOVE, (msg, searchFilter) => {
            this.querySelector('#move').classList.remove('btnDeactivated');
        });

        PubSub.subscribe(EVT_ENTER_MODE_TAGS, (msg, searchFilter) => {
            this.querySelector('#tags').classList.remove('btnDeactivated');
        });

        PubSub.subscribe(EVT_ENTER_MODE_FORMAT, (msg, searchFilter) => {
            this.querySelector('#format').classList.remove('btnDeactivated');
        });

        PubSub.subscribe(EVT_EXIT_MODE_EDIT, (msg, searchFilter) => {
            this.querySelector('#edit').classList.add('btnDeactivated');
        });

        PubSub.subscribe(EVT_EXIT_MODE_MOVE, (msg, searchFilter) => {
            this.querySelector('#move').classList.add('btnDeactivated');
        });

        PubSub.subscribe(EVT_EXIT_MODE_TAGS, (msg, searchFilter) => {
            this.querySelector('#tags').classList.add('btnDeactivated');
        });

        PubSub.subscribe(EVT_EXIT_MODE_FORMAT, (msg, searchFilter) => {
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