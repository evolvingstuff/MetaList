"use strict";
let $persist = (function () {
    let inMemLastSaveTimestamp = null;
    let inMemLastLoadTimestamp = null;
    let sessionTimestamp = Date.now();

    let REVERSE_PATH_CRYPTO_SANITY_CHECK = true;
    let ENCRYPTION_SCHEME_VERSION = 1;

    function injectDocs() {
        
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

    function maybeReload(items) {
        let stored_txt = localStorage.getItem('items');
        let in_memory_txt = JSON.stringify(items);
        let storedLastSaveTimestamp = localStorage.getItem('lastSaveTimestamp');
        if (storedLastSaveTimestamp != null && 
            parseInt(storedLastSaveTimestamp) > inMemLastLoadTimestamp && 
            in_memory_txt != stored_txt) {
            console.log('');
            console.log('------------------------------------');
            console.log('maybeReload()');
            console.log('\tstoredLastSaveTimestamp = ' + storedLastSaveTimestamp);
            console.log('\tinMemLastLoadTimestamp = ' + inMemLastLoadTimestamp);
            console.log('\tinMemLastSaveTimestamp = ' + inMemLastSaveTimestamp);
            console.log('\tsessionTimestamp = ' + sessionTimestamp);
            console.log('\tsession delta = ' + (Date.now() - sessionTimestamp));
            console.log('\t>>> Need to reload');
            return true;
        }
        else {
            //console.log('\t~No reload needed');
            return false;
        }
    }

    function save(items) {
        cleanItems(items);
        localStorage.setItem('items', JSON.stringify(items));
        inMemLastSaveTimestamp = Date.now();
        inMemLastLoadTimestamp = inMemLastSaveTimestamp;
        localStorage.setItem('lastSaveTimestamp', inMemLastSaveTimestamp + '');
        localStorage.setItem('lastSaveSessionTimestamp', sessionTimestamp+'');
        console.log('$persist.save(items)');
        console.log(items[0]);
        console.log('save()');
    }

    function load() {
        let items = null;
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
        inMemLastLoadTimestamp = Date.now();
        console.log('load()');
        return items;
    }

    function load_PROTECTED(passphrase) {
        //TODO: this needs to implement async
        console.log('load_PROTECTED()');
        lastLoad = Date.now();
        let items = null;

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

        return items;
    }

    function _fileSave(data, filename) {
        if (!data) {
            console.error('fileSave: No data');
            return;
        }
        if (!filename)
            filename = 'backup.json';
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

    //TODO: make a protected version of this
    function saveToFileSystem(items) {
        let filename = 'backup.' + (Date.now()) + '.json';
        let unenc_obj = {
            timestamp: Date.now(),
            data_schema_version: DATA_SCHEMA_VERSION,
            encryption: {
                encrypted: false
            },
            data: items
        }
        _fileSave(unenc_obj, filename);
    }

    function saveViewToFileSystem(items) {
        alert('saveViewToFileSystem()');

        let view_items = [];
        for (let item of items) {
            if (item._include == 1) {
                view_items.push(item);
            }
        }

        let filename = 'backup-view.' + (Date.now()) + '.json';
        let unenc_obj = {
            timestamp: Date.now(),
            data_schema_version: DATA_SCHEMA_VERSION,
            encryption: {
                encrypted: false
            },
            data: view_items
        }
        _fileSave(unenc_obj, filename);
        
    }

    function bufferToHex(buffer) {
        let arrbuff = new Uint8Array(buffer)
        let value = null;
        let result = '';
        for (let i = 0; i < arrbuff.length; i++) {
            value = arrbuff[i].toString(16)
            result += (value.length === 1 ? '0' + value : value)
        }
        return result;
    }

    function hexToBuffer(hex) {
        var result = [];
        for (var i = 0, len = hex.length; i < len; i+=2) {
            result.push(parseInt(hex.substr(i,2),16));
        }
        return new Uint8Array(result).buffer;
    }

    function unencryptFromFileObject(passphrase, obj, success, failure) {
        let iv = [];
        for (let i = 0; i < 12; i++) { //TODO: don't hardcode this here
            iv.push(obj.encryption.iv[i]);
        }
        let buff_iv = new Uint8Array(iv);
        decryptText(hexToBuffer(obj.data), buff_iv, passphrase).then(function(result) {
            let items = JSON.parse(result);
            success(items);
        })
        .catch(function(err) {
            failure();
        });
    }

    function save_PROTECTED(items, filename, passphrase) {
        let start = Date.now();
        console.log('save_PROTECTED()');
        let raw_items = JSON.stringify(items);

        encryptText(raw_items, passphrase).then(function(result) {
            let end = Date.now();
            console.log('Encryption took ' + (end-start) + 'ms');
            let start2 = Date.now();
            let hex = bufferToHex(result.encBuffer);
            let end2 = Date.now();
            console.log('Convert to hex took ' + (end2-start2)+'ms');

            let enc_obj = {
                timestamp: Date.now(),
                data_schema_version: DATA_SCHEMA_VERSION,
                encryption: {
                    encrypted: true,
                    encryption_scheme_version: ENCRYPTION_SCHEME_VERSION,
                    digest: CRYPTO_DIGEST,
                    alg: CRYPTO_ALG,
                    iv: result.iv
                },
                data: hex
            }
            _fileSave(enc_obj, filename);

            if (REVERSE_PATH_CRYPTO_SANITY_CHECK) {
                decryptText(hexToBuffer(hex), result.iv, passphrase).then(function(result2) {
                    if (result2 == raw_items) {
                        console.log('Passed reverse-path sanity check');
                    }
                    else {
                        throw "ERROR: could not properly decrypt original message";
                    }
                });
            }
        });
        console.log('saving...');
    }

    function saveToFileSystemEncrypted(items, passphrase) {
        let filename = 'MetaList.' + (Date.now()) + '.encrypted.json';
        save_PROTECTED(items, filename, passphrase);
    }

    return {
        save: save,
        load: load,
        saveViewToFileSystem: saveViewToFileSystem,
        saveToFileSystem: saveToFileSystem,
        saveToFileSystemEncrypted: saveToFileSystemEncrypted,
        maybeReload: maybeReload,
        unencryptFromFileObject: unencryptFromFileObject
    };
})();
