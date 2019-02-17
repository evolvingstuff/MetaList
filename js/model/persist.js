"use strict";
let $persist = (function () {
    let inMemLastSaveTimestamp = null;
    let inMemLastLoadTimestamp = null;
    let sessionTimestamp = Date.now();

    let REVERSE_PATH_CRYPTO_SANITY_CHECK = true;
    let ENCRYPTION_SCHEME_VERSION = 1;

    let INIT_FRESH_WITH_DOCS = false;

    function injectDocs() {
        
    }

    function cleanItemsForSaving(items) {
        let start = Date.now();
        for (let item of items) {
            if (item.subitems == undefined) {
                continue;
            }
            for (let subitem of item.subitems) {
                delete subitem._tags;
                delete subitem._inherited_tags;
                delete subitem._implied_tags;
                delete subitem._direct_tags;
                delete subitem._numeric_tags;
                delete subitem._include;
            }
        }
        let end = Date.now();
        console.log('cleaning for saving took ' + (end-start) + 'ms');
    }

    function maybeReload(items) {
        if (window.location.href.startsWith('file') == false) {
            //TODO: fix this
            return false;
        }
        else {
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
                return false;
            }
        }
    }

    function cleanedText(items) {
        let start = Date.now();
        let cleaned = JSON.stringify(items, function(key, value) {
            if (key.charAt(0) == '_') {
                return undefined;
            }
            return value;
        });
        let end = Date.now();
        console.log('cleaning took ' + (end-start) +'ms');
        return cleaned;
    }

    function save(items_, success, failure) {
        let start = Date.now();
        let cleaned = cleanedText(items_);
        if (window.location.href.startsWith('file') == false) {
            //TODO: handle failure!
            console.log('DEBUG: save to server');
            let t1 = Date.now();
            $.ajax({
                url: '/items',
                type: 'post',
                dataType: 'json',
                contentType: 'application/json',
                success: function (json) {
                    let t2 = Date.now();
                    console.log('DEBUG: save to server succeeded.');
                    console.log(json);
                    console.log('\tround trip took ' + (t2 - t1)+'ms');
                    success();
                },
                fail: function(xhr, textStatus, errorThrown){
                    failure();
                },
                error: function(request, status, error) {
                    failure();
                },
                data: cleaned
            });
        }
        else {
            let start1 = Date.now();
            localStorage.setItem('items', cleaned);
            let end1 = Date.now();
            console.log('took '+(end1-start1)+'ms to save to localStorage');
        }
        inMemLastSaveTimestamp = Date.now();
        inMemLastLoadTimestamp = inMemLastSaveTimestamp;
        localStorage.setItem('lastSaveTimestamp', inMemLastSaveTimestamp + '');
        localStorage.setItem('lastSaveSessionTimestamp', sessionTimestamp+'');
        let end = Date.now();
        console.log('$persist.save(items) '+(end-start)+'ms');
    }

    function load(success, failure) {
        if (window.location.href.startsWith('file') == false) {
            //TODO: handle failure!
            let t1 = Date.now();
            $.ajax({
                url: '/items',
                type: 'get',
                contentType: 'application/json',
                success: function (items) {
                    let t2 = Date.now();
                    console.log('\tload() round trip took ' + (t2 - t1)+'ms');
                    success(items);
                },
                fail: function(xhr, textStatus, errorThrown){
                    failure();
                },
                error: function(request, status, error) {
                    failure();
                }
            });
        }
        else {
            let items = null;
            let txt = localStorage.getItem('items');
            if (txt != null && txt != '' && txt != '[]') {
                console.log('Loading from localStorage.');
                items = JSON.parse(txt);
            }
            else {
                if (INIT_FRESH_WITH_DOCS) {
                    console.log('No localStorage data found. Initializing fresh documentation.');
                    //TODO: need to fix docs so that they correspond to new format
                    items = docs;
                    items = $schema.checkSchemaUpdate(items, 1);
                    let text = 'welcome -@meta';
                    $('.action-edit-search').val(text);
                    localStorage.setItem('search', text);
                }
                else {
                    items = [];
                    let text = '';
                    $('.action-edit-search').val(text);
                    localStorage.setItem('search', text);
                }
            }
            inMemLastLoadTimestamp = Date.now();
            console.log('load()');
            let data_schema_version = localStorage.getItem('DATA_SCHEMA_VERSION'); //TODO
            items = $schema.checkSchemaUpdate(items, data_schema_version);
            success(items);
        }
    }

    function cleanUndefined(items) { //This is a hack
        let tot = 0;
        for (let item of items) {
            for (let sub of item.subitems) {
                let parts = sub.tags.split(' ');
                if (parts.includes('undefined')) {
                    tot ++;
                }
            }
        }
        if (tot > 0) {
            alert('Waring: ' + tot + ' `undefined` entries');

            for (let item of items) {
                for (let sub of item.subitems) {
                    let parts = sub.tags.split(' ');
                    let fixed = [];
                    for (let part of parts) {
                        if (part.trim() == '') {
                            continue;
                        }
                        if (part.trim() == 'undefined') {
                            continue;
                        }
                        fixed.push(part.trim());
                    }
                    if (fixed.length > 0) {
                        sub.tags = fixed.join(' ');
                    }
                    else {
                        sub.tags = '';
                    }
                }
            }
        }
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

    function _fileSaveText(data, filename) {
        if (!data) {
            console.error('fileSave: No data');
            return;
        }
        if (!filename)
            filename = 'backup.txt';
        let blob = new Blob([data], { type: 'text' }), e = document.createEvent('MouseEvents'), a = document.createElement('a');
        a.download = filename;
        a.href = window.URL.createObjectURL(blob);
        a.dataset.downloadurl = ['text', a.download, a.href].join(':');
        e.initMouseEvent('click', true, false, window, 0, 0, 0, 0, 0, false, false, false, false, 0, null);
        a.dispatchEvent(e);
    }

    function saveToFileSystemUnencryptedJson(items, only_view) {
        let filename = 'MetaList.' + (Date.now()) + '.json';
        if (only_view) {
            filename = 'MetaList-view.' + (Date.now()) + '.json';
        }
        let obj = {
            timestamp: Date.now(),
            data_schema_version: DATA_SCHEMA_VERSION,
            encryption: { encrypted: false },
            data: items
        }
        _fileSave(obj, filename);
    }

    function saveToFileSystemEncryptedText(items_, passphrase, view_only) {
        let filename = 'MetaList.' + (Date.now()) + '.encrypted-text.json';
        if (only_view) {
            filename = 'MetaList-view.' + (Date.now()) + '.encrypted-text.json';
        }
        let items = copyJSON(items_);
        items.sort(function (a, b) {
            if (a.priority > b.priority) return 1;
            if (a.priority < b.priority) return -1;
            return 0;
        });
        let text = $model.getItemsAsText(items);
        save_PROTECTED(text, filename, passphrase);
    }

    function saveToFileSystemUnencryptedText(items_, view_only) {
        let filename = 'MetaList.' + (Date.now()) + '.text';
        if (view_only) {
            filename = 'MetaList-view.' + (Date.now()) + '.text';
        }
        let items = copyJSON(items_);
        items.sort(function (a, b) {
            if (a.priority > b.priority) return 1;
            if (a.priority < b.priority) return -1;
            return 0;
        });
        let text = $model.getItemsAsText(items);
        _fileSaveText(text, filename);
    }

    function removeUnincludedSubitems(items) {
        //#TODO: may need to account for @meta items better here
        //TODO: should not include items with no subitems
        for (let item of items) {
            if (item.deleted != undefined) {
                continue;
            }
            let includes = [];
            for (let subitem of item.subitems) {
                if (subitem._include == 1) {
                    includes.push(subitem);
                }
            }
            item.subitems = includes;
        }
    }

    function saveToFileSystem(items_, format, scope, encrypted, passphrase) {

        let items = copyJSON(items_);
        
        let scope_items = [];
        if (scope == 'all') {
            scope_items = items;
        }
        else {
            for (let item of items) {
                if (item.subitems[0]._include == 1) {
                    scope_items.push(item);
                }
            }
        }

        let only_view = false;
        if (scope == 'view') {
            only_view = true;
            removeUnincludedSubitems(scope_items);
        }

        if (format == 'json') {

            cleanItemsForSaving(scope_items);

            if (encrypted) {
                saveToFileSystemEncryptedJson(scope_items, passphrase, only_view);
            }
            else {
                saveToFileSystemUnencryptedJson(scope_items, only_view);
            }
        }
        else if (format == 'text') {

            //Do not need to "clean" items here, because we don't need to worry about
            //minimizing their size.

            if (encrypted) {
                saveToFileSystemEncryptedText(scope_items, passphrase, only_view);
            }
            else {
                saveToFileSystemUnencryptedText(scope_items, only_view);
            }
        }
        else {
            alert('Warning: unknown format');
        }
    }


    function saveTextVersionToFileSystem(items_) {
        let items = copyJSON(items_);
        let filename = 'backup.' + (Date.now()) + '.txt';
        items.sort(function (a, b) {
            if (a.priority > b.priority) return 1;
            if (a.priority < b.priority) return -1;
            return 0;
        });
        let result = $model.getItemsAsText(items);
        _fileSaveText(result, filename);
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

    function save_PROTECTED(raw_items, filename, passphrase) {
        let start = Date.now();
        console.log('save_PROTECTED()');

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

    function saveToFileSystemEncryptedJson(items, passphrase, only_view) {
        let filename = 'MetaList.' + (Date.now()) + '.encrypted.json';
        if (only_view) {
            filename = 'MetaList-view.' + (Date.now()) + '.encrypted.json';
        }
        save_PROTECTED(JSON.stringify(items), filename, passphrase);
    }

    return {
        save: save,
        load: load,
        maybeReload: maybeReload,
        unencryptFromFileObject: unencryptFromFileObject,
        saveToFileSystem: saveToFileSystem
    };
})();
