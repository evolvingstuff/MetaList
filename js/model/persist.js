"use strict";
let $persist = (function () {
    let SAVE_TO_LOCALSTORAGE = true;
    let LOAD_FROM_LOCALSTORAGE = true;
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

            save_PROTECTED(items, 'dumb_pa$$phrase'); //TODO, obviously
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
        return items;
    }

    //TODO: this is far too slow, blocking for about 700ms
    function bufferToHex(buffer) {
        let view = new Uint8Array(buffer)
        let value = null;
        let result = '';
        for (let i = 0; i < view.length; i++) {
            value = view[i].toString(16)
            result += (value.length === 1 ? '0' + value : value)
        }
        return result;
    }

    function save_PROTECTED(items, passphrase) {
        let start = Date.now();
        console.log('save_PROTECTED()');
        encryptText(JSON.stringify(items), passphrase).then(function(result) {
            let end = Date.now();
            console.log('ENCRYPTION TOOK ' + (end-start) + 'ms');
            
            /*
            let start2 = Date.now();
            let hex = bufferToHex(result.encBuffer);
            let end2 = Date.now();
            console.log('HEX took ' + (end2-start2)+'ms'); //No, that is way too slow
            //console.log(hex);
            */
            
            console.log(result);
        });
        console.log('saving...');
    }

    function load_PROTECTED(passphrase) {
        //TODO: this needs to implement async
        console.log('load_PROTECTED()');
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
        save_PROTECTED: save_PROTECTED,
        load_PROTECTED: load_PROTECTED,
        saveToFileSystem: saveToFileSystem,
        maybeReload: maybeReload
    };
})();
