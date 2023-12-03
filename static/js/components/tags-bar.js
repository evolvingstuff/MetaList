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
        });

        this.querySelectorAll('.editor-button').forEach(button => {
            button.addEventListener('mousedown', (evt) => {
                evt.stopPropagation();
                evt.preventDefault();
            });
            button.addEventListener('click', (evt) => {
                evt.stopPropagation();
                evt.preventDefault();
            });
            button.addEventListener('focus', (evt) => {
                evt.stopPropagation();
                evt.preventDefault();
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

        // document.getElementById('buttonH').addEventListener('click', (evt) => {
        //     if (state.modeEditing) {
        //         evt.stopPropagation();
        //         evt.preventDefault();
        //         this.actionHeader();
        //     }
        // });
    }

    actionBold() {
        document.execCommand('bold', false, null);
    }

    actionItalic() {
        document.execCommand('italic', false, null);
    }

    actionUnderline() {
        document.execCommand('underline', false, null);
    }

    actionHeader() {
        document.execCommand('formatBlock', false, 'h3');
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
            document.getElementById('my-tags-bar').style.display = 'block';
            document.getElementById('my-tags-input').disabled = false;
            selectedItem = data['item'];
            selectedItemSubitemId = data['itemSubitemId'];
            const subitemIndex = parseInt(selectedItemSubitemId.split(':')[1]);
            console.log(selectedItem);
            this.querySelector('input').value = selectedItem['subitems'][subitemIndex]['tags'];
        }
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