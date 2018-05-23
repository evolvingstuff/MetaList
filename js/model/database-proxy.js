"use strict";
let $db = (function () {
    let cache_prev_items_pushed = null;
    let cache_prev_ids = null;
    let APPLY_CRYPTO = false;
    let PASSWORD = 'password';
    let USE_SERVER = false;
    function maybePushTo(items) {
        function removeItemDecorations(item) {
            if (item.priority != undefined) {
                delete item.priority;
            }
            return item;
        }
        function cloneItem(item) {
            return removeItemDecorations(JSON.parse(JSON.stringify(item)));
        }
        let start = Date.now();
        if (cache_prev_items_pushed == null) {
            cache_prev_items_pushed = {};
            cache_prev_ids = new Set();
            for (let i = 0; i < items.length; i++) {
                let item_copy = cloneItem(items[i]);
                cache_prev_items_pushed[item_copy.id] = item_copy;
                if (cache_prev_ids.has(item_copy.id)) {
                    throw "ERROR: duplicate ids?";
                }
                cache_prev_ids.add(item_copy.id);
                if (APPLY_CRYPTO) {
                    //console.log('\t\tencrypting...');
                    let encrypted = sjcl.encrypt(PASSWORD, JSON.stringify(item_copy));
                    //console.log('\t\t' + encrypted);
                    let decrypted = sjcl.decrypt(PASSWORD, encrypted);
                    //console.log('\t\t' + decrypted);
                }
            }
        }
        else {
            //look for deleted items
            let new_ids = new Set();
            for (let i = 0; i < items.length; i++) {
                let id = items[i].id;
                if (new_ids.has(id)) {
                    throw "ERROR: dup id in new data";
                }
                new_ids.add(id);
            }
            for (let i = 0; i < items.length; i++) {
                let item_copy = cloneItem(items[i]);
                if (cache_prev_ids.has(items[i].id)) {
                    //check for update
                    if (JSON.stringify(cache_prev_items_pushed[item_copy.id]) != JSON.stringify(item_copy)) {
                        cache_prev_items_pushed[item_copy.id] = item_copy;
                        if (APPLY_CRYPTO) {
                            //console.log('\t\tencrypting...');
                            let encrypted = sjcl.encrypt(PASSWORD, JSON.stringify(item_copy));
                            //console.log('\t\t' + encrypted);
                            let decrypted = sjcl.decrypt(PASSWORD, encrypted);
                            //console.log('\t\t' + decrypted);
                        }
                    }
                }
                else {
                    //insert new
                    cache_prev_items_pushed[item_copy.id] = item_copy;
                    cache_prev_ids.add(item_copy.id);
                    if (APPLY_CRYPTO) {
                        //console.log('\t\tencrypting...');
                        let encrypted = sjcl.encrypt(PASSWORD, JSON.stringify(item_copy));
                        //console.log('\t\t' + encrypted);
                        let decrypted = sjcl.decrypt(PASSWORD, encrypted);
                        //console.log('\t\t' + decrypted);
                    }
                }
            }
            let to_delete = [];
            for (let id in cache_prev_items_pushed) {
                if (new_ids.has(parseInt(id)) == false) {
                    to_delete.push(id);
                }
            }
            for (let i = 0; i < to_delete.length; i++) {
                cache_prev_ids.delete(parseInt(to_delete[i]));
                delete cache_prev_items_pushed[to_delete[i]];
            }
            if (Object.keys(cache_prev_items_pushed).length != cache_prev_ids.size) {
                throw "ERROR: inconsistent cache: length = " + Object.keys(cache_prev_items_pushed).length + " / size = " + cache_prev_ids.size;
            }
            if (cache_prev_ids.size != items.length) {
                throw "ERROR: inconsistent between items[] and db cache";
            }
        }
        let end = Date.now();
        if (USE_SERVER) {
            let data = {
                id: items[0].id,
                data: JSON.stringify(items[0])
            };
            let start_1 = Date.now();
            $.ajax({
                type: 'POST',
                url: '/updates',
                contentType: 'application/json; charset=utf-8',
                success: function (msg) {
                    let end = Date.now();
                },
                data: JSON.stringify(data)
            });
        }
    }
    function pullFrom() {
        //TODO
        return null;
    }
    return {
        maybePushTo: maybePushTo,
        pullFrom: pullFrom
    };
})();
