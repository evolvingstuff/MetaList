'use strict';

class ItemsList extends HTMLElement {

    constructor() {
        super();
        this.myId = null;
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
        //TODO this part of the code is a bit gnarly and should be refactored
        let content = `<div class="item" id="${item.id}">`;
        let gridRow = 1;
        let listMode = false;
        let subitem_index = 0;
        for (let subitem of item.subitems) {
            let itemSubitemId = `${item.id}:${subitem_index}`;
            let tags = subitem.tags.split(' ');
            let classes = this.applyClasses(tags);
            let formattedData = this.applyFormatting(subitem.data, tags);
            let offsetPerIndent = 2;  // 2
            let downArrow = `<img src="../img/caret-down-filled.svg" class="arrow" />`;
            let todo = `<img src="../img/checkbox-unchecked.svg" class="todo" />`;
            let done = `<img src="../img/checkbox-checked.svg" class="todo" />`;

            if (listMode) {
                let column_start = subitem.indent * offsetPerIndent + 4;  // 1 based and give room for the bullet and expand arrow
                content += `<div class="subitem-lhs1" style="grid-row: ${gridRow}; grid-column-start: ${column_start - 3};">${downArrow}</div>`;
                content += `<div class="subitem-lhs2" style="grid-row: ${gridRow}; grid-column-start: ${column_start - 2};"> </div>`;
                content += `<div class="subitem-lhs3" style="grid-row: ${gridRow}; grid-column-start: ${column_start - 1};"> </div>`;
                content += `<div class="subitem ${classes.join(' ')}" style="rid-row: ${gridRow}; grid-column-start: ${column_start};">${formattedData}</div>`;
            }
            else {
                let column_start = subitem.indent * offsetPerIndent + 1;  // 1 based and give room for the bullet and expand arrow

                //optionally render the expand/collapse arrow
                if (subitem_index < item.subitems.length - 1 && item.subitems[subitem_index+1].indent > subitem.indent) {
                    content += `<div data-id="${itemSubitemId}" class="subitem-lhs1 expand-collapse" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${downArrow}</div>`;
                    column_start += 1
                }
                else {
                    content += `<div data-id="${itemSubitemId}" class="subitem-lhs1 expand-collapse" style="grid-row: ${gridRow}; grid-column-start: ${column_start};"> </div>`;
                    column_start += 1
                }

                //optionally render the todo/done icons
                if (tags.includes('@todo')) {
                    content += `<div data-id="${itemSubitemId}" class="subitem-lhs2 tag-todo" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${todo}</div>`;
                    column_start += 1
                }
                else if (tags.includes('@done')) {
                    content += `<div data-id="${itemSubitemId}" class="subitem-lhs2 tag-done" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${done}</div>`;
                    column_start += 1
                }

                //render the formatted subitem data
                content += `<div data-id="${itemSubitemId}" class="subitem ${classes.join(' ')}" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${formattedData}</div>`;
            }
            gridRow++;
            subitem_index++;
        }
        content += '</div>';
        return content;
    }

    render(items) {
        let t1 = Date.now();
        if (items === null) {
            this.innerHTML = `<div>Items go here</div>`;
        } else {
            let content = '<div class="items-list">';
            for (let item of items) {
                content += this.renderItem(item);
            }
            content += '</div>';
            this.innerHTML = content;
        }
        let t2 = Date.now();
        console.log('rendered items-list in ' + (t2 - t1) + 'ms');
        //TODO add functionality to the event listeners
        if (items !== null) {
            this.querySelectorAll('.tag-todo').forEach(el => el.addEventListener('click', (e) => {
                let itemSubitemId = e.currentTarget.getAttribute('data-id');
                //alert(`todo clicked for ${itemSubitemId}`);
            }));
            this.querySelectorAll('.tag-done').forEach(el => el.addEventListener('click', (e) => {
                let itemSubitemId = e.currentTarget.getAttribute('data-id');
                //alert(`done clicked for ${itemSubitemId}`);
            }));
            this.querySelectorAll('.expand-collapse').forEach(el => el.addEventListener('click', (e) => {
                let itemSubitemId = e.currentTarget.getAttribute('data-id');
                //alert(`expand/collapse clicked for ${itemSubitemId}`);
            }));
        }
    }

    connectedCallback() {
        this.myId = this.getAttribute('id');
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