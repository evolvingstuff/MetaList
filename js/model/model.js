"use strict";

let $model = (function () {

    ///////////////////////////////////////////////////////////////////////////////////////////////////
    // Mutating functions affecting single items

    function addSubItem(item, path) {
        let parts = path.split(':');
        let index = parseInt(parts[1]);
        let indent = item.subitems[index].indent+1
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
        return item.id + ':' + (index);
    }

    function addNextSubItem(item, path) {
        let parts = path.split(':');
        let index = parseInt(parts[1]);
        let indent = item.subitems[index].indent;
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
    }
    
    function updateSubitemData(item, path, text) {
        if (path == null) {
            return;
        }
        let parts = path.split(':');
        let index = parseInt(parts[1]);
        item.subitems[index].data = text;
    }

    function updateTimestamp(item, timestamp) {
        item.timestamp = timestamp;
    }

    function updateData(item, text) {
        item.subitems[0].data = text;
    }

    function updateTag(item, text) {
        item.subitems[0].tags = text;
        _decorateItemTags(item);
    }

    function updateSubTag(item, path, text) {
        let subitem = getSubitem(item, path);
        subitem.tags = text;
        _decorateItemTags(item);
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////
    // Mutating functions affecting all items

    function moveDown(items, selected_item) {

        //get next visible item below
        let closest_selected_below = null;
        for (let i = 0; i < items.length; i++) {
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
        for (let i = 0; i < items.length; i++) { //TODO
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
        for (let i = 0; i < items.length; i++) { //TODO
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
            items[i].priority++;
        }
        return _addItem(items, 1, tags);
    }

    function addNextItem(items, item) {
        for (let i = 0; i < items.length; i++) {
            if (items[i].priority > item.priority) {
                items[i].priority++;
            }
        }
        return _addItem(items, item.priority+1, item.subitems[0].tags);
    }

    function _addItem(items, priority, tags) {
        let new_item = {
            'id': _getNewId(items),
            'priority': priority,
            'timestamp': Date.now(),
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
    }

    function recalculateAllTags(items) {
        for (let item of items) {
            _decorateItemTags(item);
        }
    }

    function _decorateItemTags(item) {

        for (let i = 0; i < item.subitems.length; i++) {
            item.subitems[i]._tags = [];
            delete item.subitems[i]._numeric_tags;
            let tags = item.subitems[i].tags.split(' ');
            for (let tag of tags) {
                let content = tag.trim();
                if (_isAValidTag(content) && item.subitems[i]._tags.includes(content) == false) {
                    item.subitems[i]._tags.push(content);
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
                    }
                }
            }
        }

        //If contains @meta, then we want to add all valid tags within the item.data itself
        //TODO: how will this work with numeric tags?
        for (let i = 0; i < item.subitems.length; i++) {
            if (item.subitems[i]._tags.includes('@meta')) {
                let text = $format.toText(item.subitems[i].data);
                for (let line of text.split('\n')) {
                    for (let part of line.split(' ')) {
                        let content = part.trim();
                        if (_isAValidTag(content) && item.subitems[i]._tags.includes(content) == false) {
                            item.subitems[i]._tags.push(content);
                        }
                    }
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
                    }


                }
            }

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
                            if (_isAValidTag(attribute) && item.subitems[j]._tags.includes(attribute) == false) {
                                item.subitems[j]._tags.push(attribute);
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
            result += getItemAsText(item, 0);
            result += "\n";
        }
        return result;
    }

    function getItemAsText(item, depth) {

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
        let result = '';
        for (let sub of item.subitems) {
            if (sub.tags != undefined && sub.tags.trim() != '') {
                result += sub.tags.trim() + ' ';
            }
        }
        return result.trim();
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
        let parts = path.split(':');
        let index = parseInt(parts[1]);
        return item.subitems[index];
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
        //TODO: needs work to handle numeric tags
        //TODO: modify search filter...
        console.log('$model.renameTag() '+tagname1+' -> '+tagname2)
        if (_isAValidTag(tagname2) == false) {
            alert('ERROR: target tagname is not valid.');
            return;
        }
        let tot = 0;
        for (let item of items) {
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
        }
        console.log('Pushed '+updates+' new tags ');
    }

    function removeTagFromCurrentView(items, tagname) {
        //TODO: needs more work to properly handle meta tags...
        //TODO: modify search filter...
        let tot = 0;
        for (let item of items) {
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
        clipboard.push(JSON.parse(JSON.stringify(item.subitems[subitem_index])));
        for (let i = subitem_index+1; i < item.subitems.length; i++) {
            if (item.subitems[i].indent > base_indent) {
                clipboard.push(JSON.parse(JSON.stringify(item.subitems[i])));
            }
            else {
                break;
            }
        }
        for (let subitem of clipboard) {
            subitem.indent -= base_indent;
            delete subitem._include;
            delete subitem._tags;
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
                let sub_copy = JSON.parse(JSON.stringify(subitem));
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
            return subitem_index;
        }
        else {
            //Append to subitems with data
            let base_indent = Math.max(1, item.subitems[subitem_index].indent);
            let index_into = subitem_index+1;
            for (let subitem of subsection_clipboard) {
                let sub_copy = JSON.parse(JSON.stringify(subitem));
                sub_copy.indent += base_indent;
                item.subitems.splice(index_into++,0,sub_copy);
            }
            _decorateItemTags(item);
            return subitem_index+1;
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
        expand: expand
    };
})();