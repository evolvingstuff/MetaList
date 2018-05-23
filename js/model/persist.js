"use strict";
let $persist = (function () {
    let SAVE_TO_LOCALSTORAGE = true;
    let SAVE_TO_DATABASE = true;
    let LOAD_FROM_LOCALSTORAGE = true;
    let LOAD_FROM_DATABASE = false;
    let lastLoad = Date.now();

    function injectDocs() {
        
    }

    function maybeReload(items) {
        let prev_txt = localStorage.getItem('items');
        let txt = JSON.stringify(items);
        let lastSave = localStorage.getItem('lastSave');
        if (lastSave != null && parseInt(lastSave) > lastLoad && txt != prev_txt) {
            console.log('RELOAD!');
            return true;
        }
        else {
            return false;
        }
    }

    function cleanItem(item) {
        if (item._dirty_tags != null || item._dirty_tags != undefined) {
            delete item._dirty_tags;
        }
        if (item._last_update != null || item._last_update != undefined) {
            delete item._last_update;
        }
        if (item.prev != null || item.prev != undefined) {
            delete item.prev;
        }
        if (item.next != null || item.next != undefined) {
            delete item.next;
        }
        /*
        if (item._tags != null || item._tags != undefined) {
            delete item._tags;
        }
        */
        for (let subitem of item.subitems) {
            cleanItem(subitem);
        }
    }

    function cleanItems(items) {
        let start = Date.now();
        for (let item of items) {
            cleanItem(item);
        }
        let end = Date.now();
        console.log('cleaning took ' + (end-start) + 'ms');
    }

    function save(items) {
        lastLoad = Date.now();
        localStorage.setItem('lastSave', Date.now() + '');
        if (SAVE_TO_LOCALSTORAGE) {
            cleanItems(items);
            localStorage.setItem('items', JSON.stringify(items));
            console.log('$persist.save(items)');
            console.log(items[0]);
        }
        if (SAVE_TO_DATABASE) {
            $db.maybePushTo(items);
        }
    }

    function load() {
        lastLoad = Date.now();
        let items = null;
        if (LOAD_FROM_LOCALSTORAGE) {
            let txt = localStorage.getItem('items');
            if (txt != null && txt != '' && txt != '[]') {
                console.log('Loading from localStorage.');
                items = JSON.parse(txt);
            }
            else {
                console.log('No localStorage data found. Initializing fresh documentation.');
                items = docs;
                let text = 'welcome -@meta';
                $('.action-edit-search').val(text);
                localStorage.setItem('search', text);
                save(items);
            }
        }
        if (LOAD_FROM_DATABASE) {
            alert("loading from database not implemented!");
            return false;
        }
        return items;
    }

    function saveToFileSystem(items) {
        function fileSave(data, filename) {
            if (!data) {
                console.error('fileSave: No data');
                return;
            }
            if (!filename)
                filename = 'backup.json'; //asdf
            if (typeof data === "object") {
                data = JSON.stringify(data, undefined, 4);
            }
            let blob = new Blob([data], { type: 'text/json' }), e = document.createEvent('MouseEvents'), a = document.createElement('a');
            a.download = filename;
            a.href = window.URL.createObjectURL(blob);
            a.dataset.downloadurl = ['text/json', a.download, a.href].join(':');
            e.initMouseEvent('click', true, false, window, 0, 0, 0, 0, 0, false, false, false, false, 0, null);
            a.dispatchEvent(e);
        }
        let filename = 'backup.' + (Date.now()) + '.json';
        fileSave(items, filename);
    }

    return {
        save: save,
        load: load,
        saveToFileSystem: saveToFileSystem,
        maybeReload: maybeReload
    };
})();
