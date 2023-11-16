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
        this.innerHTML = `<input class="tags-bar" id="my-tags-input" type="text" placeholder="" spellcheck="false" size="64"/>`;
        document.getElementById('my-tags-input').disabled = true;

    }

    attachEventHandlers() {
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

    subscribeToEvents() {
        PubSub.subscribe(EVT_DESELECT_ITEMSUBITEM, (msg, data) => {
            this.querySelector('input').value = '';
            document.getElementById('my-tags-input').disabled = true;
        });

        PubSub.subscribe(EVT_SELECT_ITEMSUBITEM, (msg, data) => {
            document.getElementById('my-tags-input').disabled = false;
            let item = data['item'];
            let subitemIndex = parseInt(data['itemSubitemId'].split(':')[1]);
            this.querySelector('input').value = item['subitems'][subitemIndex]['tags'];
        });

        PubSub.subscribe(EVT_RESELECT_ITEMSUBITEM, (msg, data) => {
            document.getElementById('my-tags-input').disabled = false;
            let item = data['item'];
            let subitemIndex = parseInt(data['itemSubitemId'].split(':')[1]);
            this.querySelector('input').value = item['subitems'][subitemIndex]['tags'];
        });
    }

    connectedCallback() {
        this.render();
        this.attachEventHandlers();
        this.subscribeToEvents();
    }

    disconnectedCallback() {

    }

}

customElements.define('tags-bar', TagsBar);