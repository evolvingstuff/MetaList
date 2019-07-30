"use strict";
let $persist = (function () {
    const REVERSE_PATH_CRYPTO_SANITY_CHECK = true;
    const ENCRYPTION_SCHEME_VERSION = 1;
    let inMemLastSaveTimestamp = null;
    let inMemLastLoadTimestamp = null;
    let sessionTimestamp = Date.now();
    let loaded_data_schema_version = null;
    function _bundleItemsNonEncrypted(items_) {
        let bundle = {
            timestamp: Date.now(),
            data_schema_version: DATA_SCHEMA_VERSION,
            encryption: { encrypted: false },
            data: items_
        }
        return bundle;
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
        return items;
    }

    function maybeShouldReload() {
        if (window.location.href.startsWith('file')) {
            /*
            let stored_txt = localStorage.getItem('items');
            const items = $model.getItems();
            let in_memory_txt = JSON.stringify(items);
            let storedLastSaveTimestamp = localStorage.getItem('lastSaveTimestamp');
            if (storedLastSaveTimestamp != null && 
                parseInt(storedLastSaveTimestamp) > inMemLastLoadTimestamp && 
                in_memory_txt != stored_txt) {
                console.log('');
                console.log('------------------------------------');
                console.log('maybeShouldReload()');
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
            */
            //TODO: fix this - currently broken
            return false;
        }
        else {
            let localTimestampLastUpdate = $model.getTimestampLastUpdate();
            let sharedTimestampLastUpdate = parseInt(localStorage.getItem('timestampLastUpdate'))
            if (localTimestampLastUpdate != sharedTimestampLastUpdate) {
                if (localTimestampLastUpdate < sharedTimestampLastUpdate) {

                    //TODO: this logic is currently broken.

                    // console.log('>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>');
                    // console.log('RELOADING');
                    // console.log('local: ' + localTimestampLastUpdate);
                    // console.log('share: ' + sharedTimestampLastUpdate);
                    return false;
                }
                else {
                    alert('Unexpected: local timestamp last update is ahead of shared timestamp.');
                    return false;
                }
            }
            else {
                return false;
            }
        }
    }

    function _cleanedItemsCopy(items_) {
        let start = Date.now();
        let cleaned = JSON.stringify(items_, function(key, value) {
            if (key.charAt(0) == '_') {
                return undefined;
            }
            return value;
        });
        let end = Date.now();
        console.log('cleaning took ' + (end-start) +'ms');
        return JSON.parse(cleaned);
    }

    function save(onFnSuccess, onFnFailure) {

        if (DATA_SCHEMA_VERSION < 13) {
            throw "Unexpected data schema version: " + DATA_SCHEMA_VERSION;
        }
        if (onFnSuccess == undefined) {
            throw "Expected a valid success callback function here";
        }
        if (onFnFailure == undefined) {
            throw "Expected a valid failure callback function here";
        }

        //Remove these just in case
        localStorage.removeItem('items'); 
        localStorage.removeItem('DATA_SCHEMA_VERSION');

        let start = Date.now();

        let items_bundle = null;
        const items_ = $model.getItems();

        if (Array.isArray(items_)) {
            let cleaned = _cleanedItemsCopy(items_);
            items_bundle = _bundleItemsNonEncrypted(cleaned);
        }
        else {
            let cleaned = _cleanedItemsCopy(items_.data);
            items_bundle = _bundleItemsNonEncrypted(cleaned);
        }
        
        if (window.location.href.startsWith('file')) {

            let start1 = Date.now();
            localStorage.setItem('items_bundle', JSON.stringify(items_bundle))
            let end1 = Date.now();
            console.log('took '+(end1-start1)+'ms to save to localStorage');
            onFnSuccess();
        }
        else {
            let t1 = Date.now();
            $.ajax({
                url: '/items',
                type: 'post',
                dataType: 'json',
                contentType: 'application/json',
                success: function (json) {
                    let t2 = Date.now();
                    console.log(json);
                    console.log('\tround trip took ' + (t2 - t1) + 'ms');
                    onFnSuccess();
                },
                fail: function(xhr, textStatus, errorThrown){
                    onFnFailure();
                },
                error: function(request, status, error) {
                    onFnFailure();
                },
                data: JSON.stringify(items_bundle)
            });
        }
        inMemLastSaveTimestamp = Date.now();
        inMemLastLoadTimestamp = inMemLastSaveTimestamp;
        localStorage.setItem('lastSaveTimestamp', inMemLastSaveTimestamp + '');
        localStorage.setItem('lastSaveSessionTimestamp', sessionTimestamp+'');
        let end = Date.now();
        console.log('$persist.save(items) '+(end-start)+'ms');
    }

    function load(onFnSuccess, onFnFailure) {

        if (DATA_SCHEMA_VERSION < 13) {
            throw "Unexpected data schema version: " + DATA_SCHEMA_VERSION;
        }

        if (window.location.href.startsWith('file') == false) {
            //TODO: handle failure!
            let t1 = Date.now();
            $.ajax({
                url: '/items',
                type: 'get',
                contentType: 'application/json',
                success: function (response_obj) {
                    let t2 = Date.now();
                    console.log('\tload() round trip took ' + (t2 - t1)+'ms');

                    let items = null;
                    if (Array.isArray(response_obj)) {
                        items = response_obj;
                        let data_schema_version = localStorage.getItem('DATA_SCHEMA_VERSION'); //TODO
                        if (data_schema_version == null) {
                            console.log('Could not find data schema version, setting to 1');
                            data_schema_version = 1;
                        }
                        items = $schema.checkSchemaUpdate(items, data_schema_version);
                    }
                    else {
                        let items_bundle = response_obj;
                        items = $schema.checkSchemaUpdate(items_bundle.data, items_bundle.data_schema_version);
                    }
                    $model.setItems(items);
                    onFnSuccess();
                },
                fail: function(xhr, textStatus, errorThrown){
                    onFnFailure();
                },
                error: function(request, status, error) {
                    onFnFailure();
                }
            });
        }
        else {
            let items_bundle_txt = localStorage.getItem('items_bundle');
            let items_txt = localStorage.getItem('items');
            let items = null;
            if (items_bundle_txt != null) {
                let items_bundle = JSON.parse(items_bundle_txt);
                items = $schema.checkSchemaUpdate(items_bundle.data, items_bundle.data_schema_version);
            }
            else {
                if (items_txt != null && items_txt != '' && items_txt != '[]') {
                    console.log('Loading items from localStorage.');
                    items = JSON.parse(items_txt);
                }
                else {
                    items = [];
                }

                let data_schema_version = localStorage.getItem('DATA_SCHEMA_VERSION');
                if (data_schema_version != null) {
                    items = $schema.checkSchemaUpdate(items, parseInt(data_schema_version));
                }
                else {
                    console.log('No localStorage schema version found.');
                    items = $schema.checkSchemaUpdate(items, 1);
                    let empty_text = '';
                    $('.action-edit-search').val(empty_text);
                    localStorage.setItem('search', empty_text);
                }
            }
            inMemLastLoadTimestamp = Date.now();
            console.log('load()');
            $model.setItems(items);
            onFnSuccess();
        }
        localStorage.removeItem('DATA_SCHEMA_VERSION');
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

    function _saveToFileSystemUnencryptedJson(items_, only_view) {
        let filename = 'MetaList.' + (Date.now()) + '.json';
        if (only_view) {
            filename = 'MetaList-view.' + (Date.now()) + '.json';
        }
        let obj = {
            timestamp: Date.now(),
            data_schema_version: DATA_SCHEMA_VERSION,
            encryption: { encrypted: false },
            data: items_
        }
        _fileSave(obj, filename);
    }

    function _saveToFileSystemUnencryptedText(scope_items, view_only) {
        let filename = 'MetaList.' + (Date.now()) + '.text';
        if (view_only) {
            filename = 'MetaList-view.' + (Date.now()) + '.text';
        }
        scope_items.sort(function (a, b) {
            if (a.priority > b.priority) return 1;
            if (a.priority < b.priority) return -1;
            return 0;
        });
        let text = $model.getItemsAsText(scope_items);
        _fileSaveText(text, filename);
    }

    function removeUnincludedSubitems(items_) {
        //#TODO: may need to account for @meta items better here
        //TODO: should not include items with no subitems
        for (let item of items_) {
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
        return items_;
    }

    function saveToFileSystem(format, scope, encrypted, passphrase) {

        let scope_items = [];
        if (scope == 'all') {
            scope_items = copyJSON($model.getItems());
        }
        else {
            scope_items = copyJSON($model.getFilteredItems());
        }

        let only_view = false;
        if (scope == 'view') {
            only_view = true;
            scope_items = removeUnincludedSubitems(scope_items);
        }

        if (format == 'json') {

            scope_items = cleanItemsForSaving(scope_items);

            if (encrypted) {
                _saveToFileSystemEncryptedJson(scope_items, passphrase, only_view);
            }
            else {
                _saveToFileSystemUnencryptedJson(scope_items, only_view);
            }
        }
        else if (format == 'text') {

            //Do not need to "clean" items here, because we don't need to worry about
            //minimizing their size.

            if (encrypted) {
                alert('This should never be allowed');
                //saveToFileSystemEncryptedText(scope_items, passphrase, only_view);
            }
            else {
                _saveToFileSystemUnencryptedText(scope_items, only_view);
            }
        }
        else {
            alert('Warning: unknown format');
        }
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
            $model.setItems(items);
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

    function _saveToFileSystemEncryptedJson(items_, passphrase, only_view) {
        let filename = 'MetaList.' + (Date.now()) + '.encrypted.json';
        if (only_view) {
            filename = 'MetaList-view.' + (Date.now()) + '.encrypted.json';
        }
        save_PROTECTED(JSON.stringify(items_), filename, passphrase);
    }

    return {
        save: save,
        load: load,
        maybeShouldReload: maybeShouldReload,
        unencryptFromFileObject: unencryptFromFileObject,
        saveToFileSystem: saveToFileSystem
    };
})();
