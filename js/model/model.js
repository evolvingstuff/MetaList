"use strict";

let $model = (function () {

    ///////////////////////////////////////////////////////////////////////////////////////////////////
    // Mutating functions affecting single items

    let PROTECTED_TAGS = ['@id', '@subitem-index', '@date'];
    let DOWNPROPAGATE_NUMERIC_TAGS = false;
    let TRIM_DELETED_CONTENT = true;
    let KEEP_STUBS_FOR_DELETED_ITEMS = true;

    function _onUpdateContent(item) {
        item.last_edit = Date.now();
    }

    function addSubItem(item, index, extra_indent) {
        let indent = 1; //Always fixed indent under root subitem
        if (index > 0) {
            indent = item.subitems[index].indent;
            if (extra_indent) {
                indent += 1;
            }
        }
        let subitem = { 
            'data': '',
            'tags': '', 
            'indent': indent, 
            '_include': 1 
        };
        index += 1;
        while (index < item.subitems.length && item.subitems[index].indent > indent) {
            index++;
        }
        item.subitems.splice(index,0,subitem);
        _decorateItemTags(item);
        _onUpdateContent(item);
        return item.id + ':' + (index);
    }

    function removeSubItem(item, path) {
        if (path == null) {
            return;
        }
        let parts = path.split(':');
        let index = parseInt(parts[1]);
        let indent = item.subitems[index].indent;
        item.subitems.splice(index, 1);
        while (item.subitems.length > index && item.subitems[index].indent > indent) {
            item.subitems.splice(index, 1);
        }
        _decorateItemTags(item);
        _onUpdateContent(item);
    }

    function moveUpSubitem(item, path) {
        let parts = path.split(':');
        let index = parseInt(parts[1]);
        if (index == 1) {
            return path;
        }
        let indent = item.subitems[index].indent;
        let a0 = index;
        let ak = a0;
        for (let i = a0+1; i < item.subitems.length; i++) {
            if (item.subitems[i].indent > indent) {
                ak = i;
            }
            else {
                break;
            }
        }
        let b0 = index-1;

        if (item.subitems[b0].indent < indent) {
            return path;
        }
        else if (item.subitems[b0].indent == indent) {
            //do nothing
        }
        else {
            for (let i = index-2; i > 0; i--) {
                if (item.subitems[i].indent < indent) {
                    break; //should never reach here
                }
                if (item.subitems[i].indent == indent) {
                    b0 = i;
                    break;
                }
            }
        }

        let new_subitems = [];

        for (let i = 0; i < b0; i++) {
            new_subitems.push(item.subitems[i]);
        }

        for (let a = 0; a < ak-a0+1; a++) {
            new_subitems.push(item.subitems[a0+a]);
        }
        for (let b = 0; b < a0-b0; b++) {
            new_subitems.push(item.subitems[b0+b]);
        }

        for (let i = ak+1; i < item.subitems.length; i++) {
            new_subitems.push(item.subitems[i]);
        }

        item.subitems = new_subitems;
        _onUpdateContent(item);
        return item.id + ':' + b0;
    }

    function moveDownSubitem(item, path) {
        let parts = path.split(':');
        let index = parseInt(parts[1]);
        if (index == item.subitems.length-1) {
            return path;
        }
        let indent = item.subitems[index].indent;
        let a0 = index;
        let ak = a0;
        for (let i = a0+1; i < item.subitems.length; i++) {
            if (item.subitems[i].indent > indent) {
                ak = i;
            }
            else {
                break;
            }
        }
        let c0 = ak+1;
        if (c0 > item.subitems.length - 1) {
            return path;
        }
        if (item.subitems[c0].indent < indent) {
            return path;
        }

        let ck = c0;
        for (let i = c0+1; i < item.subitems.length; i++) {
            if (item.subitems[i].indent > item.subitems[c0].indent) {
                ck = i;
            }
            else {
                break;
            }
        }
        moveUpSubitem(item, item.id+':'+c0);
        let new_coordinate = a0 + (ck-c0) + 1;
        let new_path = item.id+':'+new_coordinate;
        _onUpdateContent(item);
        return new_path;
    }

    function indentSubitem(item, path) {
        let parts = path.split(':');
        let index = parseInt(parts[1]);
        if (index < 2) {
            return path;
        }
        let indent = item.subitems[index].indent;

        let valid_parent = false;
        for (let i = index-1; i >= 1; i--) {
            if (item.subitems[i].indent < indent) {
                valid_parent = false;
                break;
            }
            if (item.subitems[i].indent == indent || item.subitems[i].indent == indent+1) {
                valid_parent = true;
                break;
            }
        }
        if (valid_parent == false) {
            console.log('no valid parent for indent');
            return path;
        }
        
        let a0 = index;
        let ak = a0;
        for (let i = a0+1; i < item.subitems.length; i++) {
            if (item.subitems[i].indent > indent) {
                ak = i;
            }
            else {
                break;
            }
        }

        for (let i = a0; i <= ak; i++) {
            item.subitems[i].indent += 1;
        }
        _decorateItemTags(item);
        _onUpdateContent(item);
    }

    function outdentSubitem(item, path) {
        let parts = path.split(':');
        let index = parseInt(parts[1]);
        if (index < 2) {
            return path;
        }
        let indent = item.subitems[index].indent;

        if (indent == 1) {
            return path;
        }
        
        let valid_parent = false;
        for (let i = index-1; i >= 1; i--) {
            if (item.subitems[i].indent == indent || item.subitems[i].indent == indent-1) {
                valid_parent = true;
                console.log('Valid parent at ' + i);
                break;
            }
        }
        if (valid_parent == false) {
            console.log('no valid parent for indent');
            return path;
        }
        
        let a0 = index;
        let ak = a0;
        for (let i = a0+1; i < item.subitems.length; i++) {
            if (item.subitems[i].indent > indent) {
                ak = i;
            }
            else {
                break;
            }
        }

        for (let i = a0; i <= ak; i++) {
            item.subitems[i].indent -= 1;
        }
        _decorateItemTags(item);
        _onUpdateContent(item);
    }
    
    function updateSubitemData(item, path, text) {
        if (path == null) {
            return;
        }
        let parts = path.split(':');
        let index = parseInt(parts[1]);
        item.subitems[index].data = text;
        _onUpdateContent(item);
    }

    function updateTimestamp(item, timestamp) {
        item.timestamp = timestamp;
        _onUpdateContent(item);
    }

    function updateData(item, text) {
        item.subitems[0].data = text;
        _onUpdateContent(item);
    }

    function updateTag(item, text) {
        item.subitems[0].tags = text;
        _decorateItemTags(item);
        _onUpdateContent(item);
    }

    function updateSubTag(item, path, text) {
        let subitem = getSubitem(item, path);
        subitem.tags = text;
        _decorateItemTags(item);
        _onUpdateContent(item);
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////
    // Mutating functions affecting all items

    function moveDown(items, selected_item) {

        //get next visible item below
        let closest_selected_below = null;
        for (let i = 0; i < items.length; i++) {
            if (items[i].deleted != undefined) {
                continue;
            }
            if (items[i].subitems[0]._include == -1) {
                continue;
            }
            if (items[i].priority > selected_item.priority && 
                (closest_selected_below == null || items[i].priority < closest_selected_below)) {
                closest_selected_below = items[i].priority;
            }
        }
        if (closest_selected_below == null) {
            return;
        }
        for (let i = 0; i < items.length; i++) {
            if (items[i].deleted != undefined) {
                continue;
            }
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
    }

    function moveUp(items, selected_item) {
        //get next visible item below
        let closest_selected_above = null;
        for (let i = 0; i < items.length; i++) {
            if (items[i].deleted != undefined) {
                continue;
            }
            if (items[i].subitems[0]._include == -1) {
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
            if (items[i].deleted != undefined) {
                continue;
            }
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
    }

    function drag(items, item1, item2) {
        if (item1.id == item2.id) {
            return;
        }
        if (item1.priority < item2.priority) {
            dragDown(items, item1, item2);
        }
        else {
            dragUp(items, item1, item2);
        }
    }

    function dragDown(items, item1, item2) {
        let item1Priority = item1.priority;
        let item2Priority = item2.priority;
        for (let i = 0; i < items.length; i++) {
            if (items[i].deleted != undefined) {
                continue;
            }
            if (items[i].priority <= item1Priority || items[i].priority > item2Priority) {
                continue;
            }
            items[i].priority--;
        }
        item1.priority = item2Priority;
    }

    function dragUp(items, item1, item2) {
        let item1Priority = item1.priority;
        let item2Priority = item2.priority;
        for (let i = 0; i < items.length; i++) {
            if (items[i].deleted != undefined) {
                continue;
            }
            if (items[i].priority >= item1Priority || items[i].priority < item2Priority) {
                continue;
            }
            items[i].priority++;
        }
        //update after
        item1.priority = item2Priority;
    }

    function _getNewId(items) {
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
            if (items[i].deleted != undefined) {
                continue;
            }
            items[i].priority++;
        }
        return _addItem(items, 1, tags);
    }

    function addNextItem(items, item) {
        for (let i = 0; i < items.length; i++) {
            if (items[i].deleted != undefined) {
                continue;
            }
            if (items[i].priority > item.priority) {
                items[i].priority++;
            }
        }
        return _addItem(items, item.priority+1, item.subitems[0].tags);
    }

    function _addItem(items, priority, tags) {

        for (let tag of PROTECTED_TAGS) {
            tags = replaceAll(tags, tag, '');
        }
        tags = tags.replace(/  +/g, ' ');

        let now = Date.now();

        let new_item = {
            'id': _getNewId(items),
            'priority': priority,
            'timestamp': now,
            'creation': now,
            'last_edit': now,
            'collapse': 0,
            'subitems': [
                {
                    'data': '',
                    'tags': tags,
                    'indent': 0
                }
            ]
        };
        _decorateItemTags(new_item);
        items.push(new_item);
        return new_item;
    }

    function deleteItem(items, item) {

        item.deleted = true;

        if (TRIM_DELETED_CONTENT) {
            delete item.subitems;
            delete item.collapse;
            delete item.priority;
            delete item.timestamp;
        }

        //update broken links
        for (let other_item of items) {
            if (other_item.deleted != undefined) {
                continue;
            }
            for (let subitem of other_item.subitems) {
                if (subitem._direct_tags.includes('@goto')) {
                    let parts = subitem.data.split('@id=');
                    if (parts.length > 1) {
                        let parts2 = parts[1].split(' ');
                        if (parts2[0].length > 0) {
                            let broken_id = parts2[0];
                            if (broken_id == item.id) {
                                subitem.tags = subitem.tags.replace('@goto','@broken-search');
                                subitem.data = 'Broken reference to @id='+broken_id;
                            }
                        }
                    }
                }
            }
        }
        _onUpdateContent(item);
        recalculateAllTags(items);

        console.log('Deleted item:');
        console.log(item);

        if (KEEP_STUBS_FOR_DELETED_ITEMS == false) {
            console.log('Removing item stub');
            let length1 = items.length;
            let index = items.indexOf(item);
            if (index > -1) {
                items.splice(index, 1);
            }
            let length2 = items.length;
            if (length2 != length1-1) {
                alert('ERROR: unexpected result when trying to delete item');
            }
        }
    }

    function recalculateAllTags(items) {
        for (let item of items) {
            if (item.deleted != undefined) {
                continue;
            }
            _decorateItemTags(item);
        }
        resetTagCountsCache();
        getTagCounts(items);
    }

    function _decorateItemTags(item) {

        if (item.deleted != undefined) {
            return;
        }

        for (let i = 0; i < item.subitems.length; i++) {
            //clean tags
            item.subitems[i]._tags = [];
            item.subitems[i]._direct_tags = [];
            item.subitems[i]._inherited_tags = [];
            item.subitems[i]._implied_tags = [];
            delete item.subitems[i]._numeric_tags;

            //get direct tags and numeric tags
            let tags = item.subitems[i].tags.split(' ');
            for (let tag of tags) {
                let content = tag.trim();
                if (_isAValidTag(content) && item.subitems[i]._tags.includes(content) == false) {
                    item.subitems[i]._tags.push(content);
                    item.subitems[i]._direct_tags.push(content);
                }

                if (_isAValidNumericTag(content)) {
                    if (item.subitems[i]._numeric_tags == undefined) {
                        item.subitems[i]._numeric_tags = [];
                    }
                    if (item.subitems[i]._numeric_tags.includes(content) == false) {
                        item.subitems[i]._numeric_tags.push(content);
                    }

                    let attribute = content.split('=')[0];
                    if (_isAValidTag(attribute) && item.subitems[i]._tags.includes(attribute) == false) {
                        item.subitems[i]._tags.push(attribute);
                        item.subitems[i]._direct_tags.push(attribute);
                    }
                }
            }

            //If contains @meta, then we want to add all valid tags within the item.data itself
            //TODO: how will this work with numeric tags?

            if (item.subitems[i]._tags.includes('@meta')) {
                let text = $format.toText(item.subitems[i].data);
                for (let line of text.split('\n')) {
                    for (let part of line.split(' ')) {
                        let content = part.trim();
                        if (_isAValidTag(content) && item.subitems[i]._tags.includes(content) == false) {
                            item.subitems[i]._tags.push(content);
                            item.subitems[i]._direct_tags.push(content);
                        }
                    }
                }
            }

            let enriched = $ontology.getEnrichedTags(item.subitems[i]._direct_tags);
            for (let tag of enriched) {
                if (item.subitems[i]._direct_tags.includes(tag) == false) {
                    item.subitems[i]._implied_tags.push(tag);
                }
            }
        }

        //propagate valid tags downwards to children
        for (let i = 0; i < item.subitems.length; i++) {
            let tags = item.subitems[i]._tags;
            for (let j = i+1; j < item.subitems.length; j++) {
                if (item.subitems[j].indent <= item.subitems[i].indent) {
                    break;
                }
                for (let tag of tags) {
                    let content = tag.trim();

                    if (_isAValidTag(content) && item.subitems[j]._tags.includes(content) == false &&
                        (tag.startsWith('@') == false && tag.startsWith('#') == false)) {
                        //do not down-propagate meta tags or macros, as these involve formatting
                        item.subitems[j]._tags.push(content);
                        item.subitems[j]._inherited_tags.push(content);
                    }
                }
            }

            if (DOWNPROPAGATE_NUMERIC_TAGS) {
                if (item.subitems[i]._numeric_tags != undefined) {
                    let tags = item.subitems[i]._numeric_tags;
                    for (let j = i+1; j < item.subitems.length; j++) {
                        if (item.subitems[j].indent <= item.subitems[i].indent) {
                            break;
                        }
                        for (let tag of tags) {
                            let content = tag.trim();
                            if (_isAValidNumericTag(content)) {
                                if (item.subitems[j]._numeric_tags == undefined) {
                                    item.subitems[j]._numeric_tags = [];
                                }
                                if (item.subitems[j]._numeric_tags.includes(content) == false) {
                                    item.subitems[j]._numeric_tags.push(content);
                                }

                                let attribute = content.split('=')[0];
                                if (_isAValidTag(attribute) && item.subitems[j]._tags.includes(attribute) == false &&
                                    (tag.startsWith('@') == false && tag.startsWith('#') == false)) {
                                    item.subitems[j]._tags.push(attribute);
                                    item.subitems[j]._inherited_tags.push(attribute);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////
    // Non-mutating functions of one item

    function getItemsAsText(filtered_items) {
        let result = '';
        for (let item of filtered_items) {
            if (item.deleted != undefined) {
                continue;
            }
            result += getItemAsText(item, 0);
            result += "\n";
        }
        return result;
    }

    function getItemAsText(item, depth) {
        if (item.deleted != undefined) {
            return '';
        }

        function sanitize(text) {
            text = text.replace('&gt;', '>');
            text = text.replace('&lt;', '<');
            //TODO: more sanitization here!
            return text;
        }

        let result = '';
        for (let sub of item.subitems) {
            for (let i = 0; i < sub.indent; i++) {
                result += '\t'
            }
            //TODO: add numeric tags here!
            result += sanitize(sub.data);
                if (sub._tags != undefined && sub._tags != null) {
                result += ' |';
                for (let tag of sub._tags) {
                    result += ' #' + tag;
                }
            }
            result += '\n';
        }
        return result;
    }

    //This gets ALL tags for item, including all subitems
    function getItemTags(item) {
        if (item.deleted != undefined) {
            return '';
        }
        let _tags = [];
        for (let sub of item.subitems) {
            for (let t of sub._tags) {
                if (_tags.includes(t) == false) {
                    _tags.push(t)
                }
            }
        }
        return _tags.join(' ');
    }
    
    //This gets tags at just leaf node
    function getSubItemTags(item, subitem_path) {
        if (subitem_path == undefined || subitem_path == null || subitem_path == '') {
            if (item.subitems[0].tags == undefined || item.subitems[0].tags == null) {
                console.log(item);
                console.log('WARNING: no tags found for this item');
            }
            return item.subitems[0].tags;
        }
        else {
            let subitem = getSubitem(item, subitem_path);
            if (subitem.tags == undefined || subitem.tags == null) {
                console.log(subitem);
                console.log('WARNING: no tags found for this subitem. Removing.');
                subitem.tags = '';
            }
            return subitem.tags;
        }
    }

    //TODO: move into parser code?
    let _cache_is_valid = {};
    let _cache_is_valid_numeric = {};
    let re = new RegExp("^([a-z0-9A-Z_#@][a-z0-9A-Z-_./:#@!+'&]*)$");

    //TODO: this should have a separate parser
    function isValidTag(content) {
        return _isAValidTag(content);
    }

    function _isAValidTag(content) {
        if (content.trim() == '') {
            return false;
        }

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

    function _isAValidNumericTag(content) {
        if (content.trim() == '') {
            return false;
        }

        let parts = content.split('=');

        if (parts.length != 2) {
            _cache_is_valid_numeric[content] = false;
            return false;
        }

        if (_isAValidTag(parts[0]) == false) {
            _cache_is_valid_numeric[content] = false;
            return false;
        }

        if (isNaN(parts[1])) {
            _cache_is_valid_numeric[content] = false;
            return false;
        }

        _cache_is_valid_numeric[content] = true;
        return true;
    }
    
    function getSubitem(item, path) {
        if (path == null) {
            return item.subitems[0];
        }
        let parts = path.split(':');
        let index = parseInt(parts[1]);
        return item.subitems[index];
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////
    // Non-mutating functions of multiple item

    function getEnrichedAndSortedTagList(items, filter) {
        let all_tags = {};
        for (let i = 0; i < items.length; i++) {
            if (items[i].deleted != undefined) {
                continue;
            }

            for (let sub of items[i].subitems) {

                if (filter && sub._include != 1) {
                    continue;
                }

                for (let direct_tag of sub._direct_tags) {
                    if (all_tags[direct_tag] != undefined) {
                        all_tags[direct_tag] += 1;
                    }
                    else {
                        all_tags[direct_tag] = 1;
                    }
                }

                for (let implied_tag of sub._implied_tags) {
                    if (all_tags[implied_tag] != undefined) {
                        all_tags[implied_tag] += 1;
                    }
                    else {
                        all_tags[implied_tag] = 1;
                    }
                }

                for (let inherited_tag of sub._inherited_tags) {
                    if (all_tags[inherited_tag] != undefined) {
                        all_tags[inherited_tag] += 1;
                    }
                    else {
                        all_tags[inherited_tag] = 1;
                    }
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
        });
        list.reverse();
        return list;
    }

    function renameTag(items, tagname1, tagname2) {
        //TODO: needs work to handle numeric tags
        //TODO: modify search filter...
        console.log('$model.renameTag() '+tagname1+' -> '+tagname2)
        if (_isAValidTag(tagname2) == false) {
            alert('ERROR: target tagname is not valid.');
            return;
        }
        let tot = 0;
        for (let item of items) {
            if (item.deleted != undefined) {
                continue;
            }
            let modification = false;
            for (let flat of item.subitems) {
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
                _onUpdateContent(item);
                _decorateItemTags(item);
            }
        }

        //update meta tags
        for (let item of items) {
            if (item.deleted != undefined) {
                continue;
            }
            let modification = false;
            for (let subitem of item.subitems) {
                if (subitem._direct_tags.includes('@meta') == false) {
                    continue;
                }
                let data = subitem.data;
                data = data.replace(/<div>/g, ' <div> '); //TODO: this is a hack
                data = data.replace(/<\/div>/g, ' </div> ');
                let parts = data.split(' ');
                if (parts.includes(tagname1) == false) {
                    continue;
                }
                for (let i = 0; i < parts.length; i++) {
                    if (parts[i] == tagname1) {
                        parts[i] = tagname2;
                        modification = true;
                    }
                }
                data = parts.join(' ');
                data = data.replace(/\s<div>\s/g, '<div>'); //TODO: this is a hack
                data = data.replace(/\s<\/div>\s/g, '</div>');
                subitem.data = data;
            }
            if (modification) {
                tot += 1;
                _onUpdateContent(item);
                _decorateItemTags(item);
            }
        }

        if (tot > 0) {
            console.log('Modified ' + tot + ' items');
        }
    }

    function deleteTag(items, tagname) {
        //TODO: needs more work to properly handle meta tags...
        //TODO: make work with numeric tags
        //TODO: modify search filter...
        let tot = 0;
        for (let item of items) {
            if (item.deleted != undefined) {
                continue;
            }
            let modification = false;
            for (let flat of item.subitems) {
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
                _onUpdateContent(item);
            }
        }
        if (tot > 0) {
            console.log('Modified ' + tot + ' items');
        }
    }

    function addTagToCurrentView(items, new_tag) {
        if (_isAValidTag(new_tag) == false) {
            alert('ERROR: target tagname is not valid.');
            return;
        }
        let updates = 0;
        for (let item of items) {
            if (item.deleted != undefined) {
                continue;
            }
            if (item.subitems[0]._include != 1) {
                continue;
            }
            let tags = item.subitems[0].tags.trim().split(' ');
            if (tags.includes(new_tag) == false) {
                tags.push(new_tag);
                updates += 1;
            }
            item.subitems[0].tags = tags.join(' ');
            _decorateItemTags(item);
            _onUpdateContent(item);
        }
        console.log('Pushed '+updates+' new tags ');
    }

    function removeTagFromCurrentView(items, tagname) {
        //TODO: needs more work to properly handle meta tags...
        //TODO: modify search filter...
        let tot = 0;
        for (let item of items) {
            if (item.deleted != undefined) {
                continue;
            }
            if (item.subitems[0]._include != 1) {
                continue;
            }
            let modification = false;
            for (let flat of item.subitems) {
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
                _onUpdateContent(item);
            }
        }
        if (tot > 0) {
            console.log('Modified ' + tot + ' items');
        }
    }

    function getNextSubitemPath(selected_item, selectedSubitemPath) {
        console.log('--------------------------------------------')
        console.log('getNextSubitemPath('+selectedSubitemPath+')');

        if (selectedSubitemPath == null) { 
            selectedSubitemPath = selected_item.id+':0';
        }

        let parts = selectedSubitemPath.split(':');
        let index = parseInt(parts[1]);

        if (index == selected_item.subitems.length - 1) {
            return selectedSubitemPath;
        }

        return selected_item.id + ':' + (index+1);
    }

    function getPrevSubitemPath(selected_item, selectedSubitemPath) {
        console.log('--------------------------------------------')

        console.log('getPrevSubitemPath('+selectedSubitemPath+')');

        if (selectedSubitemPath == null) { 
            selectedSubitemPath = selected_item.id+':0';
        }

        let parts = selectedSubitemPath.split(':');
        let index = parseInt(parts[1]);

        if (index == 0) {
            return selectedSubitemPath;
        }

        return selected_item.id + ':' + (index-1);
    }

    function copySubsection(item, subitem_index) {
        let clipboard = [];
        let base_indent = item.subitems[subitem_index].indent;
        clipboard.push(copyJSON(item.subitems[subitem_index]));
        for (let i = subitem_index+1; i < item.subitems.length; i++) {
            if (item.subitems[i].indent > base_indent) {
                clipboard.push(copyJSON(item.subitems[i]));
            }
            else {
                break;
            }
        }
        //TODO: this is duplicated in persist.js
        for (let subitem of clipboard) {
            subitem.indent -= base_indent;
            delete subitem._include;
            delete subitem._tags;
            delete subitem._inherited_tags;
            delete subitem._implied_tags;
            delete subitem._direct_tags;
            delete subitem._numeric_tags;
        }
        return clipboard;
    }

    function pasteSubsection(item, subitem_index, subsection_clipboard) {
        if (item.subitems[subitem_index].data == '') {
            //Replace empty subitems
            let base_indent = item.subitems[subitem_index].indent;
            let original_tags = item.subitems[subitem_index].tags;
            item.subitems.splice(subitem_index,1);
            let index_into = subitem_index;
            let first = false;
            for (let subitem of subsection_clipboard) {
                let sub_copy = copyJSON(subitem);
                if (first == false) {
                    //weave in original tags
                    let parts1 = original_tags.split(' ');
                    let parts2 = sub_copy.tags.split(' ');
                    let combined = [];
                    for (let part of parts1) {
                        if (part != '' && combined.includes(part) == false) {
                            combined.push(part);
                        }
                    }
                    for (let part of parts2) {
                        if (part != '' && combined.includes(part) == false) {
                            combined.push(part);
                        }
                    }
                    sub_copy.tags = combined.join(' ');
                }
                sub_copy.indent += base_indent;
                item.subitems.splice(index_into++,0,sub_copy);
                first = true;
            }
            _decorateItemTags(item);
            _onUpdateContent(item);
            return subitem_index;
        }
        else {
            //Append to subitems with data
            let base_indent = Math.max(1, item.subitems[subitem_index].indent);
            let index_into = subitem_index+1;
            while (index_into < item.subitems.length && item.subitems[index_into].indent > base_indent) {
                index_into++;
            }
            let bookmark = index_into;
            for (let subitem of subsection_clipboard) {
                let sub_copy = copyJSON(subitem);
                sub_copy.indent += base_indent;
                item.subitems.splice(index_into++,0,sub_copy);
            }
            _decorateItemTags(item);
            _onUpdateContent(item);
            return bookmark;
        }
    }

    function toggleCollapse(item) {
        if (item.collapse == undefined) {
            item.collapse = 0;
        }
        if (item.collapse == 0) {
            item.collapse = 1;
        }
        else {
            item.collapse = 0;
        }
    }

    function collapse(item) {
        item.collapse = 1;
    }

    function expand(item) {
        item.collapse = 0;
    }

    let _cached_tag_counts = null;
    let _cached_numeric_tags = null;

    function resetTagCountsCache() {
        console.log('resetting tag counts cache in model');
        _cached_tag_counts = null;
    }

    function resetCachedNumericTags() {
        console.log('resetting cached numeric tags in model');
        _cached_numeric_tags = null;
    }

    function getNumericTags(items) {
        if (_cached_numeric_tags != null) {
            console.log('\t\t------------------------------------');
            console.log('\t\t*returning _cached_numeric_tags');
            return _cached_numeric_tags;
        }
        else {
            console.log('\t\t------------------------------------');
            console.log('\t\tCALCULATING NUMERIC TAGS');
            let result = [];
            for (let item of items) {
                if (item.deleted != undefined) {
                    continue;
                }
                for (let sub of item.subitems) {
                    if (sub._numeric_tags == undefined) {
                        continue;
                    }
                    for (let full_tag of sub._numeric_tags) {
                        let tag = full_tag.split('=')[0];
                        if (result.includes(tag) == false) {
                            result.push(tag);
                        }
                    }
                }
            }
            _cached_numeric_tags = result;
            return result;
        }
    }

    function getTagCounts(items) {
        if (_cached_tag_counts != null) {
            return _cached_tag_counts;

        }
        else {
            let result = {};
            for (let item of items) {
                if (item.deleted != undefined) {
                    continue;
                }
                for (let sub of item.subitems) {
                    for (let tag of sub._implied_tags) {
                        if (result[tag] != undefined) {
                            result[tag] += 1;
                        }
                        else {
                            result[tag] = 1;
                        }
                    }
                    for (let tag of sub._direct_tags) {
                        if (result[tag] != undefined) {
                            result[tag] += 1;
                        }
                        else {
                            result[tag] = 1;
                        }
                    }
                    for (let tag of sub._inherited_tags) {
                        if (result[tag] != undefined) {
                            result[tag] += 1;
                        }
                        else {
                            result[tag] = 1;
                        }
                    }
                }
            }
            _cached_tag_counts = result;
            return result;
        }
    }

    function getSubItemIndex(selectedSubitemPath) {
        if (selectedSubitemPath == null) {
            //TODO: deprecated
            return 0;
        }
        else {
            return parseInt(selectedSubitemPath.split(':')[1]);
        }
    }

    function merge(new_items, old_items) {
        console.log('MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM');
        console.log('Merging in $model');
        let start = Date.now();
        new_items.sort(function(a, b){return a.priority-b.priority;});
        old_items.sort(function(a, b){return b.priority-a.priority;});
        
        let merged_result = [];
        let indexed_new = {};
        for (let item of new_items) {
            let full_id = item.id+'/'+item.creation;
            indexed_new[full_id] = item;
        }
        let indexed_old = {};
        for (let item of old_items) {
            let full_id = item.id+'/'+item.creation;
            indexed_old[full_id] = item;
        }

        let merge_result_ids = [];

        //first: go through new items, in order
        let total_new_items = 0;
        let total_old_items = 0;
        for (let item of new_items) {
            let full_id = item.id+'/'+item.creation;
            if (indexed_old[full_id] != undefined) {
                let old_item = indexed_old[full_id];
                if (old_item.last_edit > item.last_edit) {
                    console.log('\tretaining old item for merge: ' + item.id);
                    let cloned = copyJSON(old_item);
                    merged_result.push(cloned);
                    merge_result_ids.push(full_id);
                    total_old_items++;
                }
                else {
                    let cloned = copyJSON(item);
                    merged_result.push(cloned);
                    merge_result_ids.push(full_id);
                    total_new_items++;
                }
            }
            else {
                let cloned = copyJSON(item);
                merged_result.push(cloned);
                merge_result_ids.push(full_id);
                total_new_items++;
            }
        }

        //second: go through old unmatched items in order
        for (let item of old_items) {
            let full_id = item.id+'/'+item.creation;
            if (merge_result_ids.includes(full_id)) {
                continue;
            }
            let cloned = copyJSON(item);
            merged_result.unshift(cloned);
            merge_result_ids.push(full_id);
            total_old_items++;
        }

        let priority = 1;
        for (let item of merged_result) {
            if (item.deleted == undefined) {
                item.priority = priority++;
            }
            else {
                delete item.priority;
            }
        }

        console.log('Total merge results: ' + merged_result.length);
        console.log('New: ' + total_new_items + ' / Old: ' + total_old_items);

        let end = Date.now();
        console.log('MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM');
        console.log('');
        console.log('merge took '+(end-start)+'ms');
        return merged_result;
    }

    function serverTest() {
        return 'This is just a test';
    }

    ///////////////////////////////////////////////////////////////////////////
    // Interface

    return {
        getSubitem: getSubitem,
        addItemFromSearchBar: addItemFromSearchBar,
        addSubItem: addSubItem,
        addNextItem: addNextItem,
        deleteItem: deleteItem,
        removeSubItem: removeSubItem,
        moveUp: moveUp,
        moveUpSubitem: moveUpSubitem,
        moveDown: moveDown,
        moveDownSubitem: moveDownSubitem,
        indentSubitem: indentSubitem,
        outdentSubitem: outdentSubitem,
        updateData: updateData,
        updateTimestamp: updateTimestamp,
        updateSubitemData: updateSubitemData,
        updateTag: updateTag,
        updateSubTag: updateSubTag,
        drag: drag,
        getItemTags: getItemTags,
        getSubItemTags: getSubItemTags,
        getEnrichedAndSortedTagList, getEnrichedAndSortedTagList,
        recalculateAllTags: recalculateAllTags,
        getItemsAsText: getItemsAsText,
        getItemAsText: getItemAsText,
        renameTag: renameTag,
        deleteTag: deleteTag,
        addTagToCurrentView: addTagToCurrentView,
        removeTagFromCurrentView: removeTagFromCurrentView,
        getNextSubitemPath: getNextSubitemPath,
        getPrevSubitemPath: getPrevSubitemPath,
        isValidTag: isValidTag,
        copySubsection: copySubsection,
        pasteSubsection: pasteSubsection,
        toggleCollapse: toggleCollapse,
        collapse: collapse,
        expand: expand,
        getTagCounts: getTagCounts,
        getNumericTags: getNumericTags,
        resetTagCountsCache: resetTagCountsCache,
        resetCachedNumericTags: resetCachedNumericTags,
        getSubItemIndex: getSubItemIndex,
        merge: merge,
        serverTest: serverTest
    };
})();

exports.$model = $model