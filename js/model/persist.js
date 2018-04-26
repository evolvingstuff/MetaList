"use strict";
var $persist = (function () {
    var SAVE_TO_LOCALSTORAGE = true;
    var SAVE_TO_DATABASE = true;
    var LOAD_FROM_LOCALSTORAGE = true;
    var LOAD_FROM_DATABASE = false;
    var lastLoad = Date.now();
    function maybeReload() {
        var prev_txt = localStorage.getItem('items');
        var txt = JSON.stringify($model.getItems());
        var lastSave = localStorage.getItem('lastSave');
        if (lastSave != null && parseInt(lastSave) > lastLoad && txt != prev_txt) {
            console.log('RELOAD!');
            return true;
        }
        else {
            return false;
        }
    }
    function save() {
        //console.log('save()');
        lastLoad = Date.now();
        localStorage.setItem('lastSave', Date.now() + '');
        calculatePriorityToPrevNext();
        if (SAVE_TO_LOCALSTORAGE) {
            var older = localStorage.getItem('items');
            var newer = JSON.stringify($model.getItems());
            if (older != newer) {
                //console.log('\tDEBUG: save() UPDATED');
            }
            else {
                //console.log('\tDEBUG: save() old same as new?');
            }
            localStorage.setItem('items', JSON.stringify($model.getItems()));
        }
        if (SAVE_TO_DATABASE) {
            $db.maybePushTo($model.getItems());
        }
        //console.log('/save()');
    }
    function load() {
        lastLoad = Date.now();
        if (LOAD_FROM_LOCALSTORAGE) {
            //console.log('$persist.load() [localStorage]');
            var txt = localStorage.getItem('items');
            if (txt != null && txt != '') {
                $model.setItems(JSON.parse(txt));
            }
        }
        if (LOAD_FROM_DATABASE) {
            //console.log('$persist.load() [database]');
            alert("loading from database not implemented!");
            return false;
        }
        calculatePrevNextToPriority();
        return true;
    }
    function calculatePriorityToPrevNext() {
        if ($model.getItems().length == 0) {
            return;
        }
        $model.getItems().sort(function (a, b) {
            if (a.priority < b.priority) {
                return -1;
            }
            if (a.priority > b.priority) {
                return 1;
            }
            return 0;
        });
        $model.getItems()[0].prev = null;
        for (var i = 1; i < $model.getItems().length; i++) {
            $model.getItems()[i - 1].next = $model.getItems()[i].id;
            $model.getItems()[i].prev = $model.getItems()[i - 1].id;
            //delete items[i].priority; TODO: this screws things up currently
        }
        $model.getItems()[$model.getItems().length - 1].next = null;
    }
    function calculatePrevNextToPriority() {
        if ($model.getItems().length == 0) {
            return;
        }
        var first_item = null;
        var pointers = {};
        for (var i = 0; i < $model.getItems().length; i++) {
            $model.getItems().priority = null; //set/reset
            pointers[$model.getItems()[i].id] = $model.getItems()[i];
            if ($model.getItems()[i].prev == null) {
                if (first_item != null) {
                    alert("WARNING: expected only one items with prev == null. Aborting.");
                    return;
                }
                first_item = $model.getItems()[i];
            }
        }
        var priority = 1;
        var item = first_item;
        while (true) {
            item.priority = priority++;
            if (item.next != null) {
                item = pointers[item.next];
            }
            else {
                break;
            }
        }
        $model.getItems().sort(function (a, b) {
            if (a.priority < b.priority) {
                return -1;
            }
            if (a.priority > b.priority) {
                return 1;
            }
            throw "ERROR: priorities are the same?";
        });
    }
    function saveToFileSystem() {
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
            var blob = new Blob([data], { type: 'text/json' }), e = document.createEvent('MouseEvents'), a = document.createElement('a');
            a.download = filename;
            a.href = window.URL.createObjectURL(blob);
            a.dataset.downloadurl = ['text/json', a.download, a.href].join(':');
            e.initMouseEvent('click', true, false, window, 0, 0, 0, 0, 0, false, false, false, false, 0, null);
            a.dispatchEvent(e);
        }
        var filename = 'backup.' + (Date.now()) + '.json';
        fileSave($model.getItems(), filename);
    }
    return {
        save: save,
        load: load,
        saveToFileSystem: saveToFileSystem,
        maybeReload: maybeReload
    };
})();
