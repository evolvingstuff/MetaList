"use strict";

let $persist = (function () {

    const ENCRYPTION_SCHEME_VERSION = 1;
    const INDEXEDDB_VERSION = 1;
    const ENCRYPTION_GRANULARITY_LOCALSTORAGE = 'per-item'; // per-item | full
    const ENCRYPTION_GRANULARITY_INDEXEDDB = 'per-item'; // per-item | full
    const ENCRYPTION_GRANULARITY_SERVER = 'per-item'; // per-item | full
    const ENCRYPTION_GRANULARITY_FILE = 'per-item'; // per-item | full

    let itemsCache = null;

    let locked = false;

    function setItemsCache(items) {
        itemsCache = cleanedItemsCopy(items);
        console.log('>>>>>>>>>>>>>>>>>>>>>>');
        console.log('set cache map of items');
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
        let start = Date.now();
        for (let item of items) {
            for (let key of Object.keys(item)) {
                if (key.startsWith('_')) {
                    //underscore properties are decorations
                    delete item[key];
                }
            }
            if (item.subitems == undefined) {
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
        let end = Date.now();
        console.log('cleaning for saving took ' + (end-start) + 'ms');
        return items;
    }

    function cleanedItemsCopy(items) {

        //TODO: this could be made more efficient

        let start = Date.now();
        let cleaned = JSON.stringify(items, function(key, value) {
            if (key.charAt(0) == '_') {
                return undefined;
            }
            return value;
        });
        let end = Date.now();
        console.log('cleaning took ' + (end-start) +'ms');
        return JSON.parse(cleaned);
    }

    function saveToFileSystemUnencryptedJson(items) {
        let filename = 'MetaList.' + ($model.getTimestampLastUpdate()) + '.json';
        let obj = {
            timestamp: $model.getTimestampLastUpdate(),
            data_schema_version: DATA_SCHEMA_VERSION,
            encryption: { encrypted: false },
            data: items
        }
        fileSave(obj, filename);
    }

    function saveToFileSystemUnencryptedText(items) {
        let filename = 'MetaList.' + ($model.getTimestampLastUpdate()) + '.text';
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
        var result = [];
        for (var i = 0, len = hex.length; i < len; i+=2) {
            result.push(parseInt(hex.substr(i,2),16));
        }
        return new Uint8Array(result).buffer;
    }

    function encryptItemsDiff(diffs, passphrase, after) {
        let t1 = Date.now();
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
        
        let context = getHostingContext();
        let encryption_granularity = null;
        if (context == 'localStorage') {
            encryption_granularity = ENCRYPTION_GRANULARITY_LOCALSTORAGE;
        }
        else if (context == 'IndexedDB') {
            encryption_granularity = ENCRYPTION_GRANULARITY_INDEXEDDB;
        }
        else if (context == 'server') {
            encryption_granularity = ENCRYPTION_GRANULARITY_SERVER;
        }
        else {
            alert('Unknown hosting context ' + context);
            return;
        }

        if (encryption_granularity == 'full') {
            let t1 = Date.now();
            let text = JSON.stringify(decryptedBundle.data);
            let t2_stringify = Date.now();
            console.log('Took '+(t2_stringify-t1)+'ms to stringify');
            encryptText(text, passphrase).then(function(result) {
                let hex = bufferToHex(result.encBuffer);
                let encryptedBundle = {
                    timestamp: $model.getTimestampLastUpdate(),
                    data_schema_version: DATA_SCHEMA_VERSION,
                    encryption: {
                        encrypted: true,
                        encryption_granularity: encryption_granularity,
                        encryption_scheme_version: ENCRYPTION_SCHEME_VERSION,
                        digest: DEFAULT_CRYPTO_DIGEST,
                        alg: DEFAULT_CRYPTO_ALG,
                        iv: result.iv
                    },
                    data: hex
                }
                let t2 = Date.now();
                console.log('Saved as encrypted bundle. Encryption took '+(t2-t1)+'ms');
                after(encryptedBundle);
            });
        }
        else if (encryption_granularity == 'per-item') {
            let t1 = Date.now();
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
                let t2 = Date.now();
                console.log('per item encryption w cache took '+(t2-t1)+'ms');
                console.log('\tcached: ' + totalCached);
                console.log('\tcalculated: ' + totalCalculated);
                let enc_obj = {
                    timestamp: $model.getTimestampLastUpdate(),
                    data_schema_version: DATA_SCHEMA_VERSION,
                    encryption: {
                        encrypted: true,
                        encryption_granularity: encryption_granularity, 
                        encryption_scheme_version: ENCRYPTION_SCHEME_VERSION,
                        digest: DEFAULT_CRYPTO_DIGEST,
                        alg: DEFAULT_CRYPTO_ALG
                    },
                    data: encItems
                }
                after(enc_obj);
            })();
        }
        else {
            alert('Unknown encryption granularity: ' + encryption_granularity);
            return;
        }
    }

    function saveToFileSystemEncryptedJson(items, passphrase) {
        let filename = 'MetaList.' + ($model.getTimestampLastUpdate()) + '.encrypted.json';
        let start = Date.now();
        console.log('saveToFileSystemEncryptedJson() to file');
        let context = getHostingContext();
        let encryption_granularity = ENCRYPTION_GRANULARITY_FILE;
        if (encryption_granularity == 'full') {
            let items_str = JSON.stringify(items);
            function after(result) {
                let end = Date.now();
                console.log('Encryption took ' + (end-start) + 'ms');
                let start2 = Date.now();
                let hex = bufferToHex(result.encBuffer);
                let end2 = Date.now();
                console.log('Convert to hex took ' + (end2-start2)+'ms');

                let enc_obj = {
                    timestamp: $model.getTimestampLastUpdate(),
                    data_schema_version: DATA_SCHEMA_VERSION,
                    encryption: {
                        encrypted: true,
                        encryption_granularity: encryption_granularity, 
                        encryption_scheme_version: ENCRYPTION_SCHEME_VERSION,
                        digest: DEFAULT_CRYPTO_DIGEST,
                        alg: DEFAULT_CRYPTO_ALG,
                        iv: result.iv
                    },
                    data: hex
                }
                fileSave(enc_obj, filename);
            }
            encryptText(items_str, passphrase).then(after);
        }
        else if (encryption_granularity == 'per-item') {
            let t1 = Date.now();
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
                let t2 = Date.now();
                
                let enc_obj = {
                    timestamp: $model.getTimestampLastUpdate(),
                    data_schema_version: DATA_SCHEMA_VERSION,
                    encryption: {
                        encrypted: true,
                        encryption_granularity: encryption_granularity, 
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
        else {
            alert('Unknown encryption granularity: ' + encryption_granularity);
            return;
        }
        console.log('saving...');
    }

    /////////////////////////////////////////////////////

    function maybeShouldReload(after) {
        let context = getHostingContext();
        if (context == 'localStorage') {
            if ($model.getTimestampLastUpdate() < parseInt(localStorage.getItem('items_bundle_timestamp'))) {
                after(true);
            }
            else {
                after(false);
            }
        }
        else if (context == 'IndexedDB') {

            if ($model.getTimestampLastUpdate() < parseInt(localStorage.getItem('items_bundle_timestamp'))) {
                after(true);
            }
            else {
                after(false);
            }
        }
        else if (context == 'server') {
            $.ajax({
                url: '/items_bundle_timestamp',
                type: 'get',
                contentType: 'application/json',
                success: function (result) {
                    if (result.items_bundle_timestamp > $model.getTimestampLastUpdate()) {
                        after(true);
                    }
                    else {
                        after(false);
                    }
                },
                fail: function(xhr, textStatus, errorThrown){
                    console.error('Error connecting to server');
                    after(false);
                },
                error: function(request, status, error) {
                    console.error('Error connecting to server');
                    after(false);
                }
            });
        }
        else {
            console.error('Unknown hosting context: ' + context);
            after(false);
        }
    }

    function saveToHostOnIdle(onFnSuccess, onFnFailure) {

        console.log('');
        console.log('saveToHostOnIdle()');
        console.log(summarizeLocalStorage());

        let context = getHostingContext();
        if (context == 'localStorage') {
            saveToHostFull(onFnSuccess, onFnFailure);
        }
        else if (context == 'IndexedDB') {
            if (ENCRYPTION_GRANULARITY_INDEXEDDB == 'full') {
                saveToHostFull(onFnSuccess, onFnFailure);
            }
            else if (ENCRYPTION_GRANULARITY_INDEXEDDB == 'per-item') {
                saveToHostDiff(onFnSuccess, onFnFailure);
            }
            else {
                alert('Unknown encryption granularity ' + ENCRYPTION_GRANULARITY_INDEXEDDB);
            }
        }
        else if (context == 'server') {
            if (ENCRYPTION_GRANULARITY_SERVER == 'full') {
                saveToHostFull(onFnSuccess, onFnFailure);
            }
            else if (ENCRYPTION_GRANULARITY_SERVER == 'per-item') {
                saveToHostDiff(onFnSuccess, onFnFailure);
            }
            else {
                alert('Unknown encryption granularity ' + ENCRYPTION_GRANULARITY_SERVER);
            }
        }
        else {
            alert('Unknown hosting context ' + context);
            return;
        }
    }

    function saveToHostDiff(onFnSuccess, onFnFailure) {

        if (locked) {
            console.warn('Blocked by lock');
            onFnFailure();
            return;
        }
        locked = true;

        console.log('saveToHostDiff()');
        console.log(summarizeLocalStorage());

        if (onFnSuccess == undefined) {
            throw "Expected a valid success callback function here";
        }
        if (onFnFailure == undefined) {
            throw "Expected a valid failure callback function here";
        }

        let start = Date.now();

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

        console.log('-----------------------------');
        console.log('DIFFS COMPARISON');

        let compare1 = Date.now();

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
            if (itemsCacheMap[item.id] == undefined) {
                console.log('\tADDED ITEM ' + item.id);
                diffs.added.push(copyJSON(item));
                count += 1;
            }
            else {
                let item1 = itemsCacheMap[item.id];
                let item2 = item;
                if (item2.last_edit > item1.last_edit) {
                    console.log('\tUPDATED ' + item2.id);
                    diffs.updated.push(copyJSON(item2));
                    count += 1;
                }
                else if (item2.prev != item1.prev || 
                         item2.next != item1.next) {
                    console.log('\tSHIFTED ' + item2.id);
                    diffs.updated.push(copyJSON(item2));
                    count += 1;
                }
            }
        }

        for (let key of Object.keys(itemsCacheMap)) {
            let item = itemsCacheMap[key];
            if (map[item.id] == undefined) {
                console.log('\tDELETED ITEM ' + item.id);
                diffs.deleted.push({ id: item.id });
                count += 1;
            }
        }

        let compare2 = Date.now();
        console.log(diffs);
        console.log(count + ' total updates');

        itemsCache = cleaned;

        console.log('COMPARISON TOOK '+(compare2-compare1)+'ms');

        /////////////////////////////////////////////////////////////////////////
        /////////////////////////////////////////////////////////////////////////
        /////////////////////////////////////////////////////////////////////////

        function afterMaybeEncryptDiffs(diffs) {

            console.log('afterMaybeEncryptDiffs()');
            console.log(summarizeLocalStorage());

            let context = getHostingContext();
            if (context == 'IndexedDB') {

                let mapUpdated = {};
                let mapAdded = {};
                let keysDeleted = [];

                for (let item of diffs.updated) {
                    console.log('\tDEBUG: updated ' + item.id);
                    localStorage.setItem(item.id.toString(), JSON.stringify(item));
                }
                for (let item of diffs.added) {
                    console.log('\tDEBUG: added ' + item.id);
                    localStorage.setItem(item.id.toString(), JSON.stringify(item));
                }
                for (let item of diffs.deleted) {
                    console.log('\tDEBUG: deleted ' + item.id);
                    localStorage.removeItem(item.id.toString());
                }

                let debugSummary = summarizeLocalStorage();

                console.log(summarizeLocalStorage());
                
                if (debugSummary.totalItems != cleaned.length) {
                    debugger;
                    throw "Mismatch " + debugSummary.totalItems + " total items in LS vs expected " + cleaned.length;
                }

                console.log("DONE WITH DIFF SAVE IndexedDB");
                locked = false;
                onFnSuccess();
            }
            else if (context == 'server') {
                let t1 = Date.now();
                $.ajax({
                    url: '/items-diff',
                    type: 'post',
                    dataType: 'json',
                    contentType: 'application/json',
                    success: function (json) {
                        let t2 = Date.now();
                        console.log(json);
                        console.log('\tround trip took ' + (t2 - t1) + 'ms');
                        locked = false;
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
            else {
                alert('Unknown context ' + context);
            }
        }
        
        if ($protection.getModeProtected()) {
            let passphrase = $protection.getPassword();
            encryptItemsDiff(diffs, passphrase, afterMaybeEncryptDiffs);
        }
        else {
            afterMaybeEncryptDiffs(diffs);
        }
    }

    function saveToHostFull(onFnSuccess, onFnFailure) {

        if (locked) {
            console.warn('Blocked by lock');
            onFnFailure();
            return;
        }
        locked = true;

        console.log('saveToHostFull()');
        console.log(summarizeLocalStorage());

        if (onFnSuccess == undefined) {
            throw "Expected a valid success callback function here";
        }
        if (onFnFailure == undefined) {
            throw "Expected a valid failure callback function here";
        }

        let start = Date.now();

        let items_bundle = null;
        const items_ = $model.getSortedItems();
        let cleaned = cleanedItemsCopy(items_);
        
        items_bundle = bundleItemsNonEncrypted(cleaned, $model.getTimestampLastUpdate());
        console.log('items_bundle.data.length = ' + items_bundle.data.length);

        function afterMaybeEncrypt(items_bundle) {
            let context = getHostingContext();
            if (context == 'localStorage') {
                let start1 = Date.now();
                try {
                    localStorage.setItem('items_bundle', JSON.stringify(items_bundle));
                    localStorage.setItem('items_bundle_timestamp', JSON.stringify(items_bundle.timestamp));
                }
                catch (e) {
                    alert('Unable to save to localStorage. Possibly ran out of space.');
                    onFnFailure();
                    return;
                }
                let end1 = Date.now();
                console.log('took '+(end1-start1)+'ms to save to localStorage');
                locked = false;
                onFnSuccess();
            }
            else if (context == 'IndexedDB') {
                let bundle = copyJSON(items_bundle);
                let items = bundle.data;
                delete bundle.data;
                
                console.warn('About to clear localStorage');
                localStorage.clear();
                localStorage.setItem('bundle', JSON.stringify(bundle));
                for (let item of items) {
                    localStorage.setItem(item.id.toString(), JSON.stringify(item));
                }
                localStorage.setItem('items_bundle_timestamp', JSON.stringify(items_bundle.timestamp));
                console.log(summarizeLocalStorage());
                console.log("DONE WITH FULL SAVE IndexedDB");
                locked = false;
                onFnSuccess();
            }
            else if (context == 'server') {
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
                        locked = false;
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
            else {
                alert('Unknown hosting context: ' + context);
            }
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

        if (locked) {
            console.warn('Blocked by lock');
            onFnFailure();
            return;
        }
        locked = true;

        let context = getHostingContext();
        if (context == 'IndexedDB') {
            let items_list = [];
            let items_bundle = {
                "timestamp": Date.now(),
                "data_schema_version": DATA_SCHEMA_VERSION,
                "encryption": {
                    "encrypted": false
                },
                "data": items_list
            };
            for (let i = 0; i < localStorage.length; i++)   {
                let key = localStorage.key(i);
                if (v.isDigit(key)) {
                    let item = localStorage.getItem(key);
                    items_list.push(JSON.parse(item));
                }
                else if (key == 'bundle') {
                    let bundle = localStorage.getItem(key);
                    items_bundle = JSON.parse(bundle);
                }
                else {
                    console.log('*other key ' + key);
                }
            }
            items_bundle['data'] = items_list;
            
            function afterMaybeDecrypt(decryptedBundle) {

                //TODO+ IndexedDB need to add a new bundle if doesn't exist yet
                let items = $schema.checkSchemaUpdate(items_list, decryptedBundle.data_schema_version);
                $model.setItems(items);
                setItemsCache(items);
                $model.setTimestampLastUpdate(decryptedBundle.timestamp);
                console.log('----------------------------------');
                console.log('Updated timestamp to ' + decryptedBundle.timestamp);
                locked = false;
                onFnSuccess();
            }

            if (items_bundle.encryption.encrypted) {
                $unlock.prompt(items_bundle, afterMaybeDecrypt);
            }
            else {
                afterMaybeDecrypt(items_bundle);
            }
        }
        else if (context == 'server') {
            //TODO: handle failure!
            let t1 = Date.now();
            $.ajax({
                url: '/items',
                type: 'get',
                contentType: 'application/json',
                success: function (items_bundle) {
                    let t2 = Date.now();
                    console.log('\tload() round trip took ' + (t2 - t1)+'ms');
                    function afterMaybeDecrypt(decryptedBundle) {
                        let items = $schema.checkSchemaUpdate(decryptedBundle.data, decryptedBundle.data_schema_version);
                        $model.setItems(items);
                        setItemsCache(items);
                        $model.setTimestampLastUpdate(decryptedBundle.timestamp);
                        console.log('----------------------------------');
                        console.log('Updated timestamp to ' + decryptedBundle.timestamp);
                        onFnSuccess();
                    }

                    if (items_bundle.encryption.encrypted) {
                        $unlock.prompt(items_bundle, afterMaybeDecrypt);
                    }
                    else {
                        afterMaybeDecrypt(null, items_bundle);
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
        else if (context == 'localStorage') {

            let items_bundle_txt = localStorage.getItem('items_bundle');
            let items_bundle = null;

            function afterMaybeDecrypt(decryptedBundle) {
                //TODO+: should save items_bundle to localhost if new
                let items = $schema.checkSchemaUpdate(decryptedBundle.data, decryptedBundle.data_schema_version);
                $model.setItems(items);
                setItemsCache(items);
                $model.setTimestampLastUpdate(decryptedBundle.timestamp);
                console.log('----------------------------------');
                console.log('Updated timestamp to ' + decryptedBundle.timestamp);
                onFnSuccess();
            }

            if (items_bundle_txt != null) {
                items_bundle = JSON.parse(items_bundle_txt);
                if (items_bundle.encryption.encrypted) {
                    $unlock.prompt(items_bundle, afterMaybeDecrypt);
                }
                else {
                    afterMaybeDecrypt(null, items_bundle);
                }
            }
            else {
                //create new list
                console.log('Creating new bundle for localStorage');
                let items = [];
                items_bundle = bundleItemsNonEncrypted(items, $model.getTimestampLastUpdate());
                afterMaybeDecrypt(null, items_bundle);
            }
        }
        else {
            alert('Unknown hosting context: ' + context);
        }
    }

    function saveToFileSystem(format, encrypted, passphrase) {
        let items = copyJSON($model.getSortedItems());
        if (format == 'json') {
            items = cleanItemsForSaving(items);
            if (encrypted) {
                saveToFileSystemEncryptedJson(items, passphrase);            }
            else {
                saveToFileSystemUnencryptedJson(items);
            }
        }
        else if (format == 'text') {
            //Do not need to "clean" items here, because we don't need to worry about
            //minimizing their size.
            if (encrypted) {
                alert('This should never be allowed');
            }
            else {
                saveToFileSystemUnencryptedText(items);
            }
        }
        else {
            alert('Warning: unknown format');
        }
    }

    function decryptItemsBundle(encryptedBundle, passphrase, success, failure) {
        if (encryptedBundle.encryption.encryption_granularity == 'full') {
            let iv = [];
            for (let i = 0; i < 12; i++) { //TODO: don't hardcode this here
                iv.push(encryptedBundle.encryption.iv[i]);
            }
            let buff_iv = new Uint8Array(iv);
            let encryptedText = encryptedBundle.data;
            let buff = hexToBuffer(encryptedText);
            let digest = encryptedBundle.encryption.digest;
            let alg_name = encryptedBundle.encryption.alg;
            decryptText(buff, buff_iv, digest, alg_name, passphrase).then(function(result) {
                let decryptedBundle = copyJSON(encryptedBundle);
                decryptedBundle.data = JSON.parse(result);
                decryptedBundle.encryption.encrypted = false;
                delete decryptedBundle.encryption.encryption_scheme_version;
                delete decryptedBundle.encryption.encryption_granularity;
                delete decryptedBundle.encryption.digest;
                delete decryptedBundle.encryption.alg;
                delete decryptedBundle.encryption.iv;
                success(passphrase, decryptedBundle);
            })
            .catch(function(err) {
                console.log('ERROR: ' + err);
                failure();
            });
        }
        else if (encryptedBundle.encryption.encryption_granularity == 'per-item') {
            (async () => {
                try {
                    let t1 = Date.now();
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
                    let t2 = Date.now();
                    console.log('decrypting all items took '+(t2-t1)+'ms');
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
        else {
            alert('Unknown encryption strategy ' + encryptedBundle.encryption.encryption_granularity)
        }
    }

    function decryptFromFileObject(passphrase, obj, success, failure) {
        if (obj.encryption.encryption_granularity == 'full') {
            let iv = [];
            for (let i = 0; i < 12; i++) { //TODO: don't hardcode this here
                iv.push(obj.encryption.iv[i]);
            }
            let buff_iv = new Uint8Array(iv);
            decryptText(hexToBuffer(obj.data), buff_iv, obj.encryption.digest, obj.encryption.alg, passphrase).then(function(result) {
                let items = JSON.parse(result);
                success(items);
            })
            .catch(function(err) {
                failure();
            });
        }
        else if (obj.encryption.encryption_granularity == 'per-item') {
            (async () => {
                let t1 = Date.now();
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
                let t2 = Date.now();
                console.log('decrypting all items took '+(t2-t1)+'ms');
                success(items);
            })();
        }
        else {
            alert('Unknown encryption strategy: ' + obj.encryption.encryption_granularity);
        }
    }

    return {
        saveToHostFull: saveToHostFull,
        saveToHostOnIdle: saveToHostOnIdle,
        loadFromHost: loadFromHost,
        maybeShouldReload: maybeShouldReload,
        decryptFromFileObject: decryptFromFileObject,
        saveToFileSystem: saveToFileSystem,
        decryptItemsBundle: decryptItemsBundle,
        setItemsCache: setItemsCache
    };
})();
