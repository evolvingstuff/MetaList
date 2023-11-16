import {
    EVT_DESELECT_ITEMSUBITEM,
    EVT_SELECT_ITEMSUBITEM,
    EVT_RESELECT_ITEMSUBITEM
} from './items-list.js';

class TagsBar extends HTMLElement {

    constructor()  {
        console.log('TagsBar.constructor()');
        super();
        this.myId = null;
    }

    render() {
        this.innerHTML = `<input class="tags-bar" id="my-tags-input" type="text" placeholder="" disabled spellcheck="false" size="64"/>`;
    }

    attachDOMEventHandlers() {
        //this.intervalID = setInterval(this.checkForUpdatedSearch.bind(this), this.INTERVAL);

        this.querySelector('input').addEventListener('input', () => {
            //this.onTyping();
        });

        this.querySelector('input').addEventListener('mousedown', evt => {
            //override default behavior of body
            evt.stopPropagation();
        });

        this.querySelector('input').addEventListener('focus', () => {
            //PubSub.publish(EVT_SEARCH_FOCUS, {});
        });
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

    actionDeselect() {
        document.getElementById('my-tags-input').disabled = true;
        this.querySelector('input').value = '';
    }

    actionSelectOrReselect(data) {
        document.getElementById('my-tags-input').disabled = false;
        let item = data['item'];
        let subitemIndex = parseInt(data['itemSubitemId'].split(':')[1]);
        this.querySelector('input').value = item['subitems'][subitemIndex]['tags'];
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