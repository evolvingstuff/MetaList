"use strict";


class ItemsList extends HTMLElement {

  constructor() {
    super();
    this.my_id = null;
  }

  render(items) {
      let t1 = Date.now();
      if (items === null) {
          this.innerHTML = `<div id="${this.my_id}">Items go here</div>`;
      }
      else {
            let content = '<div id="${this.my_id}">';
            for (let item of items) {
                for (let subitem of item.subitems) {
                    let margin_left = subitem.indent * 20;
                    content += `<div style="margin-left: ${margin_left};">${subitem.data}</div>`;
                }
                content += '<hr>';
            }
            content += '</div>';
          this.innerHTML = content;
      }
        let t2 = Date.now();
        console.log('rendered items-list in ' + (t2 - t1) + 'ms');
  }

  connectedCallback() {
    this.my_id = this.getAttribute('id');
    PubSub.subscribe('search.results', (msg, items) => {
        this.render(items);
    });
    this.render(null);
  }

    disconnectedCallback() {
        //TODO remove event listeners
    }

}

customElements.define('items-list', ItemsList);