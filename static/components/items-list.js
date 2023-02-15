'use strict';

class ItemsList extends HTMLElement {

    constructor() {
        super();
        this.my_id = null;
    }

    applyFormatting(data, tags) {
        //TODO: implement markdown and other formatting functions here
        if (tags.includes('@markdown')) {

        }
        return data;
    }

    applyClasses(tags) {
        let classes = [];
        if (tags.includes('@heading')) {
            classes.push('tag-heading');
        }
        if (tags.includes('@strikethrough')) {
            classes.push('tag-strikethrough');
        }
        if (tags.includes('@bold')) {
            classes.push('tag-bold');
        }
        if (tags.includes('@italic')) {
            classes.push('tag-italic');
        }
        if (tags.includes('@monospace')) {
            classes.push('tag-monospace');
        }
        if (tags.includes('@password')) {
            classes.push('tag-password');
        }
        return classes;
    }

    renderItem(item) {
        let content = `<div class="item" id="${item.id}">`;
        let gridRow = 1;
        let listMode = false;
        for (let subitem of item.subitems) {
            let tags = subitem.tags.split(' ');
            let classes = this.applyClasses(tags);
            let formattedData = this.applyFormatting(subitem.data, tags);
            if (listMode) {
                let column_start = subitem.indent * 2 + 4;  // 1 based and give room for the bullet and expand arrow
                content += `<div class="subitem-lhs1" style="grid-row: ${gridRow}; grid-column-start: ${column_start - 3};"> </div>`;
                content += `<div class="subitem-lhs2" style="grid-row: ${gridRow}; grid-column-start: ${column_start - 2};"> </div>`;
                content += `<div class="subitem-lhs3" style="grid-row: ${gridRow}; grid-column-start: ${column_start - 1};"> </div>`;
                content += `<div class="subitem ${classes.join(' ')}" style="rid-row: ${gridRow}; grid-column-start: ${column_start};">${formattedData}</div>`;
            }
            else {
                let column_start = subitem.indent * 2 + 2;  // 1 based and give room for the bullet and expand arrow
                content += `<div class="subitem-lhs1" style="grid-row: ${gridRow}; grid-column-start: ${column_start - 1};"> </div>`;
                content += `<div class="subitem ${classes.join(' ')}" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${formattedData}</div>`;
            }
            gridRow++;
        }
        content += '</div>';
        return content;
    }

    render(items) {
        let t1 = Date.now();
        if (items === null) {
            this.innerHTML = `<div id="${this.my_id}">Items go here</div>`;
        } else {
            let content = '<div id="${this.my_id}" class="items-list">';
            for (let item of items) {
                content += this.renderItem(item);
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