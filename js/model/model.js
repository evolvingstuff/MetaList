"use strict";

let DATA_SCHEMA_VERSION = 1;

let $model = (function () {

    ///////////////////////////////////////////////////////////////////////////////////////////////////
    // Mutating functions affecting single items

    let propagating_meta_tags = ['@markdown']; //TODO: don't make a special case for markdown tag!

    function addSubItem(item, path) {
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

        let result_path = _addSubItem(item, path);
        _decorateItemTags(item);
        return result_path;
        //TODO: return new ref to items?
    }

    function addNextSubItem(item, path) {
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
        let result_path = _addNextSubItem(item, path);
        _decorateItemTags(item);
        return result_path;
        //TODO: return new ref to items?
    }

    function removeSubItem(item, path) {
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
        _removeSubItem(item, path);
        _decorateItemTags(item);
        //TODO: return new ref to items?
    }

    function moveUpSubitem(item, selectedSubitemPath) {
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
        let result_path = _moveUpSubItem(item, selectedSubitemPath);
        return result_path;
        //TODO: return new ref to items?
    }

    function moveDownSubitem(item, selectedSubitemPath) {
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
        let result_path = _moveDownSubItem(item, selectedSubitemPath);
        return result_path;
        //TODO: return new ref to items?
    }
    
    function updateSubitemData(item, selectedSubitemPath, text) {
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
        _updateSubItemData(item, selectedSubitemPath, text);
        //TODO: return new ref to items?
    }

    function updateTimestamp(item, timestamp) {
        item.timestamp = timestamp;
        //TODO: return new ref to items?
    }

    function updateData(item, text) {
        item.data = text;
        //TODO: return new ref to items?
    }

    function updateTag(item, text) {
        item.tags = text;
        _decorateItemTags(item);
        //TODO: return new ref to items?
    }

    function updateSubTag(item, path, text) {
        let subitem = getSubitem(item, path);
        subitem.tags = text;
        _decorateItemTags(item);
        //TODO: return new ref to items?
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////
    // Mutating functions affecting all items

    function moveDown(items, selected_item) {

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
            else if (items[i].id == selected_item.id) {
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
        //TODO: return new ref to items?
    }

    function moveUp(items, selected_item) {
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
            else if (items[i].id == selected_item.id) {
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
        //TODO: return new ref to items?
    }

    function drag(items, item1, item2) {
        if (item1.id == item2.id) {
            return;
        }
        if (item1.priority < item2.priority) {
            dragDown(items, item1, item2);
            //TODO: return new ref to items?
        }
        else {
            dragUp(items, item1, item2);
            //TODO: return new ref to items?
        }
    }

    function dragDown(items, item1, item2) {
        let item1Priority = item1.priority;
        let item2Priority = item2.priority;
        for (let i = 0; i < items.length; i++) { //TODO
            if (items[i].priority <= item1Priority || items[i].priority > item2Priority) {
                continue;
            }
            items[i].priority--;
        }
        item1.priority = item2Priority;
        //TODO: return new ref to items?
    }

    function dragUp(items, item1, item2) {
        let item1Priority = item1.priority;
        let item2Priority = item2.priority;
        for (let i = 0; i < items.length; i++) { //TODO
            if (items[i].priority >= item1Priority || items[i].priority < item2Priority) {
                continue;
            }
            items[i].priority++;
        }
        //update after
        item1.priority = item2Priority;
        //TODO: return new ref to items?
    }

    function _getNewId(items) {
        //TODO: this could be more efficient
        let maxId = 0;
        for (let i = 0; i < items.length; i++) {
            if (items[i].id > maxId) {
                maxId = items[i].id;
            }
        }
        return maxId+1;
    }

    function addItemFromSearchBar(items, tags) {
        for (let i = 0; i < items.length; i++) {
            items[i].priority++;
        }
        return _addItem(items, 1, tags);
        //TODO: return new ref to items?
    }

    function addNextItem(items, item) {
        for (let i = 0; i < items.length; i++) {
            if (items[i].priority > item.priority) {
                items[i].priority++;
            }
        }
        return _addItem(items, item.priority+1, item.tags);
        //TODO: return new ref to items?
    }

    function _addItem(items, priority, tags) {
        let new_item = {
            'id': _getNewId(items),
            'priority': priority,
            'data': '',
            'timestamp': Date.now(),
            'tags': tags,
            'subitems': []
        };
        _decorateItemTags(new_item);
        items.push(new_item);
        return new_item;
    }

    function deleteItem(items, item) {
        let index = -1;
        for (let i = 0; i < items.length; i++) { //TODO
            if (items[i].priority > item.priority) {
                items[i].priority--;
            }
            if (items[i].id == item.id) {
                index = i;
            }
        }
        items.splice(index, 1);
        //TODO: return new ref to items?
    }

    function recalculateAllTags(items) {
        for (let item of items) {
            _decorateItemTags(item);
        }
        //TODO: return new ref to items?
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
            
            if (item._tags.includes(tag) == false && (tag.startsWith('@') == false || propagating_meta_tags.includes(tag))) {
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
        //TODO: return new ref to items?
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////
    // Non-mutating functions of one item
    
    function flatten(item) {
        let result = [];
        result.push(item);
        if (item.subitems != undefined || item.subitems != null || item.subitems.length > 0) {
            for (let i = 0; i < item.subitems.length; i++) {
                result = result.concat(flatten(item.subitems[i]));
            }
        }
        return result;
    }

    function getItemsAsText(filtered_items) {
        let result = '';
        for (let item of filtered_items) {
            result += getItemAsText(item, 0);
            result += "\n";
        }
        return result;
    }

    function getItemAsText(item, depth) {

        function sanitize(text) {
            text = text.replace('&gt;', '>');
            text = text.replace('&lt;', '<');
            return text;
        }

        let result = '';
        for (let i = 0; i < depth; i++) {
            result += '\t'
        }
        result += sanitize(item.data);
        if (item._tags != undefined && item._tags != null) {
            result += ' |';
            for (let tag of item._tags) {
                result += ' #' + tag;
            }
        }
        result += '\n';
        if (item.subitems != undefined && item.subitems != null) {
            for (let sub of item.subitems) {
                result += getItemAsText(sub, depth+1);
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
            let subitem = getSubitem(item, subitem_path);
            if (subitem.tags == undefined || subitem.tags == null) {
                throw "ERROR: subitem has no .tags property";
            }
            return subitem.tags;
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
    
    function getSubitem(item, path) {
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
        return _get(item, path);
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////
    // Non-mutating functions of multiple item

    function getEnrichedAndSortedTagList(filtered_items) {
        let all_tags = {};
        for (let i = 0; i < filtered_items.length; i++) {
            let tags = $ontology.getEnrichedTags(getItemTags(filtered_items[i]));
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

    function renameTag(items, tagname1, tagname2) {
        //TODO: needs more work to properly handle meta tags...
        //TODO: modify search filter...
        console.log('$model.renameTag() '+tagname1+' -> '+tagname2)
        if (_isAValidTag(tagname2) == false) {
            alert('ERROR: target tagname is not valid.');
            return;
        }
        let tot = 0;
        for (let item of items) {
            let modification = false;
            for (let flat of flatten(item)) {
                if (flat.tags == undefined || flat.tags == null) {
                    continue;
                }
                let tags = flat.tags.trim().split(' ');
                let updated_tags = [];
                let has1 = false;
                for (let tag of tags) {
                    if (tag.trim() != '') {
                        if (tag == tagname1) {
                            has1 = true;
                            updated_tags.push(tagname2);
                        }
                        else {
                            updated_tags.push(tag);
                        }
                    }
                }
                if (has1) {
                    console.log('update ' + tags.join(' ') + ' -> ' + updated_tags.join(' '));
                    flat.tags = updated_tags.join(' ');
                    modification = true;
                }
            }
            if (modification) {
                tot += 1;
                _decorateItemTags(item);
            }
        }
        if (tot > 0) {
            alert('Modified ' + tot + ' items');
        }
    }

    function deleteTag(items, tagname) {
        //TODO: needs more work to properly handle meta tags...
        //TODO: modify search filter...
        let tot = 0;
        for (let item of items) {
            let modification = false;
            for (let flat of flatten(item)) {
                if (flat.tags == undefined || flat.tags == null) {
                    continue;
                }
                let tags = flat.tags.trim().split(' ');
                let updated_tags = [];
                let has1 = false;
                for (let tag of tags) {
                    if (tag.trim() != '') {
                        if (tag == tagname) {
                            has1 = true;
                            //do not add to updated array
                        }
                        else {
                            updated_tags.push(tag);
                        }
                    }
                }
                if (has1) {
                    console.log('update ' + tags.join(' ') + ' -> ' + updated_tags.join(' '));
                    flat.tags = updated_tags.join(' ');
                    modification = true;
                }
            }
            if (modification) {
                tot += 1;
                _decorateItemTags(item);
            }
        }
        if (tot > 0) {
            alert('Modified ' + tot + ' items');
        }
    }

    ///////////////////////////////////////////////////////////////////////////
    // Interface

    return {
        getSubitem: getSubitem,
        addItemFromSearchBar: addItemFromSearchBar,
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
        flatten: flatten,
        getEnrichedAndSortedTagList, getEnrichedAndSortedTagList,
        recalculateAllTags: recalculateAllTags,
        getItemsAsText: getItemsAsText,
        renameTag: renameTag,
        deleteTag: deleteTag
    };
})();