import {
    EVT_DESELECT_ITEMSUBITEM,
    EVT_SELECT_ITEMSUBITEM,
    EVT_RESELECT_ITEMSUBITEM,
    EVT_TAGS_UPDATED
} from "../pub-sub-events.js";

let selectedItem = null;
let selectedItemSubitemId = null;

import {
    state
} from "../app-state.js";

import {
    genericRequestV3
} from '../misc/server-proxy.js';

class TagsBar extends HTMLElement {

    constructor()  {
        console.log('TagsBar.constructor()');
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
        });
        document.getElementById('my-tags-bar').addEventListener('click', (evt) => {
            evt.stopPropagation();
            evt.preventDefault();
        });
    }

    attachDOMEventHandlers() {
        //this.intervalID = setInterval(this.checkForUpdatedSearch.bind(this), this.INTERVAL);

        this.querySelector('input').onkeydown = (evt) => {
            if (evt.ctrlKey) {
                if (evt.key === 'z') {
                    evt.preventDefault(); //otherwise will update tags
                    this.querySelector('input').blur();
                }
                else if (evt.key === 'y') {
                    evt.preventDefault(); //otherwise will update tags
                    this.querySelector('input').blur();
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
            //PubSub.publishSync(EVT_SEARCH_FOCUS, {});
            this.actionFocus();
        });

        this.querySelectorAll('.editor-button').forEach(button => {
            button.addEventListener('mousedown', (evt) => {
                evt.stopPropagation();
                evt.preventDefault();
                document.getElementById('my-tags-input').blur();
            });
            button.addEventListener('click', (evt) => {
                evt.stopPropagation();
                evt.preventDefault();
            });
            button.addEventListener('focus', (evt) => {
                evt.stopPropagation();
                evt.preventDefault();
                document.getElementById('my-tags-input').blur();
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
    }

    actionBold() {
        console.log('press bold');
        document.getElementById('my-tags-input').blur();
        document.execCommand('bold', false, null);
    }

    actionItalic() {
        console.log('press italic');
        document.getElementById('my-tags-input').blur();
        document.execCommand('italic', false, null);
    }

    actionUnderline() {
        console.log('press underline');
        document.getElementById('my-tags-input').blur();
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
    }

    actionTagsUpdated() {
        let updatedTags = this.querySelector('input').value;
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
        if (selectedItemSubitemId !== data['itemSubitemId']) {
            //TODO: this loses the event handlers on the input
            // let myInput = document.getElementById('my-tags-input');
            // this.resetInput(myInput);
            document.getElementById('my-tags-bar').style.display = 'block';
            document.getElementById('my-tags-input').disabled = false;
            selectedItem = data['item'];
            selectedItemSubitemId = data['itemSubitemId'];
            const subitemIndex = parseInt(selectedItemSubitemId.split(':')[1]);
            this.querySelector('input').value = selectedItem['subitems'][subitemIndex]['tags'];
            document.getElementById('my-tags-input').blur();
        }
    }

    actionFocus() {
        this.actionSuggestions();
    }

    actionSuggestions() {
        console.log('actionSuggestions() TODO...');
        genericRequestV3(null, '/tags-suggestions', this.reactionTagsSuggestions);
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