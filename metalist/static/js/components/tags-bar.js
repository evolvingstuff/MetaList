"use strict";


import {
    EVT_DESELECT_ITEMSUBITEM,
    EVT_SELECT_ITEMSUBITEM,
    EVT_RESELECT_ITEMSUBITEM,
    EVT_TAGS_UPDATED,
    EVT_TAGS_UPDATED_SUGGESTIONS,
    EVT_ESCAPE
} from '../pub-sub-events';

let selectedItem = null;
let selectedItemSubitemId = null;

import { state } from "../app-state";

import { genericRequest } from '../misc/server-proxy';

class TagsBar extends HTMLElement {

    constructor()  {
        super();
        this.myId = null;
    }

    render() {
        let html = `<input class="tags-bar" id="my-tags-input" type="text" placeholder="tags..." disabled spellcheck="false"/>`;
        html += '<button class="editor-button" id="buttonB">B</button>';
        html += '<button class="editor-button" id="buttonI">I</button>';
        html += '<button class="editor-button" id="buttonU">U</button>';
        //html += '<button class="editor-button" id="buttonH">H</button>';
        this.innerHTML = html;
        document.getElementById('my-tags-bar').style.display = 'none';
        document.getElementById('my-tags-bar').addEventListener('mousedown', (evt) => {
            evt.stopPropagation();
            evt.preventDefault();
            document.getElementById('my-tags-input').blur();
            console.log('debug tags-bar blur()');
        });
        document.getElementById('my-tags-bar').addEventListener('click', (evt) => {
            evt.stopPropagation();
            evt.preventDefault();
        });
    }

    attachDOMEventHandlers() {

        this.querySelector('input').onkeydown = (evt) => {
            if (evt.ctrlKey) {
                if (evt.key === 'z') {
                    evt.preventDefault(); //otherwise will update tags
                    this.actionBlur();
                }
                else if (evt.key === 'y') {
                    evt.preventDefault(); //otherwise will update tags
                    this.actionBlur();
                }
            }
        };

        this.querySelector('input').addEventListener('keydown', (evt) => {
            if (evt.key === "Escape") {
                //don't try to handle this
                return;
            }
            evt.stopPropagation();
        });

        this.querySelector('input').addEventListener('input', (evt) => {
            this.actionTagsUpdated();
        });

        this.querySelector('input').addEventListener('mousedown', evt => {
            //override default behavior of body
            evt.stopPropagation();
        });

        this.querySelector('input').addEventListener('focus', () => {
            this.actionFocus();
        });

        this.querySelectorAll('.editor-button').forEach(button => {
            button.addEventListener('mousedown', (evt) => {
                evt.stopPropagation();
                evt.preventDefault();
                document.getElementById('my-tags-input').blur();
                console.log('debug tags-bar blur()');
            });
            button.addEventListener('click', (evt) => {
                evt.stopPropagation();
                evt.preventDefault();
            });
            button.addEventListener('focus', (evt) => {
                evt.stopPropagation();
                evt.preventDefault();
                document.getElementById('my-tags-input').blur();
                console.log('debug tags-bar blur()');
            });
        });

        document.getElementById('buttonB').addEventListener('click', (evt) => {
            if (state.modeEditing) {
                evt.stopPropagation();
                evt.preventDefault();
                this.actionBold();
            }
        });

        document.getElementById('buttonI').addEventListener('click', (evt) => {
            if (state.modeEditing) {
                evt.stopPropagation();
                evt.preventDefault();
                this.actionItalic();
            }
        });

        document.getElementById('buttonU').addEventListener('click', (evt) => {
            if (state.modeEditing) {
                evt.stopPropagation();
                evt.preventDefault();
                this.actionUnderline();
            }
        });

        PubSub.subscribe(EVT_ESCAPE, (msg, data) => {
            this.actionBlur();
        });
    }

    actionBlur() {
        this.querySelector('input').blur();
    }

    actionBold() {
        console.log('press bold');
        document.getElementById('my-tags-input').blur();
        console.log('debug tags-bar blur()');
        document.execCommand('bold', false, null);
    }

    actionItalic() {
        console.log('press italic');
        document.getElementById('my-tags-input').blur();
        console.log('debug tags-bar blur()');
        document.execCommand('italic', false, null);
    }

    actionUnderline() {
        console.log('press underline');
        document.getElementById('my-tags-input').blur();
        console.log('debug tags-bar blur()');
        document.execCommand('underline', false, null);
    }

    subscribeToPubSubEvents() {
        PubSub.subscribe(EVT_DESELECT_ITEMSUBITEM, (msg, data) => {
            this.actionDeselect();
        });

        PubSub.subscribe(EVT_SELECT_ITEMSUBITEM, (msg, data) => {
            this.actionSelectOrReselect(data);
        });

        PubSub.subscribe(EVT_RESELECT_ITEMSUBITEM, (msg, data) => {
            this.actionSelectOrReselect(data);
        });

        PubSub.subscribe(EVT_TAGS_UPDATED_SUGGESTIONS, (msg, data) => {
            this.actionSuggestions();
        });
    }

    actionTagsUpdated() {
        let updatedTags = this.querySelector('input').value;
        console.log(`actionTagsUpdated() updatedTags = ${updatedTags}`);
        //TODO: parse for validity
        state.updatedTags = updatedTags;
        PubSub.publishSync(EVT_TAGS_UPDATED, updatedTags);
    }

    actionDeselect() {
        document.getElementById('my-tags-bar').style.display = 'none';
        document.getElementById('my-tags-input').disabled = true;
        this.querySelector('input').value = '';
        selectedItem = null;
        selectedItemSubitemId = null;
    }

    actionSelectOrReselect(data) {
        if (state.modeMetaChat) {
            return;
        }
        if (selectedItemSubitemId !== data['itemSubitemId']) {
            document.getElementById('my-tags-bar').style.display = 'block';
            document.getElementById('my-tags-input').disabled = false;
            selectedItem = data['item'];
            selectedItemSubitemId = data['itemSubitemId'];
            const subitemIndex = parseInt(selectedItemSubitemId.split(':')[1]);
            this.querySelector('input').value = selectedItem['subitems'][subitemIndex]['tags'];
            document.getElementById('my-tags-suggestions').updateSuggestions([]);
            document.getElementById('my-tags-input').blur();
        }
    }

    actionFocus() {

        //1. if tags are empty, it already shows suggestions, do nothing
        //2. If tags are not empty, we assume the user wants to add a new tag, and
        //   in order for more suggestions to show up, there needs to be a space at the end

        let searchString = this.querySelector('input').value;
        if (searchString.trim().length > 0) {
            this.querySelector('input').value += ' ';
            this.actionTagsUpdated();
        }

        this.actionSuggestions();
    }

    actionSuggestions() {
        if (state.selectedItemSubitemId === null) {
            console.warn('no item selected to suggest tags for. skipping.');
            return;
        }
        genericRequest(null, '/tags-suggestions', state, this.reactionTagsSuggestions);
    }

    reactionTagsSuggestions = (result) => {
        const suggestionsList = document.getElementById('my-tags-suggestions');
        suggestionsList.updateSuggestions(result['tagsSuggestions']);
    }

    connectedCallback() {
        this.render();
        this.attachDOMEventHandlers();
        this.subscribeToPubSubEvents();
    }

    disconnectedCallback() {

    }

}

customElements.define('tags-bar', TagsBar);