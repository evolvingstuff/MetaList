"use strict";

let _last_update_any_item = Date.now();

var $model = (function () {
    var items = [];
    var item_cache = {};
    var META_EXAMPLE = META_COMMENT_PREFIX + ' specific => general';
    var DEFAULT_NEW_TEXT_META_ITEM = META_EXAMPLE;
    var DEFAULT_NEW_TEXT_META_SUBITEM = META_EXAMPLE;

    function _generalUpdate(item) {
        if (item != null) {
            item._dirty_tags = true;
            item._last_update = Date.now();
            _last_update_any_item = Date.now();
        }
    }
    
    function enumerate(subitem) {
        var result = [];
        result.push(subitem);
        if (subitem.subitems != undefined || subitem.subitems != null || subitem.subitems.length > 0) {
            for (var i = 0; i < subitem.subitems.length; i++) {
                result = result.concat(enumerate(subitem.subitems[i]));
            }
        }
        return result;
    }

    //This gets all tags along a particular branch
    function getBranchTags(item, subitem_path) {
        var _get = function (subitem, path) {
            var tags = '';
            if (subitem.tags != undefined && subitem.tags != null) {
                tags = subitem.tags.trim();
            }
            if (path == null || path == '') {
                return tags;
            }
            else {
                var sub_index = parseInt(path.split('/')[0]);
                var remaining_path = path.split('/').slice(1).join('/');
                var result = tags + ' ' + _get(subitem.subitems[sub_index], remaining_path);
                return result;
            }
        };
        return _get(item, subitem_path).trim();
    }

    //This gets ALL tags for item, including all subitems
    function getItemTags(item) {
        var _get = function (subitem) {
            var result = '';
            if (subitem.tags != undefined && subitem.tags != null) {
                result += subitem.tags + ' ';
            }
            for (var i = 0; i < subitem.subitems.length; i++) {
                result += _get(subitem.subitems[i]);
            }
            return result;
        };
        return _get(item).trim();
    }
    
    //This gets tags at just leaf node
    function getSubItemTags(item, subitem_path) {
        if (subitem_path == undefined || subitem_path == null || subitem_path == '') {
            return item.tags;
        }
        else {
            var subitem = getSubitem(item.id, subitem_path);
            if (subitem.tags == undefined || subitem.tags == null) {
                subitem.tags = '';
            }
            return subitem.tags;
        }
    }

    function getItems() {
        return items;
    }

    function setItems(new_items) {
        items = new_items;
        item_cache = {};
        _generalUpdate();
    }

    function getItemText(item) {
        if (item.subitems.length == 0) {
            return item.data;
        }
        else {
            var result = item.data;
            for (var i = 0; i < item.subitems.length; i++) {
                result += ' ' + getItemText(item.subitems[i]);
            }
            return result;
        }
    }

    function getNewId() {
        var maxId = 0;
        for (var i = 0; i < items.length; i++) {
            if (items[i].id > maxId) {
                maxId = items[i].id;
            }
        }
        return maxId + 1;
    }

    function addItem(tags) {
        var priority = 1;
        
        //find first included item, if any
        for (let item of $model.getItems()) {
            if (item._include == 1 && item.priority < priority) {
                priority = item.priority;
            }
        }

        for (var i = 0; i < items.length; i++) {
            if (items[i].priority >= priority) {
                items[i].priority++;
            }
        }

        var new_item = {
            'id': getNewId(),
            'priority': priority,
            'data': '',
            'timestamp': Date.now(),
            'tags': tags,
            'subitems': [],
            '_include': 1
        };

        $search2.decorateItemTags(new_item);

        items.push(new_item);

        _generalUpdate(new_item);

        return new_item.id;
    }
    function addNextItem(selectedItemId) {
        var item = getItemById(selectedItemId);
        for (var i = 0; i < items.length; i++) {
            if (items[i].priority > item.priority) {
                items[i].priority++;
            }
        }
        var new_item = {
            'id': getNewId(),
            'priority': item.priority + 1,
            'data': '',
            'timestamp': Date.now(),
            'tags': item.tags,
            'subitems': []
        };
        
        $search2.decorateItemTags(new_item);

        items.push(new_item);

        _generalUpdate(new_item);

        return new_item.id;
    }
    function deleteItem(id) {
        var item = getItemById(id);
        var index = -1;
        for (var i = 0; i < items.length; i++) {
            if (items[i].priority > item.priority) {
                items[i].priority--;
            }
            if (items[i].id == id) {
                index = i;
            }
        }
        items.splice(index, 1);
        //console.log('$model.js: deleting from item_cache['+id+']');
        delete item_cache[id];
        _generalUpdate(null);
    }
    function getItemById(id) {
        if (item_cache[id] !== undefined) {
            return item_cache[id];
        }
        else {
            for (var i = 0; i < items.length; i++) {
                item_cache[items[i].id] = items[i];
                if (items[i].id == id) {
                    break;
                }
            }
            if (item_cache[id] !== undefined) {
                return item_cache[id];
            }
            else {
                return null;
            }
        }
    }
    
    function getSubitem(id, path) {
        var _get = function (subitem, path) {
            if (path == null || path == '') {
                return null;
            }
            var parts = path.split('/');
            var index = parseInt(parts[0]);
            if (parts.length == 1) {
                return subitem.subitems[index];
            }
            else {
                var remaining = parts.slice(1);
                return _get(subitem.subitems[index], remaining.join('/'));
            }
        };
        var item = getItemById(id);
        return _get(item, path);
    }

    function drag(id1, id2) {
        if (id1 == id2) {
            return;
        }
        var item1 = getItemById(id1);
        var item2 = getItemById(id2);
        if (item1.priority < item2.priority) {
            dragDown(id1, id2);
        }
        else {
            dragUp(id1, id2);
        }
    }

    function dragDown(id1, id2) {
        var item1 = getItemById(id1);
        var item2 = getItemById(id2);
        var item1Priority = item1.priority;
        var item2Priority = item2.priority;
        for (var i = 0; i < items.length; i++) {
            if (items[i].priority <= item1Priority || items[i].priority > item2Priority) {
                continue;
            }
            items[i].priority--;
        }
        item1.priority = item2Priority;
    }

    function dragUp(id1, id2) {
        var item1 = getItemById(id1);
        var item2 = getItemById(id2);
        var item1Priority = item1.priority;
        var item2Priority = item2.priority;
        for (var i = 0; i < items.length; i++) {
            if (items[i].priority >= item1Priority || items[i].priority < item2Priority) {
                continue;
            }
            items[i].priority++;
        }
        //update after
        item1.priority = item2Priority;
    }

    function moveDown(id) {
        var selected_item = getItemById(id);
        //get next visible item below
        var closest_selected_below = null;
        for (var i = 0; i < items.length; i++) {
            if (items[i]._include == -1) {
                continue;
            }
            if (items[i].priority > selected_item.priority && (closest_selected_below == null || items[i].priority < closest_selected_below)) {
                closest_selected_below = items[i].priority;
            }
        }
        if (closest_selected_below == null) {
            return;
        }
        for (var i = 0; i < items.length; i++) {
            if (items[i].priority < selected_item.priority) {
                //do nothing
            }
            else if (items[i].id == id) {
                //skip for now, update after
            }
            else if (items[i].priority > closest_selected_below) {
                //also do nothing
            }
            else {
                items[i].priority--;
            }
        }
        //update after
        selected_item.priority = closest_selected_below;
    }

    function moveUp(id) {
        var selected_item = getItemById(id);
        //get next visible item below
        var closest_selected_above = null;
        for (var i = 0; i < items.length; i++) {
            if (items[i]._include == -1) {
                continue;
            }
            if (items[i].priority < selected_item.priority && (closest_selected_above == null || items[i].priority > closest_selected_above)) {
                closest_selected_above = items[i].priority;
            }
        }
        if (closest_selected_above == null) {
            return;
        }
        for (var i = 0; i < items.length; i++) {
            if (items[i].priority > selected_item.priority) {
                //do nothing
            }
            else if (items[i].id == id) {
                //skip for now, update after
            }
            else if (items[i].priority < closest_selected_above) {
                //also do nothing
            }
            else {
                items[i].priority++;
            }
        }
        //update after
        selected_item.priority = closest_selected_above;
    }

    function updateTimestamp(selectedItemId, timestamp) {
        var item = getItemById(selectedItemId);
        item.timestamp = timestamp;
        _generalUpdate(item);
    }
    function updateData(selectedItemId, text) {
        var item = getItemById(selectedItemId);
        item.data = text;
        _generalUpdate(item);
    }
    function updateTag(selectedItemId, text) {
        var item = $model.getItemById(selectedItemId);
        item.tags = text;
        _generalUpdate(item);
    }
    function updateSubTag(selectedItemId, path, text) {
        var subitem = getSubitem(selectedItemId, path);
        subitem.tags = text;
        var item = $model.getItemById(selectedItemId);
        _generalUpdate(item);
    }
    
    //////////////////////////////////////////////////
    //subitems
    function addSubItem(id, path) {
        var item = getItemById(id);
        let result = _addSubItem(item, path);
        _generalUpdate(item);
        return result;
    }
    function _addSubItem(item, path) {
        if (path == null) {
            var subitem = { data: '', subitems: [], tags: '', _include: 1 };
            item.subitems.splice(0, 0, subitem);
            return '0';
        }
        else {
            var parts = ('' + path).split('/');
            var first = null;
            var rest = null;
            if (parts.length == 1) {
                first = parts[0];
            }
            else {
                first = parts.shift();
                rest = parts.join('/');
            }
            return first + '/' + _addSubItem(item.subitems[first], rest);
        }
    }
    function addNextSubItem(id, path) {
        function _addNextSubItem(parent, path) {
            //console.log('_addNextSubItem('+path+')');
            var parts = ('' + path).split('/');
            var first = null;
            if (parts.length == 1) {
                var nfirst = parseInt(parts[0]);
                var sibling = parent.subitems[nfirst];
                var next = nfirst + 1;
                parent.subitems.splice(next, 0, { data: '', subitems: [], tags: '', _include:1 });
                return '' + next;
            }
            else {
                first = parts.shift();
                var rest = parts.join('/');
                return first + '/' + _addNextSubItem(parent.subitems[first], rest);
            }
        }
        var item = getItemById(id);
        let result = _addNextSubItem(item, path);
        _generalUpdate(item);
        return result;
    }
    function removeSubItem(id, index) {
        function _removeSubItem(item, path) {
            var parts = ('' + path).split('/');
            var first = null;
            var rest = null;
            if (parts.length == 1) {
                var nfirst = parseInt(parts[0]);
                item.subitems.splice(nfirst, 1);
            }
            else {
                first = parts.shift();
                rest = parts.join('/');
                _removeSubItem(item.subitems[first], rest);
            }
        }
        var item = getItemById(id);
        _removeSubItem(item, index);
        _generalUpdate(item);
    }
    function moveUpSubitem(selectedItemId, selectedSubitemIndex) {
        function _moveUpSubItem(item, path) {
            var parts = ('' + path).split('/');
            var first = null;
            var rest = null;
            if (parts.length == 1) {
                var nfirst = parseInt(parts[0]);
                if (nfirst == 0) {
                    return '' + nfirst;
                }
                var temp = item.subitems[nfirst - 1];
                item.subitems[nfirst - 1] = item.subitems[nfirst];
                item.subitems[nfirst] = temp;
                return '' + (nfirst - 1);
            }
            else {
                first = parts.shift();
                rest = parts.join('/');
                rest = _moveUpSubItem(item.subitems[first], rest);
                return first + '/' + rest;
            }
        }
        var item = getItemById(selectedItemId);
        var newpath = _moveUpSubItem(item, selectedSubitemIndex);
        return newpath;
    }
    function moveDownSubitem(selectedItemId, selectedSubitemIndex) {
        function _moveDownSubItem(item, path) {
            //console.log('_moveDownSubItem('+path+')');
            var parts = ('' + path).split('/');
            var first = null;
            var rest = null;
            if (parts.length == 1) {
                var nfirst = parseInt(parts[0]);
                if (nfirst >= item.subitems.length - 1) {
                    return '' + nfirst;
                }
                var temp = item.subitems[nfirst + 1];
                item.subitems[nfirst + 1] = item.subitems[nfirst];
                item.subitems[nfirst] = temp;
                return '' + (nfirst + 1);
            }
            else {
                first = parts.shift();
                rest = parts.join('/');
                rest = _moveDownSubItem(item.subitems[first], rest);
                return first + '/' + rest;
            }
        }
        var item = getItemById(selectedItemId);
        var newpath = _moveDownSubItem(item, selectedSubitemIndex);
        return newpath;
    }
    function updateSubitemData(selectedItemId, selectedSubitemIndex, text) {
        function _updateSubItemData(item, path, text) {
            //console.log('_updateSubItemData('+path+')');
            var parts = ('' + path).split('/');
            var first = null;
            var rest = null;
            if (parts.length == 1) {
                first = parts[0];
                if (text != item.subitems[first].data) {
                    item.subitems[first].data = text;
                }
                else {
                    //console.log('no update?');
                }
            }
            else {
                first = parts.shift();
                rest = parts.join('/');
                _updateSubItemData(item.subitems[first], rest, text);
            }
        }
        var item = getItemById(selectedItemId);
        _updateSubItemData(item, selectedSubitemIndex, text);
        _generalUpdate(item);
    }

    /*
    function getQuickHash() {
        let s = '';
        for (let item of items) {
            if (item._last_update == undefined) {
                item._last_update = Date.now();
            }
            s += item._last_update + '/' + item.id;
        }
        return hashCode(s);
    }
    */

    function getEnrichedAndSortedTagList(filtered_items) {
        //TODO: this is slow and should be sped up
        if (filtered_items.length == 0) {
            filtered_items = $model.getItems();
        }
        var all_tags = {};
        //var all_priorities = {};
        for (var i = 0; i < filtered_items.length; i++) {
            var tags = $ontology.getEnrichedTags($model.getItemTags(filtered_items[i]));
            for (var t = 0; t < tags.length; t++) {
                var tag = tags[t].trim();
                if (all_tags[tag] != undefined) {
                    all_tags[tag] += 1;
                }
                else {
                    all_tags[tag] = 1;
                }
            }
        }
        var list = [];
        for (var key in all_tags) {
            list.push({ 'tag': key, 'count': all_tags[key]});
        }
        list.sort(function (a, b) {
            if (a.count < b.count) {
                return -1;
            }
            if (a.count > b.count) {
                return 1;
            }
            return b.tag.localeCompare(a.tag);
            ;
        });
        list.reverse();
        return list;
    }

    return {
        getItems: getItems,
        setItems: setItems,
        getItemById: getItemById,
        getSubitem: getSubitem,
        addItem: addItem,
        addSubItem: addSubItem,
        addNextItem: addNextItem,
        addNextSubItem: addNextSubItem,
        deleteItem: deleteItem,
        removeSubItem: removeSubItem,
        moveUp: moveUp,
        moveUpSubitem: moveUpSubitem,
        moveDown: moveDown,
        moveDownSubitem: moveDownSubitem,
        updateData: updateData,
        updateTimestamp: updateTimestamp,
        updateSubitemData: updateSubitemData,
        updateTag: updateTag,
        updateSubTag: updateSubTag,
        drag: drag,
        getItemText: getItemText,
        getItemTags: getItemTags,
        getSubItemTags: getSubItemTags,
        getBranchTags: getBranchTags,
        enumerate: enumerate,
        getEnrichedAndSortedTagList, getEnrichedAndSortedTagList
    };
})();
