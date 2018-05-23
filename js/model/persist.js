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

    function save(items) {
        //console.log('save()');
        lastLoad = Date.now();
        localStorage.setItem('lastSave', Date.now() + '');
        calculatePriorityToPrevNext(items);
        if (SAVE_TO_LOCALSTORAGE) {
            let older = localStorage.getItem('items');
            let newer = JSON.stringify(items);
            if (older != newer) {
                //console.log('\tDEBUG: save() UPDATED');
            }
            else {
                //console.log('\tDEBUG: save() old same as new?');
            }
            localStorage.setItem('items', JSON.stringify(items));
        }
        if (SAVE_TO_DATABASE) {
            $db.maybePushTo(items);
        }
        //console.log('/save()');
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
            //console.log('$persist.load() [database]');
            alert("loading from database not implemented!");
            return false;
        }
        calculatePrevNextToPriority(items);
        return items;
    }

    function calculatePriorityToPrevNext(items) {
        if (items.length == 0) {
            return;
        }
        items.sort(function (a, b) {
            if (a.priority < b.priority) {
                return -1;
            }
            if (a.priority > b.priority) {
                return 1;
            }
            return 0;
        });
        items[0].prev = null;
        for (let i = 1; i < items.length; i++) {
            items[i - 1].next = items[i].id;
            items[i].prev = items[i - 1].id;
            //delete items[i].priority; TODO: this screws things up currently
        }
        items[items.length - 1].next = null;
    }

    function calculatePrevNextToPriority(items) {
        if (items.length == 0) {
            return;
        }
        let first_item = null;
        let pointers = {};
        for (let i = 0; i < items.length; i++) {
            items.priority = null; //set/reset
            pointers[items[i].id] = items[i];
            if (items[i].prev == null) {
                if (first_item != null) {
                    alert("WARNING: expected only one items with prev == null. Aborting.");
                    return;
                }
                first_item = items[i];
            }
        }
        let priority = 1;
        let item = first_item;
        while (true) {
            item.priority = priority++;
            if (item.next != null) {
                item = pointers[item.next];
            }
            else {
                break;
            }
        }
        items.sort(function (a, b) {
            if (a.priority < b.priority) {
                return -1;
            }
            if (a.priority > b.priority) {
                return 1;
            }
            throw "ERROR: priorities are the same?";
        });
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
