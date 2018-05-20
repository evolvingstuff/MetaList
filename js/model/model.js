"use strict";

let $model = (function () {

    let items = [];
    let item_cache = {};
    let META_EXAMPLE = META_COMMENT_PREFIX + ' specific => general';
    let DEFAULT_NEW_TEXT_META_ITEM = META_EXAMPLE;
    let DEFAULT_NEW_TEXT_META_SUBITEM = META_EXAMPLE;

    let _immutable_items = null;
    
    function enumerate(subitem) {
        let result = [];
        result.push(subitem);
        if (subitem.subitems != undefined || subitem.subitems != null || subitem.subitems.length > 0) {
            for (let i = 0; i < subitem.subitems.length; i++) {
                result = result.concat(enumerate(subitem.subitems[i]));
            }
        }
        return result;
    }

    //This gets ALL tags for item, including all subitems
    function getItemTags(item) {
        let _get = function (subitem) {
            let result = '';
            if (subitem.tags != undefined && subitem.tags != null) {
                result += subitem.tags + ' ';
            }
            for (let i = 0; i < subitem.subitems.length; i++) {
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
            let subitem = getSubitem(item.id, subitem_path);
            if (subitem.tags == undefined || subitem.tags == null) {
                subitem.tags = '';
            }
            return subitem.tags;
        }
    }

    function getItems() {
        return items;
    }

    function recalculateAllTags() {
        for (let item of items) {
            _decorateItemTags(item);
        }
    }

    function setItems(new_items) {
        items = new_items;
        //clean ununsed properties
        for (let item of items) {
            if (item._dirty_tags != undefined) {
                delete item._dirty_tags;
            }
            if (item._last_update != undefined) {
                delete item._last_update;
            }
        }
        item_cache = {};
        recalculateAllTags();

        let start = Date.now();
        _immutable_items = Immutable.fromJS(items);
        let end = Date.now();
        console.log("Immutable took " + (end-start) +"ms");
    }

    function _decorateItemTags(item, parent_tags = []) {
        item._tags = [];
        if (item.tags != undefined) {
            let tags = item.tags.trim().split(' ');
            for (let tag of tags) {
                if (tag.trim() != '') {
                    let content = tag.trim();
                    if (_isAValidTag(content) && item._tags.includes(content) == false) {
                        item._tags.push(content);
                    }
                }
            }
        }

        for (let tag of parent_tags) {
            //Don't want dowhward inheritance of @ tags
            if (item._tags.includes(tag) == false && tag.startsWith('@') == false) {
                item._tags.push(tag);
            }
        }

        //If contains @meta, then we want to add all valid tags within the item.data itself
        if (item._tags.includes('@meta')) {
            let text = $format.toText(item.data);
            for (let line of text.split('\n')) {
                for (let part of line.split(' ')) {
                    let content = part.trim();
                    if (_isAValidTag(content) && item._tags.includes(content) == false) {
                        item._tags.push(content);
                    }
                }
            }
        }

        for (let subitem of item.subitems) {
            _decorateItemTags(subitem, item._tags);
        }
    }

    //TODO: move into parser code?
    let _cache_is_valid = {};
    let re = new RegExp("^([a-z0-9A-Z_#@][a-z0-9A-Z-_./:#@!+'&]*)$");

    function _isAValidTag(content) {
        if (_cache_is_valid[content] != undefined) {
            return _cache_is_valid[content];
        }

        if (re.test(content)) {
            _cache_is_valid[content] = true;
            return true;
        }
        else {
            _cache_is_valid[content] = false;
            return false;
        }
    }

    function _getNewId() {
        let maxId = 0;
        for (let i = 0; i < items.length; i++) {
            if (items[i].id > maxId) {
                maxId = items[i].id;
            }
        }
        return maxId + 1;
    }

    function addItem(tags) {
        let priority = 1;
        
        //find first included item, if any
        for (let item of $model.getItems()) {
            if (item._include == 1 && item.priority < priority) {
                priority = item.priority;
            }
        }

        for (let i = 0; i < items.length; i++) {
            if (items[i].priority >= priority) {
                items[i].priority++;
            }
        }

        let new_item = {
            'id': _getNewId(),
            'priority': priority,
            'data': '',
            'timestamp': Date.now(),
            'tags': tags,
            'subitems': [],
            '_include': 1
        };

        items.push(new_item);

        _decorateItemTags(new_item);

        return new_item.id;
    }

    function addNextItem(selectedItemId) {
        let item = getItemById(selectedItemId);
        for (let i = 0; i < items.length; i++) {
            if (items[i].priority > item.priority) {
                items[i].priority++;
            }
        }
        let new_item = {
            'id': _getNewId(),
            'priority': item.priority + 1,
            'data': '',
            'timestamp': Date.now(),
            'tags': item.tags,
            'subitems': []
        };

        items.push(new_item);

        _decorateItemTags(new_item);

        return new_item.id;
    }

    function deleteItem(id) {
        let item = getItemById(id);
        let index = -1;
        for (let i = 0; i < items.length; i++) {
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
    }

    function getItemById(id) {
        if (item_cache[id] !== undefined) {
            return item_cache[id];
        }
        else {
            for (let i = 0; i < items.length; i++) {
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
        let _get = function (subitem, path) {
            if (path == null || path == '') {
                return null;
            }
            let parts = path.split('/');
            let index = parseInt(parts[0]);
            if (parts.length == 1) {
                return subitem.subitems[index];
            }
            else {
                let remaining = parts.slice(1);
                return _get(subitem.subitems[index], remaining.join('/'));
            }
        };
        let item = getItemById(id);
        return _get(item, path);
    }

    function drag(id1, id2) {
        if (id1 == id2) {
            return;
        }
        let item1 = getItemById(id1);
        let item2 = getItemById(id2);
        if (item1.priority < item2.priority) {
            dragDown(id1, id2);
        }
        else {
            dragUp(id1, id2);
        }
    }

    function dragDown(id1, id2) {
        let item1 = getItemById(id1);
        let item2 = getItemById(id2);
        let item1Priority = item1.priority;
        let item2Priority = item2.priority;
        for (let i = 0; i < items.length; i++) {
            if (items[i].priority <= item1Priority || items[i].priority > item2Priority) {
                continue;
            }
            items[i].priority--;
        }
        item1.priority = item2Priority;
    }

    function dragUp(id1, id2) {
        let item1 = getItemById(id1);
        let item2 = getItemById(id2);
        let item1Priority = item1.priority;
        let item2Priority = item2.priority;
        for (let i = 0; i < items.length; i++) {
            if (items[i].priority >= item1Priority || items[i].priority < item2Priority) {
                continue;
            }
            items[i].priority++;
        }
        //update after
        item1.priority = item2Priority;
    }

    function moveDown(id) {
        let selected_item = getItemById(id);
        //get next visible item below
        let closest_selected_below = null;
        for (let i = 0; i < items.length; i++) {
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
        for (let i = 0; i < items.length; i++) {
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
        let selected_item = getItemById(id);
        //get next visible item below
        let closest_selected_above = null;
        for (let i = 0; i < items.length; i++) {
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
        for (let i = 0; i < items.length; i++) {
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
        let item = getItemById(selectedItemId);
        item.timestamp = timestamp;
    }

    function updateData(selectedItemId, text) {
        let item = getItemById(selectedItemId);
        item.data = text;
    }

    function updateTag(selectedItemId, text) {
        let item = $model.getItemById(selectedItemId);
        item.tags = text;
        _decorateItemTags(item);
    }

    function updateSubTag(selectedItemId, path, text) {
        let subitem = getSubitem(selectedItemId, path);
        subitem.tags = text;
        let item = $model.getItemById(selectedItemId);
        _decorateItemTags(item);
    }
    
    function addSubItem(id, path) {
        let item = getItemById(id);
        let result = _addSubItem(item, path);
        _decorateItemTags(item);
        return result;
    }

    function _addSubItem(item, path) {
        if (path == null) {
            let subitem = { data: '', subitems: [], tags: '', _include: 1 };
            item.subitems.splice(0, 0, subitem);
            return '0';
        }
        else {
            let parts = ('' + path).split('/');
            let first = null;
            let rest = null;
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
            let parts = ('' + path).split('/');
            let first = null;
            if (parts.length == 1) {
                let nfirst = parseInt(parts[0]);
                let sibling = parent.subitems[nfirst];
                let next = nfirst + 1;
                parent.subitems.splice(next, 0, { data: '', subitems: [], tags: '', _include:1 });
                return '' + next;
            }
            else {
                first = parts.shift();
                let rest = parts.join('/');
                return first + '/' + _addNextSubItem(parent.subitems[first], rest);
            }
        }
        let item = getItemById(id);
        let result = _addNextSubItem(item, path);
        _decorateItemTags(item);
        return result;
    }

    function removeSubItem(id, path) {
        function _removeSubItem(item, path) {
            let parts = ('' + path).split('/');
            let first = null;
            let rest = null;
            if (parts.length == 1) {
                let nfirst = parseInt(parts[0]);
                item.subitems.splice(nfirst, 1);
            }
            else {
                first = parts.shift();
                rest = parts.join('/');
                _removeSubItem(item.subitems[first], rest);
            }
        }
        let item = getItemById(id);
        _removeSubItem(item, path);
        _decorateItemTags(item);
    }

    function moveUpSubitem(selectedItemId, selectedSubitemPath) {
        function _moveUpSubItem(item, path) {
            let parts = ('' + path).split('/');
            let first = null;
            let rest = null;
            if (parts.length == 1) {
                let nfirst = parseInt(parts[0]);
                if (nfirst == 0) {
                    return '' + nfirst;
                }
                let temp = item.subitems[nfirst - 1];
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
        let item = getItemById(selectedItemId);
        let newpath = _moveUpSubItem(item, selectedSubitemPath);
        return newpath;
    }

    function moveDownSubitem(selectedItemId, selectedSubitemPath) {
        function _moveDownSubItem(item, path) {
            let parts = ('' + path).split('/');
            let first = null;
            let rest = null;
            if (parts.length == 1) {
                let nfirst = parseInt(parts[0]);
                if (nfirst >= item.subitems.length - 1) {
                    return '' + nfirst;
                }
                let temp = item.subitems[nfirst + 1];
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
        let item = getItemById(selectedItemId);
        let newpath = _moveDownSubItem(item, selectedSubitemPath);
        return newpath;
    }
    function updateSubitemData(selectedItemId, selectedSubitemPath, text) {
        function _updateSubItemData(item, path, text) {
            //console.log('_updateSubItemData('+path+')');
            let parts = ('' + path).split('/');
            let first = null;
            let rest = null;
            if (parts.length == 1) {
                first = parts[0];
                if (text != item.subitems[first].data) {
                    item.subitems[first].data = text;
                }
            }
            else {
                first = parts.shift();
                rest = parts.join('/');
                _updateSubItemData(item.subitems[first], rest, text);
            }
        }
        let item = getItemById(selectedItemId);
        _updateSubItemData(item, selectedSubitemPath, text);
    }

    function getEnrichedAndSortedTagList(filtered_items) {
        if (filtered_items.length == 0) {
            filtered_items = $model.getItems();
        }
        let all_tags = {};
        for (let i = 0; i < filtered_items.length; i++) {
            let tags = $ontology.getEnrichedTags($model.getItemTags(filtered_items[i]));
            for (let t = 0; t < tags.length; t++) {
                let tag = tags[t].trim();
                if (all_tags[tag] != undefined) {
                    all_tags[tag] += 1;
                }
                else {
                    all_tags[tag] = 1;
                }
            }
        }
        let list = [];
        for (let key in all_tags) {
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
        getItemTags: getItemTags,
        getSubItemTags: getSubItemTags,
        enumerate: enumerate,
        getEnrichedAndSortedTagList, getEnrichedAndSortedTagList,
        recalculateAllTags: recalculateAllTags
    };
})();
