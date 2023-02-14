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
            //TODO move css to separate file
            let content = '<div id="${this.my_id}" class="items-list">';
            for (let item of items) {
                content += `<div class="item" id="${item.id}">`;
                let grid_row = 1;
                for (let subitem of item.subitems) {
                    let column_start = subitem.indent + 1;  // +1 because grid-column-start is 1-indexed
                    content += `<div class="subitem" style="grid-row: ${grid_row}; grid-column-start: ${column_start};">${subitem.data}</div>`;
                    grid_row++;
                }
                content += '</div>';
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