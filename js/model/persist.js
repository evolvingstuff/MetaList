"use strict";

let $persist = (function () {

    const ENCRYPTION_SCHEME_VERSION = 1;

    let itemsCache = null;

    let locked = false;

    function setLocked(val) {
        locked = val;
        if (locked) {
            $view.setCursor('progress');
        }
        else {
            $view.setCursor('default');
        }
    }

    function isMutexLocked() {
        return locked;
    }

    function setItemsCache(items) {
        itemsCache = cleanedItemsCopy(items);
    }

    function bundleItemsNonEncrypted(items, timestampLastUpdate) {
        let bundle = {
            timestamp: timestampLastUpdate,
            data_schema_version: DATA_SCHEMA_VERSION,
            encryption: { encrypted: false },
            data: items
        }
        return bundle;
    }

    function cleanItemsForSaving(items) {
        for (let item of items) {
            for (let key of Object.keys(item)) {
                if (key.startsWith('_')) {
                    //underscore properties are decorations
                    delete item[key];
                }
            }
            if (item.subitems === undefined) {
                continue;
            }
            for (let subitem of item.subitems) {
                for (let key of Object.keys(subitem)) {
                    if (key.startsWith('_')) {
                        //underscore properties are decorations
                        delete subitem[key];
                    }
                }
            }
        }
        return items;
    }

    function cleanedItemsCopy(items) {

        //TODO: this could be made more efficient
        let cleaned = JSON.stringify(items, function(key, value) {
            if (key.charAt(0) === '_') {
                return undefined;
            }
            return value;
        });
        return JSON.parse(cleaned);
    }

    function saveToFileSystemUnencryptedJson(items, now) {
        $model.testConsistency();
        let filename = 'MetaList.' + now + '.json';
        let obj = {
            timestamp: now,
            data_schema_version: DATA_SCHEMA_VERSION,
            encryption: { encrypted: false },
            data: items
        }
        fileSave(obj, filename);
    }

    function saveToFileSystemUnencryptedText(items, now) {
        $model.testConsistency();
        let filename = 'MetaList.' + now + '.text';
        let text = $model.getItemsAsText(items);
        fileSaveText(text, filename);
    }

    function fileSave(data, filename) {
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

    function fileSaveText(data, filename) {
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
        let result = [];
        for (let i = 0, len = hex.length; i < len; i+=2) {
            result.push(parseInt(hex.substr(i,2),16));
        }
        return new Uint8Array(result).buffer;
    }

    function encryptItemsDiff(diffs, passphrase, after) {
        (async () => {
            for (let i = 0; i < diffs.added.length; i++) {
                let item = diffs.added[i];
                let result = await encryptText(JSON.stringify(item.subitems), passphrase);
                let encItem = copyJSON(item);
                delete encItem.subitems;
                encItem['iv'] = result.iv;
                encItem['subitems_enc'] = bufferToHex(result.encBuffer);
                diffs.added[i] = encItem;
            }
            for (let i = 0; i < diffs.updated.length; i++) {
                let item = diffs.updated[i];
                let result = await encryptText(JSON.stringify(item.subitems), passphrase);
                let encItem = copyJSON(item);
                delete encItem.subitems;
                encItem['iv'] = result.iv;
                encItem['subitems_enc'] = bufferToHex(result.encBuffer);
                diffs.updated[i] = encItem;
            }
            after(diffs);
        })();
    }

    function encryptItemsBundle(decryptedBundle, passphrase, after) {
        
        let encItems = [];
        (async () => {
            let encItems = [];
            let totalCached = 0;
            let totalCalculated = 0;
            for (let item of decryptedBundle.data) {
                let result = await encryptText(JSON.stringify(item.subitems), passphrase);
                let encItem = copyJSON(item);
                delete encItem.subitems;
                encItem['iv'] = result.iv;
                encItem['subitems_enc'] = bufferToHex(result.encBuffer);
                encItems.push(encItem);
                totalCalculated += 1;
            }
            let enc_obj = {
                timestamp: $model.getTimestampLastUpdate(),
                data_schema_version: DATA_SCHEMA_VERSION,
                encryption: {
                    encrypted: true,
                    encryption_scheme_version: ENCRYPTION_SCHEME_VERSION,
                    digest: DEFAULT_CRYPTO_DIGEST,
                    alg: DEFAULT_CRYPTO_ALG
                },
                data: encItems
            }
            after(enc_obj);
        })();
    }

    function saveToFileSystemEncryptedJson(items, passphrase, now) {
        $model.testConsistency();
        let filename = 'MetaList.' + now + '.encrypted.json';
        let encItems = [];
        (async () => {
            let encItems = [];
            for (let item of items) {
                let result = await encryptText(JSON.stringify(item.subitems), passphrase);
                let encItem = copyJSON(item);
                delete encItem.subitems;
                encItem['iv'] = result.iv;
                encItem['subitems_enc'] = bufferToHex(result.encBuffer);
                encItems.push(encItem);
            }
            
            let enc_obj = {
                timestamp: $model.getTimestampLastUpdate(),
                data_schema_version: DATA_SCHEMA_VERSION,
                encryption: {
                    encrypted: true,
                    encryption_scheme_version: ENCRYPTION_SCHEME_VERSION,
                    digest: DEFAULT_CRYPTO_DIGEST,
                    alg: DEFAULT_CRYPTO_ALG
                },
                data: encItems
            }
            fileSave(enc_obj, filename);
        })();
        return;
    }

    /////////////////////////////////////////////////////

    function saveToHostOnIdle(onFnSuccess, onFnFailure) {
        $model.testConsistency();
        saveToHostDiff(onFnSuccess, onFnFailure);
    }

    function saveToHostDiff(onFnSuccess, onFnFailure) {
        $simpleLock.updateToken();

        if (locked) {
            console.warn('Blocked by lock @ saveToHostDiff()');
            onFnFailure();
            return;
        }
        setLocked(true);

        if (onFnSuccess === undefined) {
            throw "Expected a valid success callback function here";
        }
        if (onFnFailure === undefined) {
            throw "Expected a valid failure callback function here";
        }

        let items_bundle = null;
        const items_ = $model.getSortedItems();
        let cleaned = cleanedItemsCopy(items_);

        //refresh cache
        let itemsCacheMap = {};
        for (let item of itemsCache) {
            itemsCacheMap[item.id] = item;
        }

        /////////////////////////////////////////////////////////////////////////
        /////////////////////////////////////////////////////////////////////////
        /////////////////////////////////////////////////////////////////////////

        let diffs = {
            updated: [],
            added: [],
            deleted: []
        };
        let count = 0;

        let map = {};

        for (let item of cleaned) {
            map[item.id] = item;
        }

        for (let item of cleaned) {
            if (itemsCacheMap[item.id] === undefined) {
                diffs.added.push(copyJSON(item));
                count += 1;
            }
            else {
                let item1 = itemsCacheMap[item.id];
                let item2 = item;
                if (item2.last_edit > item1.last_edit) {
                    diffs.updated.push(copyJSON(item2));
                    count += 1;
                }
                else if (item2.prev !== item1.prev || 
                         item2.next !== item1.next) {
                    diffs.updated.push(copyJSON(item2));
                    count += 1;
                }
            }
        }

        for (let key of Object.keys(itemsCacheMap)) {
            let item = itemsCacheMap[key];
            if (map[item.id] === undefined) {
                diffs.deleted.push({ id: item.id });
                count += 1;
            }
        }

        itemsCache = cleaned;

        /////////////////////////////////////////////////////////////////////////
        /////////////////////////////////////////////////////////////////////////
        /////////////////////////////////////////////////////////////////////////

        function afterMaybeEncryptDiffs(diffs) {

            $.ajax({
                url: '/items-diff',
                type: 'post',
                dataType: 'json',
                contentType: 'application/json',
                success: function (json) {
                    setLocked(false);
                    onFnSuccess();
                },
                fail: function(xhr, textStatus, errorThrown){
                    onFnFailure();
                },
                error: function(request, status, error) {
                    onFnFailure();
                },
                data: JSON.stringify(diffs)
            });
            
        }
        
        if ($protection.getModeProtected()) {
            let passphrase = $protection.getPassword();
            encryptItemsDiff(diffs, passphrase, afterMaybeEncryptDiffs);
        }
        else {
            afterMaybeEncryptDiffs(diffs);
        }
    }

    function deleteEverything(onFnSuccess, onFnFailure) {
        if (locked) {
            console.warn('Blocked by lock @ deleteEverything()');
            onFnFailure();
            return;
        }
        setLocked(true);

        if (onFnSuccess === undefined) {
            throw "Expected a valid success callback function here";
        }
        if (onFnFailure === undefined) {
            throw "Expected a valid failure callback function here";
        }

        $.ajax({
            url: '/delete-everything',
            type: 'post',
            dataType: 'json',
            contentType: 'application/json',
            success: function (json) {
                setLocked(false);
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

    function saveToHostFull(onFnSuccess, onFnFailure) {

        console.log('----------------------------------');
        console.log('saveToHostFull')
        console.log('----------------------------------');

        $simpleLock.updateToken();

        if (locked) {
            console.warn('Blocked by lock @ saveToHostFull()');
            onFnFailure();
            return;
        }
        setLocked(true);

        if (onFnSuccess === undefined) {
            throw "Expected a valid success callback function here";
        }
        if (onFnFailure === undefined) {
            throw "Expected a valid failure callback function here";
        }

        let items_bundle = null;
        const items_ = $model.getSortedItems();
        let cleaned = cleanedItemsCopy(items_);
        
        items_bundle = bundleItemsNonEncrypted(cleaned, $model.getTimestampLastUpdate());

        function afterMaybeEncrypt(items_bundle) {
            $.ajax({
                url: '/items',
                type: 'post',
                dataType: 'json',
                contentType: 'application/json',
                success: function (json) {
                    setLocked(false);
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

        if ($protection.getModeProtected()) {
            let passphrase = $protection.getPassword();
            encryptItemsBundle(items_bundle, passphrase, afterMaybeEncrypt);
        }
        else {
            afterMaybeEncrypt(items_bundle);
        }
    }

    function loadFromHost(onFnSuccess, onFnFailure) {

        $simpleLock.getToken();

        if (locked) {
            console.warn('Blocked by lock @ loadFromHost');
            onFnFailure();
            return;
        }
        setLocked(true);

        //TODO: handle failure!
        $.ajax({
            url: '/items',
            type: 'get',
            contentType: 'application/json',
            success: function (items_bundle) {

                function afterMaybeDecrypt(decryptedBundle) {

                    let items = null;
                    let updated = false;
                    if ($schema.isUpdateRequired(decryptedBundle.data_schema_version)) {
                        items = $schema.updateSchema(decryptedBundle.data, decryptedBundle.data_schema_version);
                        updated = true;
                    }
                    else {
                        items = decryptedBundle.data;
                    }
                    $model.setItems(items);
                    setItemsCache(items);
                    $model.setTimestampLastUpdate(decryptedBundle.timestamp);

                    if (updated) {
                        setLocked(false);
                        saveToHostFull(
                            function success() {
                                setLocked(false);  //Redundant?
                                onFnSuccess();
                            },
                            function fail() {
                                alert('ERROR: failed to save after schema update');
                        });
                    }
                    else {
                        setLocked(false);
                        onFnSuccess();
                    }
                }

                if (items_bundle.encryption.encrypted) {
                    setLocked(false);
                    $unlock.prompt(items_bundle, afterMaybeDecrypt);
                }
                else {
                    afterMaybeDecrypt(items_bundle);
                }
            },
            fail: function(xhr, textStatus, errorThrown){
                onFnFailure();
            },
            error: function(request, status, error) {
                onFnFailure();
            }
        });
    }

    function saveToFileSystem(format, encrypted, passphrase) {
        $model.testConsistency();
        let now = Date.now();
        localStorage.setItem('last-save-backup', now.toString());

        let items = copyJSON($model.getSortedItems());
        if (format === 'json') {
            items = cleanItemsForSaving(items);
            if (encrypted) {
                saveToFileSystemEncryptedJson(items, passphrase, now);            }
            else {
                saveToFileSystemUnencryptedJson(items, now);
            }
        }
        else if (format === 'text') {
            //Do not need to "clean" items here, because we don't need to worry about
            //minimizing their size.
            if (encrypted) {
                alert('This should never be allowed');
            }
            else {
                saveToFileSystemUnencryptedText(items, now);
            }
        }
        else {
            alert('Warning: unknown format');
        }
    }

    function decryptItemsBundle(encryptedBundle, passphrase, success, failure) {
        (async () => {
            try {
                let decryptedBundle = copyJSON(encryptedBundle);
                let items = [];
                for (let item of encryptedBundle.data) {
                    let iv = [];
                    for (let i = 0; i < 12; i++) { //TODO: don't hardcode this here
                        iv.push(item.iv[i]);
                    }
                    let buff_iv = new Uint8Array(iv);
                    let result = await decryptText(hexToBuffer(item.subitems_enc), buff_iv, encryptedBundle.encryption.digest, encryptedBundle.encryption.alg, passphrase);
                    let subitems = JSON.parse(result);
                    item.subitems = subitems;
                    delete item.subitems_enc;
                    delete item.iv;
                    items.push(item);
                }
                decryptedBundle.encryption.encrypted = false;
                delete decryptedBundle.encryption.encryption_scheme_version;
                delete decryptedBundle.encryption.encryption_granularity;
                delete decryptedBundle.encryption.digest;
                delete decryptedBundle.encryption.alg;
                delete decryptedBundle.encryption.iv;
                decryptedBundle.data = items;
                success(passphrase, decryptedBundle);
            }
            catch (e) {
                failure(e);
            }
        })();
    }

    function decryptFromFileObject(passphrase, obj, success, failure) {
        (async () => {
            try {
                let items = [];
                for (let item of obj.data) {
                    let iv = [];
                    for (let i = 0; i < 12; i++) { //TODO: don't hardcode this here
                        iv.push(item.iv[i]);
                    }
                    let buff_iv = new Uint8Array(iv);
                    let result = await decryptText(hexToBuffer(item.subitems_enc), buff_iv, obj.encryption.digest, obj.encryption.alg, passphrase);
                    let subitems = JSON.parse(result);
                    item.subitems = subitems;
                    delete item.subitems_enc;
                    delete item.iv;
                    items.push(item);
                }
                success(items);
            }
            catch (e) {
                failure('Incorrect password');
            }
        })();
    }

    return {
        saveToHostFull: saveToHostFull,
        saveToHostOnIdle: saveToHostOnIdle,
        loadFromHost: loadFromHost,
        decryptFromFileObject: decryptFromFileObject,
        saveToFileSystem: saveToFileSystem,
        decryptItemsBundle: decryptItemsBundle,
        setItemsCache: setItemsCache,
        deleteEverything: deleteEverything,
        isMutexLocked: isMutexLocked,
        fileSaveText: fileSaveText
    };
})();
