"use strict";
var $db = (function () {
    var cache_prev_items_pushed = null;
    var cache_prev_ids = null;
    var APPLY_CRYPTO = false;
    var PASSWORD = 'password';
    var USE_SERVER = false;
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
        var start = Date.now();
        if (cache_prev_items_pushed == null) {
            cache_prev_items_pushed = {};
            cache_prev_ids = new Set();
            for (var i = 0; i < items.length; i++) {
                var item_copy = cloneItem(items[i]);
                cache_prev_items_pushed[item_copy.id] = item_copy;
                if (cache_prev_ids.has(item_copy.id)) {
                    throw "ERROR: duplicate ids?";
                }
                cache_prev_ids.add(item_copy.id);
                if (APPLY_CRYPTO) {
                    //console.log('\t\tencrypting...');
                    var encrypted = sjcl.encrypt(PASSWORD, JSON.stringify(item_copy));
                    //console.log('\t\t' + encrypted);
                    var decrypted = sjcl.decrypt(PASSWORD, encrypted);
                    //console.log('\t\t' + decrypted);
                }
            }
        }
        else {
            //look for deleted items
            var new_ids = new Set();
            for (var i = 0; i < items.length; i++) {
                var id = items[i].id;
                if (new_ids.has(id)) {
                    throw "ERROR: dup id in new data";
                }
                new_ids.add(id);
            }
            for (var i = 0; i < items.length; i++) {
                var item_copy = cloneItem(items[i]);
                if (cache_prev_ids.has(items[i].id)) {
                    //check for update
                    if (JSON.stringify(cache_prev_items_pushed[item_copy.id]) != JSON.stringify(item_copy)) {
                        cache_prev_items_pushed[item_copy.id] = item_copy;
                        if (APPLY_CRYPTO) {
                            //console.log('\t\tencrypting...');
                            var encrypted = sjcl.encrypt(PASSWORD, JSON.stringify(item_copy));
                            //console.log('\t\t' + encrypted);
                            var decrypted = sjcl.decrypt(PASSWORD, encrypted);
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
                        var encrypted = sjcl.encrypt(PASSWORD, JSON.stringify(item_copy));
                        //console.log('\t\t' + encrypted);
                        var decrypted = sjcl.decrypt(PASSWORD, encrypted);
                        //console.log('\t\t' + decrypted);
                    }
                }
            }
            var to_delete = [];
            for (var id in cache_prev_items_pushed) {
                if (new_ids.has(parseInt(id)) == false) {
                    to_delete.push(id);
                }
            }
            for (var i = 0; i < to_delete.length; i++) {
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
        var end = Date.now();
        if (USE_SERVER) {
            var data = {
                id: items[0].id,
                data: JSON.stringify(items[0])
            };
            var start_1 = Date.now();
            $.ajax({
                type: 'POST',
                url: '/updates',
                contentType: 'application/json; charset=utf-8',
                success: function (msg) {
                    var end = Date.now();
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
