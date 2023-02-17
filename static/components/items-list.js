'use strict';

const numberedListChar = '.';  //TODO: make this configurable

class ItemsList extends HTMLElement {

    constructor() {
        super();
        this.myId = null;
    }


    applyFormatting(html, tags) {
        if (tags.includes('@markdown')) {
            return $parseMarkdown.getFormat(html);
        }
        if (tags.includes('@json')) {
            return $parseJson.getFormat(html);
        }
        return html;
    }

    applyClasses(tags) {
        //TODO: we may want to do this on the server instead
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
        if (tags.includes('@green')) {
            classes.push('tag-green');
        }
        if (tags.includes('@red')) {
            classes.push('tag-red');
        }
        if (tags.includes('@blue')) {
            classes.push('tag-blue');
        }
        if (tags.includes('@grey')) {
            classes.push('tag-grey');
        }
        return classes;
    }

    renderItem(item) {
        //TODO this part of the code is a bit gnarly and should be refactored
        let content = `<div class="item" id="${item.id}">`;
        let gridRow = 1;
        let subitemIndex = 0;
        let collapseMode = false;
        let collapseIndent = -1;

        let offsetPerIndent = 2;  // 2
        let downArrow = `<img src="../img/caret-down-filled.svg" class="arrow" />`;
        let rightArrow = `<img src="../img/caret-right-filled.svg" class="arrow" />`;
        let bullet = '&#x2022';
        let todo = `<img src="../img/checkbox-unchecked.svg" class="todo" />`;
        let done = `<img src="../img/checkbox-checked.svg" class="todo" />`;

        //TODO: list_parents should be defined here
        let atLeastOneParentIsAList = false;

        for (let subitem of item.subitems) {

            if (collapseMode) {
                if (subitem.indent <= collapseIndent) {
                    collapseMode = false;
                    collapseIndent = -1;
                }
                else {
                    subitemIndex += 1;
                    continue;
                }
            }

            if (subitem.collapse !== undefined) {
                if (subitem.collapse) {
                    collapseMode = true;
                    collapseIndent = subitem.indent;
                }
                else {
                    collapseMode = false;
                    collapseIndent = -1;
                }
            }

            let itemSubitemId = `${item.id}:${subitemIndex}`;
            let tags = subitem['_tags']
            let classes = this.applyClasses(tags);
            if (subitem['_match'] === undefined) {
                classes.push('redacted');
            }

            if (tags.includes('@list-bulleted') || tags.includes('@list-numbered')) {
                atLeastOneParentIsAList = true;
            }

            let formattedData = this.applyFormatting(subitem.data, tags);
            let column_start = subitem.indent * offsetPerIndent + 1;  // 1 based and give room for the bullet and expand arrow

            if (subitem._match === undefined) {
                //TODO this may eventually depend on redaction mode
                column_start += 1;
                content += `<div data-id="${itemSubitemId}" class="subitem subitem-redacted" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">&nbsp;</div>`;
            }
            else {
                //optionally render the expand/collapse arrow
                if (subitemIndex < item.subitems.length - 1 &&
                    item.subitems[subitemIndex + 1].indent > subitem.indent) {
                    if (collapseMode) {
                        content += `<div data-id="${itemSubitemId}" class="subitem-outline-slot collapsed" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${rightArrow}</div>`;
                    } else {
                        content += `<div data-id="${itemSubitemId}" class="subitem-outline-slot expanded" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${downArrow}</div>`;
                    }
                    column_start += 1
                } else {
                    content += `<div data-id="${itemSubitemId}" class="subitem-outline-slot" style="grid-row: ${gridRow}; grid-column-start: ${column_start};"> </div>`;
                    column_start += 1
                }

                //optionally render the todo/done icons
                if (tags.includes('@todo')) {
                    content += `<div data-id="${itemSubitemId}" class="subitem-todo-or-done-slot tag-todo" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${todo}</div>`;
                    column_start += 1
                } else if (tags.includes('@done')) {
                    content += `<div data-id="${itemSubitemId}" class="subitem-todo-or-done-slot tag-done" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${done}</div>`;
                    column_start += 1
                }

                //optionally handle list rendering
                if (subitem['_@list-bulleted'] !== undefined) {
                    content += `<div data-id="${itemSubitemId}" class="subitem-list-bulleted-slot" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${bullet}</div>`;
                    column_start += 1
                } else if (subitem['_@list-numbered'] !== undefined) {
                    let rank = subitem['_@list-numbered']
                    content += `<div data-id="${itemSubitemId}" class="subitem-list-numbered-slot" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${rank}${numberedListChar}</div>`;
                    column_start += 1
                }

                //render the formatted subitem data
                content += `<div data-id="${itemSubitemId}" class="subitem ${classes.join(' ')}" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${formattedData}</div>`;
            }
            gridRow++;
            subitemIndex++;
        }
        content += '</div>';
        return content;
    }


    renderItems(items, totalResults) {
        let t1 = Date.now();
        let content = '<div class="items-list">';
        for (let item of items) {
            content += this.renderItem(item);
        }
        if (state.modeShowMoreResults === false && items.length < totalResults) {
            let more = totalResults - items.length;
            content += `<div><button type="button" id="show-more-results">Show ${more} more results</button></div>`;
        }
        content += '</div>';
        this.innerHTML = content;
        let t2 = Date.now();
        console.log(`rendered ${items.length} items in ${(t2 - t1)}ms`);

        t1 = Date.now();
        //TODO add functionality to the event listeners
        this.querySelectorAll('.tag-todo').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            alert(`todo clicked for ${itemSubitemId}`);
        }));

        this.querySelectorAll('.tag-done').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            alert(`done clicked for ${itemSubitemId}`);
        }));

        this.querySelectorAll('.expanded').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            PubSub.publish( 'items-list.toggle-outline', {
                itemSubitemId: itemSubitemId
            });
        }));

        this.querySelectorAll('.collapsed').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            PubSub.publish( 'items-list.toggle-outline', {
                itemSubitemId: itemSubitemId
            });
        }));

        this.querySelectorAll('.subitem').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            alert(`content clicked for ${itemSubitemId}`);
        }));

        if (state.modeShowMoreResults === false) {
            let el = this.querySelector('#show-more-results')
            if (el) {
                el.addEventListener('click', (e) => {
                    state.modeShowMoreResults = true;
                    el.disabled = true;
                    el.innerHTML = 'Loading...'; //TODO this should be a spinner
                    PubSub.publish('items-list.show-more-results', state.mostRecentQuery);
                });
            }
        }

        t2 = Date.now();
        console.log(`added events for ${items.length} items in ${(t2 - t1)}ms`);
    }

    connectedCallback() {
        this.myId = this.getAttribute('id');

        PubSub.subscribe('search.results', (msg, searchResults) => {
            let totalResults = searchResults['total_results']
            let items = searchResults.items;
            this.renderItems(items, totalResults);
        });

        PubSub.subscribe('toggle-outline.result', (msg, data) => {
            console.log(data);
            alert('items-list received toggle-outline.result');
        });

        this.renderItems([], 0);
    }

    disconnectedCallback() {
        //TODO remove event listeners
    }

}

customElements.define('items-list', ItemsList);