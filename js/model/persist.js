"use strict";

let $persist = (function () {

    const ENCRYPTION_SCHEME_VERSION = 1;
    const ENCRYPTION_GRANULARITY_LOCALSTORAGE = 'per-item'; // per-item | full
    const ENCRYPTION_GRANULARITY_SERVER = 'per-item'; // per-item | full
    const ENCRYPTION_GRANULARITY_FILE = 'per-item'; // per-item | full

    let itemsCache = null;

    let locked = false;

    function setLocked(val) {
        locked = val;
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
        return items;
    }

    function cleanedItemsCopy(items) {

        //TODO: this could be made more efficient
        let cleaned = JSON.stringify(items, function(key, value) {
            if (key.charAt(0) == '_') {
                return undefined;
            }
            return value;
        });
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
        
        let context = getHostingContext();
        let encryption_granularity = null;
        if (context == 'localStorage') {
            encryption_granularity = ENCRYPTION_GRANULARITY_LOCALSTORAGE;
        }
        else if (context == 'server') {
            encryption_granularity = ENCRYPTION_GRANULARITY_SERVER;
        }
        else {
            alert('Unknown hosting context ' + context);
            return;
        }

        if (encryption_granularity == 'full') {
            let text = JSON.stringify(decryptedBundle.data);
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
                after(encryptedBundle);
            });
        }
        else if (encryption_granularity == 'per-item') {
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
        let context = getHostingContext();
        let encryption_granularity = ENCRYPTION_GRANULARITY_FILE;
        if (encryption_granularity == 'full') {
            let items_str = JSON.stringify(items);
            function after(result) {
                let hex = bufferToHex(result.encBuffer);

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

        let context = getHostingContext();
        if (context == 'localStorage') {
            if (ENCRYPTION_GRANULARITY_LOCALSTORAGE == 'full') {
                saveToHostFull(onFnSuccess, onFnFailure);
            }
            else if (ENCRYPTION_GRANULARITY_LOCALSTORAGE == 'per-item') {
                saveToHostDiff(onFnSuccess, onFnFailure);
            }
            else {
                alert('Unknown encryption granularity ' + ENCRYPTION_GRANULARITY_LOCALSTORAGE);
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

        $simpleLock.updateToken();

        if (locked) {
            console.warn('Blocked by lock @ saveToHostDiff()');
            onFnFailure();
            return;
        }
        setLocked(true);

        if (onFnSuccess == undefined) {
            throw "Expected a valid success callback function here";
        }
        if (onFnFailure == undefined) {
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
            if (itemsCacheMap[item.id] == undefined) {
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
                else if (item2.prev != item1.prev || 
                         item2.next != item1.next) {
                    diffs.updated.push(copyJSON(item2));
                    count += 1;
                }
                else if (item2.collapse != item1.collapse) {
                    diffs.updated.push(copyJSON(item2));
                    count += 1;
                }
            }
        }

        for (let key of Object.keys(itemsCacheMap)) {
            let item = itemsCacheMap[key];
            if (map[item.id] == undefined) {
                diffs.deleted.push({ id: item.id });
                count += 1;
            }
        }

        itemsCache = cleaned;

        /////////////////////////////////////////////////////////////////////////
        /////////////////////////////////////////////////////////////////////////
        /////////////////////////////////////////////////////////////////////////

        function afterMaybeEncryptDiffs(diffs) {

            let context = getHostingContext();
            if (context == 'localStorage') {

                let mapUpdated = {};
                let mapAdded = {};
                let keysDeleted = [];

                for (let item of diffs.updated) {
                    localStorage.setItem(item.id.toString(), JSON.stringify(item));
                }
                for (let item of diffs.added) {
                    localStorage.setItem(item.id.toString(), JSON.stringify(item));
                }
                for (let item of diffs.deleted) {
                    localStorage.removeItem(item.id.toString());
                }

                let debugSummary = summarizeLocalStorage();
                
                if (debugSummary.totalItems != cleaned.length) {
                    throw "Mismatch " + debugSummary.totalItems + " total items in LS vs expected " + cleaned.length;
                }
                setLocked(false);
                onFnSuccess();
            }
            else if (context == 'server') {
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

    function deleteEverything(onFnSuccess, onFnFailure) {
        if (locked) {
            console.warn('Blocked by lock @ saveToHostFull()');
            onFnFailure();
            return;
        }
        setLocked(true);

        if (onFnSuccess == undefined) {
            throw "Expected a valid success callback function here";
        }
        if (onFnFailure == undefined) {
            throw "Expected a valid failure callback function here";
        }

        let context = getHostingContext();
        if (context == 'localStorage') {
            let blankBundle = bundleItemsNonEncrypted([], Date.now());
            delete blankBundle.data;
            localStorage.clear();
            localStorage.setItem('bundle', JSON.stringify(blankBundle));
            localStorage.setItem('items_bundle_timestamp', JSON.stringify(blankBundle.timestamp));
            setLocked(false);
            onFnSuccess();
        }
        else if (context == 'server') {
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
        else {
            alert('Unknown hosting context: ' + context);
        }
    }

    function saveToHostFull(onFnSuccess, onFnFailure) {

        $simpleLock.updateToken();

        if (locked) {
            console.warn('Blocked by lock @ saveToHostFull()');
            onFnFailure();
            return;
        }
        setLocked(true);

        if (onFnSuccess == undefined) {
            throw "Expected a valid success callback function here";
        }
        if (onFnFailure == undefined) {
            throw "Expected a valid failure callback function here";
        }

        let items_bundle = null;
        const items_ = $model.getSortedItems();
        let cleaned = cleanedItemsCopy(items_);
        
        items_bundle = bundleItemsNonEncrypted(cleaned, $model.getTimestampLastUpdate());

        function afterMaybeEncrypt(items_bundle) {
            let context = getHostingContext();
            if (context == 'localStorage') {
                let bundle = copyJSON(items_bundle);
                let items = bundle.data;
                delete bundle.data;
                
                localStorage.clear();
                localStorage.setItem('bundle', JSON.stringify(bundle));
                for (let item of items) {
                    localStorage.setItem(item.id.toString(), JSON.stringify(item));
                }
                localStorage.setItem('items_bundle_timestamp', JSON.stringify(items_bundle.timestamp));
                setLocked(false);
                onFnSuccess();
            }
            else if (context == 'server') {
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

        $simpleLock.getToken();

        if (locked) {
            console.warn('Blocked by lock');
            onFnFailure();
            return;
        }
        setLocked(true);

        let context = getHostingContext();
        if (context == 'localStorage') {
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
            }
            items_bundle['data'] = items_list;
            
            function afterMaybeDecrypt(decryptedBundle) {

                let summary = summarizeLocalStorage();
                if (summary.hasBundle == false) {
                    console.warn('No bundle in localStorage');
                }

                let items = $schema.checkSchemaUpdate(items_list, decryptedBundle.data_schema_version);
                $model.setItems(items);
                setItemsCache(items);
                $model.setTimestampLastUpdate(decryptedBundle.timestamp);
                setLocked(false);
                onFnSuccess();
            }

            if (items_bundle.encryption.encrypted) {
                setLocked(false);
                $unlock.prompt(items_bundle, afterMaybeDecrypt);
            }
            else {
                afterMaybeDecrypt(items_bundle);
            }
        }
        else if (context == 'server') {
            //TODO: handle failure!
            $.ajax({
                url: '/items',
                type: 'get',
                contentType: 'application/json',
                success: function (items_bundle) {

                    function afterMaybeDecrypt(decryptedBundle) {
                        let items = $schema.checkSchemaUpdate(decryptedBundle.data, decryptedBundle.data_schema_version);
                        $model.setItems(items);
                        setItemsCache(items);
                        $model.setTimestampLastUpdate(decryptedBundle.timestamp);
                        setLocked(false);
                        onFnSuccess();
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
                console.error('ERROR: ' + err);
                failure();
            });
        }
        else if (encryptedBundle.encryption.encryption_granularity == 'per-item') {
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
        setItemsCache: setItemsCache,
        deleteEverything: deleteEverything
    };
})();
