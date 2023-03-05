'use strict';

const numberedListChar = '.';  //TODO: make this configurable
const scrollToTopOnNewResults = true;

class ItemsList extends HTMLElement {

    constructor() {
        super();
        this.myId = null;
    }

    renderItems(items, totalResults) {
        console.log(`rendering ${items.length} items`);
        let t1 = Date.now();
        let content = '<div class="items-list">';
        for (let item of items) {
            content += itemFormatter(item);
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
        this.addEventHandlersToItems(this);
        //TODO: maybe move this into the AddEventHandlersToItems function?
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
        if (scrollToTopOnNewResults) {
            window.scrollTo(0, 0);
        }
    }

    addEventHandlersToItems(elItems) {
        elItems.querySelectorAll('.tag-todo').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            PubSub.publish( 'items-list.toggle-todo', {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.tag-done').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            PubSub.publish( 'items-list.toggle-todo', {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.expand').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            PubSub.publish( 'items-list.toggle-outline', {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.collapse').forEach(el => el.addEventListener('click', (e) => {
            let itemSubitemId = e.currentTarget.getAttribute('data-id');
            PubSub.publish( 'items-list.toggle-outline', {
                itemSubitemId: itemSubitemId
            });
        }));

        elItems.querySelectorAll('.subitem').forEach(el => el.addEventListener('click', (e) => {

            console.log('TODO: reload this item from server (could span multiple items)')

            if (el.classList.contains("subitem-redacted")) {
                alert('Cannot select a redacted subitem.');  //TODO set redact display mode in the future
                return;
            }

            let itemSubitemId = e.currentTarget.getAttribute('data-id');

            // PubSub.publish( 'items-list.select-subitem', {
            //     itemSubitemId: itemSubitemId,
            //     ctrlKey: e.ctrlKey
            // });

            //TODO 2023.03.05: turn this into a publish event and rerender the item/s that changed

            if (state.modeEdit && state.selectedItemSubitemIds.size > 0 && state.selectedItemSubitemIds.has(itemSubitemId)) {
                // edit mode is on, not re-selecting subitem
                return;
            }

            //TODO additional logic here for other modes
            if (e.ctrlKey && state.modeEdit === false) {
                if (state.selectedItemSubitemIds.has(itemSubitemId)) {
                    state.selectedItemSubitemIds.delete(itemSubitemId);
                }
                else {
                    state.selectedItemSubitemIds.add(itemSubitemId);
                }
            }
            else {
                if (state.selectedItemSubitemIds.size == 1 &&
                    state.selectedItemSubitemIds.has(itemSubitemId) &&
                    state.modeEdit === false) {

                    state.selectedItemSubitemIds.clear();
                }
                else {
                    state.selectedItemSubitemIds.clear();
                    state.selectedItemSubitemIds.add(itemSubitemId);
                }
            }
            this.addHighlightToSelectedSubitems();

            //TODO 2023.03.05: maybe here add special subitem rendering rules for affected items
        }));
    }

    onPasteSubitemContentEditable(e) {
        e.preventDefault();
        let text = e.clipboardData.getData("text/plain");
        //get the html from the clipboard
        let html = e.clipboardData.getData("text/html");
        //html = '<span>(pasted)</span>' + html;
        console.log('pasting html: ' + html);
        //TODO 2023.03.05: this is where my clean up parsing code should go
        document.execCommand("insertHTML", false, html);
    }

    onInputSubitemContentEditable(e) {
        let itemSubitemId = e.currentTarget.getAttribute('data-id');
        let newHtml = e.currentTarget.innerHTML;
        let newText = e.currentTarget.innerText;
        //console.log('---------------------------------');
        //console.log(`${itemSubitemId}: ${newHtml}`);
        console.log(`${itemSubitemId}: ${newText}`);
        PubSub.publish( 'items-list.edit-subitem', {
            itemSubitemId: itemSubitemId,
            updatedContent: newHtml
        });
    }

    addHighlightToSelectedSubitems() {

        // //remove existing highlights
        // for (let el of document.querySelectorAll('.subitem-selected')) {
        //     el.classList.remove('subitem-selected');
        // }
        // for (let el of document.querySelectorAll('.subitem-action')) {
        //     el.classList.remove('subitem-action');
        //     el.removeAttribute('contenteditable');
        // }

        let els = Array.from(document.querySelectorAll('.subitem-selected'));
        els.forEach(el => el.classList.remove('subitem-selected'));
        els.forEach(el => el.removeAttribute('contenteditable'));

        els = Array.from(document.querySelectorAll('.subitem-action'));
        els.forEach(el => el.classList.remove('subitem-action'));
        els.forEach(el => el.removeAttribute('contenteditable'));

        //add new highlights
        if (state.selectedItemSubitemIds.size > 0) {
            for (let id of state.selectedItemSubitemIds) {
                let el = document.querySelector(`.subitem[data-id="${id}"]`);
                if (el !== null) {
                    if (state.modeEdit || state.modeMove || state.modeTags || state.modeFormat) {
                        el.classList.add('subitem-action');
                        if (state.modeEdit) {
                            el.setAttribute('contenteditable', 'true');
                            el.addEventListener('paste', this.onPasteSubitemContentEditable);
                            el.addEventListener('input', this.onInputSubitemContentEditable);
                        }
                    }
                    else {
                        el.classList.add('subitem-selected');
                    }
                }
            }
        }
    }

    filterSelectedSubitems(item) {
        let subitemIndex = 0;
        let collapseMode = false;
        let collapseIndent = 0;
        for (let subitem of item['subitems']) {
            let id = `${item.id}:${subitemIndex}`;
            let isNotCollapsed = false;
            if (collapseMode) {
                if (subitem['indent'] <= collapseIndent) {
                    collapseMode = false;
                    collapseIndent = 0;
                    isNotCollapsed = true;
                    if (subitem['collapse'] !== undefined) {
                        collapseMode = true;
                        collapseIndent = subitem['indent'];
                    }
                }
            }
            else {
                isNotCollapsed = true;
                if (subitem['collapse'] !== undefined) {
                    collapseMode = true;
                    collapseIndent = subitem['indent'];
                }
            }
            let doRemove = false;
            //TODO: this could be more compact
            if (subitem['_match'] === undefined) {
                if (state.selectedItemSubitemIds.has(id)) {
                    console.log(`removing ${id} from selected because no _match`);
                    doRemove = true;
                }
            }
            else if (!isNotCollapsed) {
                if (state.selectedItemSubitemIds.has(id)) {
                    console.log(`removing ${id} from selected because collapsed`);
                    doRemove = true;
                }
            }
            if (doRemove) {
                state.selectedItemSubitemIds.delete(id);
            }
            subitemIndex++;
        }
        if (state.selectedItemSubitemIds.size > 0) {
            console.log('current selections:');
            console.log(state.selectedItemSubitemIds);
        }
        else {
            console.log('no selections');
        }
    }

    subscribeToPubSubEvents() {

        PubSub.subscribe('selected-subitems-cleared', (msg, data) => {
            console.log('x removing subitem-selected/action class');
            let els = Array.from(document.querySelectorAll('.subitem-selected'));
            els.forEach(el => el.classList.remove('subitem-selected'));
            els.forEach(el => el.removeAttribute('contenteditable'));
            
            els = Array.from(document.querySelectorAll('.subitem-action'));
            els.forEach(el => el.classList.remove('subitem-action'));
            els.forEach(el => el.removeAttribute('contenteditable'));
        });

        PubSub.subscribe('search.results', (msg, searchResults) => {
            let totalResults = searchResults['total_results']
            let items = searchResults.items;
            this.renderItems(items, totalResults);
        });

        PubSub.subscribe('enter-mode-edit', (msg, data) => {
            this.addHighlightToSelectedSubitems();
        });

        PubSub.subscribe('exit-mode-edit', (msg, data) => {
            this.addHighlightToSelectedSubitems();
        });

        PubSub.subscribe('enter-mode-move', (msg, data) => {
            this.addHighlightToSelectedSubitems();
        });

        PubSub.subscribe('exit-mode-move', (msg, data) => {
            this.addHighlightToSelectedSubitems();
        });

        PubSub.subscribe('enter-mode-tags', (msg, data) => {
            this.addHighlightToSelectedSubitems();
        });

        PubSub.subscribe('exit-mode-tags', (msg, data) => {
            this.addHighlightToSelectedSubitems();
        });

        PubSub.subscribe('enter-mode-format', (msg, data) => {
            this.addHighlightToSelectedSubitems();
        });

        PubSub.subscribe('exit-mode-format', (msg, data) => {
            this.addHighlightToSelectedSubitems();
        });

        PubSub.subscribe('toggle-outline.result', (msg, data) => {
            this.replaceItemsInDom(data.updated_items);
        });

        PubSub.subscribe('toggle-todo.result', (msg, data) => {
            let at_least_one_match = false;
            for (let item of data.updated_items) {
                for (let subitem of item.subitems) {
                    if (subitem['_match'] !== undefined) {
                        at_least_one_match = true;
                        break;
                    }
                }
            }
            if (at_least_one_match) {
                this.replaceItemsInDom(data.updated_items);
            }
            else {
                this.removeItemsFromDom(data.updated_items);
                //TODO: so we need to update our selections as well?
                //TODO: what if selections are redacted?
            }
        });
    }


    connectedCallback() {
        this.myId = this.getAttribute('id');
        this.renderItems([], 0);
        this.subscribeToPubSubEvents();
    }

    disconnectedCallback() {
        //TODO remove event listeners
    }

    replaceItemsInDom(items) {
        console.log('replaceItemsInDom()')
        for (let item of items) {
            let currentNode = document.querySelector(`[id="${item.id}"]`);
            let newNode = document.createElement('div');
            newNode.innerHTML = itemFormatter(item);
            currentNode.replaceWith(newNode);
            this.addEventHandlersToItems(newNode);
            this.filterSelectedSubitems(item);
            this.addHighlightToSelectedSubitems();
            //TODO: if the item has no matched subitems, remove the item from the DOM completely
        }
    }

    removeItemsFromDom(items) {
        //TODO: move much of this logic into app.js
        for (let item of items) {
            //clean up selections
            let subitemIndex = 0;
            let atLeastOneRemoved = false;
            for (let subitem of item['subitems']) {
                let id = `${item.id}:${subitemIndex}`;
                if (state.selectedItemSubitemIds.has(id)) {
                    console.log(
                        `removing ${id} from selected because entire item has been removed`);
                    state.selectedItemSubitemIds.delete(id);
                    atLeastOneRemoved = true;
                }
                subitemIndex++;
            }

            let currentNode = document.querySelector(`[id="${item.id}"]`);
            currentNode.remove();
        }
    }

}

customElements.define('items-list', ItemsList);