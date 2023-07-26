class TagsBar extends HTMLElement {

    constructor()  {
        console.log('TagsBar.constructor()');
        super();
        this.myId = null;
    }

    render() {
        let content = `<div class="tags-bar">`;
        content += 'TODO: tags bar';
        content += `</div>`;
        this.innerHTML = content;
    }

    attachEventHandlers() {

    }

    subscribeToEvents() {

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