"use strict";

let $model = (function () {

    ///////////////////////////////////////////////////////////////////////////////////////////////////
    // Mutating functions affecting single items

    const ADD_FOLDING_BY_DEFAULT = false;
    const ADD_TO_TOP_OF_LIST = false;
    const TEST_CONSISTENCY = true;
    const ADD_IMPLICATIONS_TO_COUNTS = false;
    const CLEAN_HTML = true;

    let items = [];
    let item_cache = {};
    let all_tags_cache = null;
    let timestampLastUpdate = 0;

    function testConsistency() {
        let t1 = Date.now();
        let totNullPrev = 0;
        let totNullNext = 0;
        let mapById = {};
        try {
            for (let item of items) {
                mapById[item.id] = item;
            }
            for (let item of items) {
                if (item.prev !== null) {
                    if (mapById[item.prev].next !== item.id) {
                        console.error(item);
                        console.error(mapById[item.prev]);
                        console.error('mapById[item.prev].next ('+mapById[item.prev].next+') !== item.id ('+item.id+')');
                        debugger;
                        throw "Order inconsistency";
                    }
                }
                else {
                    totNullPrev += 1;
                }
                if (item.next !== null) {
                    if (mapById[item.next].prev !== item.id) {
                        console.error(item);
                        console.error(mapById[item.next]);
                        console.error('mapById[item.next].prev ('+mapById[item.next].prev+') !== item.id ('+item.id+')');
                        throw "Order inconsistency";
                    }
                }
                else {
                    totNullNext += 1;
                }
            }
            if (items.length > 0) {
                if (totNullNext !== 1) {
                    throw "totNullNext = " + totNullNext;
                }
                if (totNullPrev !== 1) {
                    throw "totNullPrev = " + totNullPrev;
                }
            }
        }
        catch (e) {
            console.error(e);
            debugger;
            $view.gotoErrorPageFailedConsistencyTest();
            return;
        }
        let t2 = Date.now();
        //console.log('PASSED CONSISTENCY TEST. $model.testConsistency() took '+(t2-t1)+'ms over '+items.length+' items');
    }

    function getSortedItems() {
        if (items.length === 0) {
            return [];
        }
        let mapByPrev = {};
        for (let item of items) {
            mapByPrev[item.prev] = item;
        }
        let result = [];
        let prevId = null;
        let prevItem = null;
        while (true) {
            if (mapByPrev[prevId] === undefined) {
                break;
            }
            prevItem = mapByPrev[prevId];
            result.push(prevItem);
            prevId = prevItem.id;
        }
        if (result.length !== items.length) {
            alert('ERROR: sorted items is not equal to length of items ('+result.length+' vs '+items.length+')');
            console.error('ERROR: sorted items is not equal to length of items ('+result.length+' vs '+items.length+')');
            throw "Sorted items broken";
        }
        return result;
    }

    function getTimestampLastUpdate() {
        return timestampLastUpdate;
    }

    function setTimestampLastUpdate(newTimestampLastUpdate) {
        timestampLastUpdate = newTimestampLastUpdate;
    }

    function _onUpdateContent(item, tags_may_have_changed) {
        if (TEST_CONSISTENCY) {
            testConsistency();
        }
        timestampLastUpdate = Date.now();
        if (item !== undefined && item !== null) { 
            item.last_edit = timestampLastUpdate;
        }
        if (tags_may_have_changed) {
            all_tags_cache = null;
            $ontology.maybeRecalculateOntology();
        }
    }

    function getItemById(id) {
        if (id === null) {
            return null;
        }
        if (item_cache[id] !== undefined) {
            return item_cache[id];
        }
        else {
            for (let i = 0; i < items.length; i++) {
                item_cache[items[i].id] = items[i];
            }
            if (item_cache[id] !== undefined) {
                return item_cache[id];
            }
            else {
                return null;
            }
        }
    }

    function getUnsortedItems() {
        return items;
    }

    function getFilteredItems() {
        let sortedItems = getSortedItems();
        let filtered = [];
        for (let item of sortedItems) {
            if (item.subitems[0]._include !== 1) {
                continue;
            }
            filtered.push(item);
        }
        return filtered;
    }

    function setItems(new_items) { 
        items = new_items;
        if (TEST_CONSISTENCY) {
            $model.testConsistency();
        }
        item_cache = {};
        for (let item of items) {
            item_cache[item.id] = item;
        }
        $model.recalculateAllTags();
        $auto_complete_search.onChange();
        $ontology.maybeRecalculateOntology();
        timestampLastUpdate = Date.now();
    }

    function addSubItem(item, subitemIndex, extraIndent) {

        let indent = 1; //Always fixed indent under root subitem
        if (subitemIndex > 0) {
            indent = item.subitems[subitemIndex].indent;
            if (extraIndent) {
                indent += 1;
            }
        }

        if (ADD_FOLDING_BY_DEFAULT && 
            subitemIndex > 0 && 
            extraIndent) {
            if (item.subitems[subitemIndex].collapse !== undefined) {
                delete item.subitems[subitemIndex].collapse;
            }
        }

        let subitem = { 
            'data': '',
            'tags': '', 
            'indent': indent, 
            '_include': 1 
        };
        subitemIndex += 1;
        while (subitemIndex < item.subitems.length && item.subitems[subitemIndex].indent > indent) {
            subitemIndex++;
        }
        item.subitems.splice(subitemIndex,0,subitem);

        _decorateItemTags(item);
        _onUpdateContent(item, false);
        return item.id + ':' + subitemIndex;
    }

    function removeSubItem(item, path) {
        if (path === null) {
            return;
        }
        let parts = path.split(':');
        let index = parseInt(parts[1]);
        let indent = item.subitems[index].indent;
        item.subitems.splice(index, 1);
        while (item.subitems.length > index && item.subitems[index].indent > indent) {
            item.subitems.splice(index, 1);
        }
        //potentially redecorate other items??
        _decorateItemTags(item);
        _onUpdateContent(item, true);
    }

    function removeSubitemFormatting(item, subitemIndex) {
        let data = item.subitems[subitemIndex].data;
        item.subitems[subitemIndex].data = $format.convertToTextyHTML(data);
        _onUpdateContent(item, false);
    }

    function extract(item, subitemIndex, tags) {
        if (subitemIndex === 0) {
            alert('Cannot extract at the item level; only subitems');
            return false;
        }
        let clipboard = copySubsection(item, subitemIndex)
        let newItem = addItemFromSearchBar(tags);
        pasteSubsection(newItem, 0, clipboard);
        let path = item.id+':'+subitemIndex;
        removeSubItem(item, path);
        _decorateItemTags(item);
        _onUpdateContent(item, false);
        return true;
    }

    function split(item, subitemIndex) {
        let sections = $format.splitIntoSubsections(item.subitems[subitemIndex].data);

        if (sections.length === 1) {
            console.log('Nothing split');
            return;
        }

        for (let i = 1; i < sections.length; i++) {
            addSubItem(item, subitemIndex, false);
        }
        for (let i = 0; i < sections.length; i++) {
            item.subitems[subitemIndex+i].data = sections[i];
        }
        if (subitemIndex !== 0) {
            //If we are splitting from a subitem, copy its tags
            //But not if it is the title item as they will inherit anyway
            for (let i = 1; i < sections.length; i++) {
                item.subitems[subitemIndex+i].tags = item.subitems[subitemIndex].tags;
            }
        }
        _decorateItemTags(item);
        _onUpdateContent(item, false);
    }

    function moveUpSubitem(item, path) {
        let parts = path.split(':');
        let index = parseInt(parts[1]);
        if (index === 1) {
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
        else if (item.subitems[b0].indent === indent) {
            //do nothing
        }
        else {
            for (let i = index-2; i > 0; i--) {
                if (item.subitems[i].indent < indent) {
                    break; //should never reach here
                }
                if (item.subitems[i].indent === indent) {
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
        _onUpdateContent(item, false);
        return item.id + ':' + b0;
    }

    function moveDownSubitem(item, path) {
        let parts = path.split(':');
        let index = parseInt(parts[1]);
        if (index === item.subitems.length-1) {
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
        _onUpdateContent(item, false);
        return new_path;
    }

    function indentSubitem(item, path) {
        let parts = path.split(':');
        let index = parseInt(parts[1]);
        if (index < 2) {
            return path;
        }
        let indent = item.subitems[index].indent;

        let validParent = false;
        let validParentIndex = -1;
        for (let i = index-1; i >= 1; i--) {
            if (item.subitems[i].indent < indent) {
                validParent = false;
                break;
            }
            if (item.subitems[i].indent === indent || item.subitems[i].indent === indent+1) {
                validParent = true;
                validParentIndex = i;
                break;
            }
        }
        if (validParent === false) {
            return path;
        }

        if (ADD_FOLDING_BY_DEFAULT) {
            if (item.subitems[index].collapse !== undefined) {
                delete item.subitems[index].collapse;
            }
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

        //Open any parent subitems
        //This could happen if a subitem was indented into a list above,
        //and that list was @folded
        
        //TODO fix auto unfolding

        _decorateItemTags(item);
        _onUpdateContent(item, false);
        return path;
    }

    function unindentSubitem(item, path) {
        let parts = path.split(':');
        let index = parseInt(parts[1]);
        if (index < 2) {
            return path;
        }
        let indent = item.subitems[index].indent;

        if (indent === 1) {
            return path;
        }
        
        let validParent = false;
        let validParentIndex = -1;
        for (let i = index-1; i >= 1; i--) {
            if (item.subitems[i].indent === indent || item.subitems[i].indent === indent-1) {
                validParent = true;
                validParentIndex = i;
                break;
            }
        }
        if (validParent === false) {
            return path;
        }

        if (ADD_FOLDING_BY_DEFAULT) {
            if (item.subitems[validParentIndex].collapse !== undefined) {
                delete item.subitems[validParentIndex].collapse;
            }
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
        _onUpdateContent(item, false);
        return path;
    }
    
    function updateSubitemData(item, path, text) {
        if (path === null) {
            return;
        }
        let parts = path.split(':');
        let index = parseInt(parts[1]);

        if (CLEAN_HTML) {
            text = $format.cleanHtmlNoise(text);
        }

        item.subitems[index].data = text;
        _onUpdateContent(item, false);
    }

    function updateTimestamp(item, timestamp) {
        item.timestamp = timestamp;
        _onUpdateContent(item, false);
    }

    function updateSubTag(item, path, text) {
        let subitem = getSubitem(item, path);
        subitem.tags = text;
        _decorateItemTags(item);
        _onUpdateContent(item, true);
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////
    // Mutating functions affecting all items

    function moveDown(selected_item) {

        let result = [];

        let before_A = getItemById(selected_item.prev);
        let A = selected_item;
        let after_A = getItemById(selected_item.next);

        let before_B = null;
        let B = null;
        let after_B = null;

        let sortedItems = getSortedItems();
        let already_matched_A = false;

        for (let item of sortedItems) {
            if (item.subitems[0]._include === -1) {
                continue;
            }
            if (already_matched_A) {
                result.push(item);
                before_B = getItemById(item.prev);
                B = item;
                after_B = getItemById(item.next);
                break;
            }
            if (item.id === A.id) {
                already_matched_A = true;
                result.push(item);
            }
        }

        if (B === null) {
            return [];
        }

        _down(before_A, A, after_A, before_B, B, after_B);
        
        timestampLastUpdate = Date.now();
        return result;
    }

    function moveUp(selected_item) {

        let result = [];

        let before_A = null;
        let A = null;
        let after_A = null;

        let before_B = getItemById(selected_item.prev);
        let B = selected_item;
        let after_B = getItemById(selected_item.next);

        let sortedItems = getSortedItems();
        sortedItems.reverse();
        let already_matched_B = false;

        for (let item of sortedItems) {
            if (item.subitems[0]._include === -1) {
                continue;
            }
            if (already_matched_B) {
                result.push(item);
                before_A = getItemById(item.prev);
                A = item;
                after_A = getItemById(item.next);
                break;
            }
            if (item.id === B.id) {
                already_matched_B = true;
                result.push(item);
            }
        }

        if (A === null) {
            return [];
        }

        _up(before_A, A, after_A, before_B, B, after_B);
        
        timestampLastUpdate = Date.now();
        return result;
    }

    function _down(before_A, A, after_A, before_B, B, after_B) {
        if (before_A !== null) {
            if (after_A !== null) {
                before_A.next = after_A.id;
            }
            else {
                before_A.next = null;
            }
        }

        if (after_A !== null) {
            if (before_A !== null) {
                after_A.prev = before_A.id;
            }
            else {
                after_A.prev = null;
            }
        }

        B.next = A.id;
        A.prev = B.id;

        if (after_B !== null) {
            after_B.prev = A.id;
            A.next = after_B.id;
        }
        else {
            A.next = null;
        }
    }

    function _up(before_A, A, after_A, before_B, B, after_B) {
        
        if (before_B !== null) {
            if (after_B !== null) {
                before_B.next = after_B.id;
            }
            else {
                before_B.next = null;
            }
        }

        if (after_B !== null) {
            if (before_B !== null) {
                after_B.prev = before_B.id;
            }
            else {
                after_B.prev = null;
            }
        }

        B.next = A.id;
        A.prev = B.id;

        if (before_A !== null) {
            before_A.next = B.id;
            B.prev = before_A.id;
        }
        else {
            B.prev = null;
        }
    }

    function dragSubitem(item, subitemIndex1, subitemIndex2) {

        let path = item.id + ':' + subitemIndex1;

        if (subitemIndex1 === 0 || subitemIndex2 === 0) {
            return path;
        }

        if (item.subitems[subitemIndex1].indent !== item.subitems[subitemIndex2].indent) {
            alert('Cannot swap items at different indent levels, yet');
            return path;
        }
        
        if (subitemIndex1 > subitemIndex2) {
            let count = 0;
            let valid = true;
            for (let i = subitemIndex2+1; i <= subitemIndex1; i++) {
                if (item.subitems[i].indent === item.subitems[subitemIndex1].indent) {
                    count += 1;
                }
                else if (item.subitems[i].indent < item.subitems[subitemIndex1].indent) {
                    valid = false;
                    break;
                }
            }
            if (valid) {
                for (let i = 0; i < count; i++) {
                    path = moveUpSubitem(item, path);
                }
            }
        }
        else if (subitemIndex1 < subitemIndex2) {
            let count = 0;
            let valid = true;
            for (let i = subitemIndex1+1; i <= subitemIndex2; i++) {
                if (item.subitems[i].indent === item.subitems[subitemIndex1].indent) {
                    count += 1;
                }
                else if (item.subitems[i].indent < item.subitems[subitemIndex1].indent) {
                    valid = false;
                    break;
                }
            }
            if (valid) {
                for (let i = 0; i < count; i++) {
                    path = moveDownSubitem(item, path);
                }
            }
        }
        else {
            alert('Unexpected: dragging onto same subitem?');
        }

        return path;
    }

    function drag(item1, item2) {

        if (item1.id === item2.id) {
            return [];
        }

        let sortedItems = getSortedItems();
        for (let item of sortedItems) {
            if (item.subitems[0]._include !== 1) {
                continue;
            }
            if (item.id === item1.id) {
                return dragDown(item1, item2, sortedItems);
            }
            if (item.id === item2.id) {
                return dragUp(item1, item2, sortedItems);
            }
        }

        console.warn('could not find items to drag');

        return [];
    }

    function dragDown(item1, item2, sortedItems) {

        let result = [];
        let startMatch = false;
        for (let item of items) {
            if (item.subitems[0]._include !== 1) {
                continue;
            }
            if (item.id === item1.id) {
                startMatch = true;
            }
            if (startMatch) {
                result.push(item);
            }
            if (item.id === item2.id) {
                break;
            }
        }

        let before_A = getItemById(item1.prev);
        let A = item1;
        let after_A = getItemById(item1.next);

        let before_B = getItemById(item2.prev);
        let B = item2;
        let after_B = getItemById(item2.next);

        if (B === null) {
            return [];
        }

        _down(before_A, A, after_A, before_B, B, after_B);

        if (TEST_CONSISTENCY) {
            testConsistency();
        }

        timestampLastUpdate = Date.now();
        return result;
    }

    function dragUp(item1, item2, sortedItems) {
        let result = [];
        let startMatch = false;
        for (let item of sortedItems.reverse()) {
            if (item.subitems[0]._include !== 1) {
                continue;
            }
            if (item.id === item2.id) {
                startMatch = true;
            }
            if (startMatch) {
                result.push(item);
            }
            if (item.id === item1.id) {
                break;
            }
        }

        let before_A = getItemById(item2.prev);
        let A = item2;
        let after_A = getItemById(item2.next);

        let before_B = getItemById(item1.prev);
        let B = item1;
        let after_B = getItemById(item1.next);

        if (A === null) {
            return [];
        }

        _up(before_A, A, after_A, before_B, B, after_B);

        if (TEST_CONSISTENCY) {
            testConsistency();
        }

        if (TEST_CONSISTENCY) {
            testConsistency();
        }

        timestampLastUpdate = Date.now();

        return result;
    }

    function _getNewId() {
        let maxId = 0;
        for (let i = 0; i < items.length; i++) {
            //this includes deleted items
            if (items[i].id > maxId) {
                maxId = items[i].id;
            }
        }
        return maxId+1;
    }

    function addItemFromSearchBar(tags) {

        if (tags == null) {
            throw "Tags is null in $model.addItemFromSearchBar(), unexpected";
        }

        let prev = null;
        let next = null;

        let newId = _getNewId();

        let firstItem = null;

        for (let i = 0; i < items.length; i++) {
            if (items[i].prev === null) {
                firstItem = items[i];
            }
        }
        
        if (firstItem !== null) {
            next = firstItem.id;
            firstItem.prev = newId;
        }

        for (let tag of PROTECTED_TAGS) {
            tags = replaceAll(tags, tag, '');
        }
        tags = tags.replace(/  +/g, ' ');

        let now = Date.now();

        let newItem = {
            'id': newId,
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
            ],
            'prev': prev,
            'next': next
        };
        _decorateItemTags(newItem);
        items.unshift(newItem);
        timestampLastUpdate = now;
        _onUpdateContent(newItem, true);

        if (ADD_TO_TOP_OF_LIST === false) {
            fullyIncludeItem(newItem);
            let filteredItems = getFilteredItems();
            if (filteredItems.length > 1) {
                let secondTopItem = filteredItems[1];
                // Warning: This is a bit of a hack
                // The first call to drag moves it immediate below the secondTopItem
                // The second call moves it above
                drag(newItem, secondTopItem);
                drag(newItem, secondTopItem);
            }
        }

        return newItem;
    }

    function deleteItem(item) {

        //stitch together linked list
        let prevItem = null;
        let nextItem = null;
        for (let otherItem of items) {
            if (otherItem.prev === item.id) {
                nextItem = otherItem;
            }
            if (otherItem.next === item.id) {
                prevItem = otherItem;
            }
        }

        if (nextItem !== null) {
            if (prevItem !== null) {
                nextItem.prev = prevItem.id;
            }
            else {
                nextItem.prev = null;
            }
        }

        if (prevItem !== null) {
            if (nextItem !== null) {
                prevItem.next = nextItem.id;
            }
            else {
                prevItem.next = null;
            }
        }

        delete item_cache[item.id];

        /////////////////////////////////////////////////////
        let length1 = items.length;
        let index = items.indexOf(item);
        if (index > -1) {
            items.splice(index, 1);
        }

        let length2 = items.length;
        if (length2 !== length1-1) {
            alert('ERROR: unexpected result when trying to delete item');
        }

        _onUpdateContent(null, true);
        /////////////////////////////////////////////////////

        //update broken links
        // for (let other_item of items) {
        //     for (let subitem of other_item.subitems) {
        //         if (subitem._direct_tags.includes(META_GOTO)) {
        //             let parts = subitem.data.split(META_ID+'=');
        //             if (parts.length > 1) {
        //                 let parts2 = parts[1].split(' ');
        //                 if (parts2[0].length > 0) {
        //                     let broken_id = parts2[0];
        //                     if (broken_id === item.id) {
        //                         subitem.tags = subitem.tags.replace(META_GOTO, META_BROKEN_SEARCH);
        //                         subitem.data = 'Broken reference to '+META_ID+'='+broken_id;
        //                     }
        //                 }
        //             }
        //         }
        //     }
        // }
        
        /////////////////////////////////////////////////////
        let has_meta = false;
        for (let subitem of item.subitems) {
            if (subitem._direct_tags.includes(META_IMPLIES)) {
                has_meta = true;
                break;
            }
        }

        if (has_meta) {
            for (let it of items) {
                _decorateItemTags(it);
            }
        }
        
        resetTagCountsCache();
        getTagCounts();
        
    }

    function recalculateAllTags() {
        //we don't need to do this first part if no meta tags changed I think
        for (let item of items) {
            _decorateItemTags(item);
        }
        resetTagCountsCache();
        getTagCounts();
    }

    function _decorateItemTags(item) {

        item._tags = new Set();

        for (let i = 0; i < item.subitems.length; i++) {
            //clean tags
            item.subitems[i]._tags = [];
            item.subitems[i]._direct_tags = [];
            item.subitems[i]._inherited_tags = [];
            item.subitems[i]._implied_tags = [];
            delete item.subitems[i]._attribute_tags;

            //get direct tags and attribute tags
            let tags = item.subitems[i].tags.split(' ');
            for (let tag of tags) {
                let content = tag.trim();
                if (_isAValidTag(content) && item.subitems[i]._tags.includes(content) === false) {
                    item.subitems[i]._tags.push(content);
                    item.subitems[i]._direct_tags.push(content);
                }

                if (_isAValidAttributeTag(content)) {
                    if (item.subitems[i]._attribute_tags === undefined) {
                        item.subitems[i]._attribute_tags = [];
                    }
                    if (item.subitems[i]._attribute_tags.includes(content) === false) {
                        item.subitems[i]._attribute_tags.push(content);
                    }

                    let attribute = content.split('=')[0];
                    if (_isAValidTag(attribute) && item.subitems[i]._tags.includes(attribute) === false) {
                        item.subitems[i]._tags.push(attribute);
                        item.subitems[i]._direct_tags.push(attribute);
                    }
                }
            }

            //If contains @implies, then we want to add all valid tags within the item.data itself
            //TODO: how will this work with attribute tags?

            if (item.subitems[i]._tags.includes(META_IMPLIES)) {
                let text = $format.toText(item.subitems[i].data);
                for (let line of text.split('\n')) {
                    for (let part of line.split(' ')) {
                        let content = part.trim();
                        if (_isAValidTag(content) && item.subitems[i]._tags.includes(content) === false) {
                            item.subitems[i]._tags.push(content);
                            item.subitems[i]._direct_tags.push(content);
                        }
                    }
                }
            }

            let enriched = $ontology.getEnrichedTags(item.subitems[i]._direct_tags);
            for (let tag of enriched) {
                if (item.subitems[i]._direct_tags.includes(tag) === false) {
                    item.subitems[i]._implied_tags.push(tag);
                }
            }

            for (let tag of item.subitems[i]._tags) {
                item._tags.add(tag);
            }

            for (let tag of item.subitems[i]._implied_tags) {
                item._tags.add(tag);
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
                    if (_isAValidTag(content) === false) {
                        continue;
                    }
                    if (item.subitems[j]._tags.includes(content)) {
                        continue;
                    }
                    if (CASCADING_META_TAGS.includes(tag) === false && tag.startsWith(META_PREFIX)) {
                        //do not cascade meta tags down, with exceptions
                        continue;
                    }

                    item.subitems[j]._tags.push(content);
                    item.subitems[j]._inherited_tags.push(content);
                }
            }

            if (DOWNPROPAGATE_NUMERIC_TAGS) {
                if (item.subitems[i]._attribute_tags !== undefined) {
                    let tags = item.subitems[i]._attribute_tags;
                    for (let j = i+1; j < item.subitems.length; j++) {
                        if (item.subitems[j].indent <= item.subitems[i].indent) {
                            break;
                        }
                        for (let tag of tags) {
                            let content = tag.trim();
                            if (_isAValidAttributeTag(content)) {
                                if (item.subitems[j]._attribute_tags === undefined) {
                                    item.subitems[j]._attribute_tags = [];
                                }
                                if (item.subitems[j]._attribute_tags.includes(content) === false) {
                                    item.subitems[j]._attribute_tags.push(content);
                                }

                                let attribute = content.split('=')[0];
                                if (_isAValidTag(attribute) && item.subitems[j]._tags.includes(attribute) === false &&
                                    (tag.startsWith(META_PREFIX) === false)) {
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

    function getItemsAsText(scope_items) {
        let result = '';
        for (let item of scope_items) {
            result += getItemAsText(item, 0);
            result += "\n";
        }
        return result;
    }

    //TODO: remove unincluded subitems
    function getItemAsText(item, depth) {

        let result = '';
        for (let sub of item.subitems) {
            //TODO: add attribute tags here!
            result += v.stripTags($format.decodeHTMLEntities(sub.data, sub.indent));
            if (sub._tags !== undefined && sub._tags !== null) {
                result += ' |';
                for (let tag of sub._tags) {
                    result += ' #' + tag;
                }
            }
            result += '\n\n';
        }
        return result;
    }

    function getAllTags() {

        if (all_tags_cache !== null) {
            return all_tags_cache;
        }

        let temp = {};
        for (let item of items) {
            for (let subitem of item.subitems) {
                for (let t of subitem._direct_tags) {
                    if (temp[t] === undefined) {
                        temp[t] = 1;
                    }
                    else {
                        temp[t] += 1;
                    }
                }

                for (let t of subitem._inherited_tags) {
                    if (temp[t] === undefined) {
                        temp[t] = 1;
                    }
                    else {
                        temp[t] += 1;
                    }
                }

                for (let t of subitem._implied_tags) {
                    if (temp[t] === undefined) {
                        temp[t] = 1;
                    }
                    else {
                        temp[t] += 1;
                    }
                }

                if (subitem._attribute_tags !== undefined) {
                    for (let t of subitem._attribute_tags) {
                        let tag = t.split('=')[0];
                        if (temp[tag] === undefined) {
                            temp[tag] = 1;
                        }
                        else {
                            temp[tag] += 1;
                        }
                    }
                } 
            }
        }

        // Create items array
        let sorted = Object.keys(temp).map(function(key) {
          return [key, temp[key]];
        });

        // Sort the array based on the second element
        sorted.sort(function(first, second) {
          return second[1] - first[1];
        });

        let result = [];
        for (let entry of sorted) {
            result.push(entry[0]);
        }
        all_tags_cache = result;
        return all_tags_cache;
    }
    
    //This gets tags at just leaf node
    function getSubItemTags(item, subitem_path) {
        if (subitem_path === undefined || subitem_path === null || subitem_path === '') {
            if (item.subitems[0].tags === undefined || item.subitems[0].tags === null) {
                console.warn('no tags found for this item');
            }
            return item.subitems[0].tags;
        }
        else {
            let subitem = getSubitem(item, subitem_path);
            if (subitem.tags === undefined || subitem.tags === null) {
                console.warn('no tags found for this subitem. Removing.');
                subitem.tags = '';
            }
            return subitem.tags;
        }
    }

    //TODO: move into parser code?
    let _cache_is_valid = {};
    let _cache_is_valid_attribute = {};
    let re = new RegExp("^([a-z0-9A-Z_#@][a-z0-9A-Z-_./:#@!+'&]*)$");

    //TODO: this should have a separate parser
    function isValidTag(content) {
        return _isAValidTag(content);
    }

    function _isAValidTag(content) {
        if (content.trim() === '') {
            return false;
        }

        if (_cache_is_valid[content] !== undefined) {
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

    function _isAValidAttributeTag(content) {
        if (content.trim() === '') {
            return false;
        }

        let parts = content.split('=');

        if (parts.length !== 2) {
            _cache_is_valid_attribute[content] = false;
            return false;
        }

        if (_isAValidTag(parts[0]) === false) {
            _cache_is_valid_attribute[content] = false;
            return false;
        }

        // if (isNaN(parts[1])) {
        //     _cache_is_valid_attribute[content] = false;
        //     return false;
        // }

        if (_isAValidTag(parts[1]) === false) {
            _cache_is_valid_attribute[content] = false;
            return false;
        }

        _cache_is_valid_attribute[content] = true;
        return true;
    }
    
    function getSubitem(item, path) {
        if (item === null) {
            return null;
        }
        if (item.subitems === undefined) {
            return null;
        }
        if (path === null) {
            return item.subitems[0];
        }
        let parts = path.split(':');
        let index = parseInt(parts[1]);
        return item.subitems[index];
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////
    // Non-mutating functions of multiple item

    function getEnrichedAndSortedTagList(filter) {
        let all_tags = {};
        for (let i = 0; i < items.length; i++) {

            for (let sub of items[i].subitems) {

                if (filter && sub._include !== 1) {
                    continue;
                }

                for (let direct_tag of sub._direct_tags) {
                    if (all_tags[direct_tag] !== undefined) {
                        all_tags[direct_tag] += 1;
                    }
                    else {
                        all_tags[direct_tag] = 1;
                    }
                }

                for (let implied_tag of sub._implied_tags) {
                    if (all_tags[implied_tag] !== undefined) {
                        all_tags[implied_tag] += 1;
                    }
                    else {
                        all_tags[implied_tag] = 1;
                    }
                }

                for (let inherited_tag of sub._inherited_tags) {
                    if (all_tags[inherited_tag] !== undefined) {
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

    function renameTag(tagname1, tagname2) {
        //TODO: needs work to handle attribute tags
        //TODO: modify search filter...
        if (_isAValidTag(tagname2) === false) {
            alert('ERROR: target tagname is not valid.');
            return;
        }
        let tot = 0;
        for (let item of items) {
            let modification = false;
            for (let flat of item.subitems) {
                if (flat.tags === undefined || flat.tags === null) {
                    continue;
                }
                let tags = flat.tags.trim().split(' ');
                let updated_tags = [];
                let has1 = false;
                for (let tag of tags) {
                    if (tag.trim() !== '') {
                        if (tag === tagname1) {
                            has1 = true;
                            updated_tags.push(tagname2);
                        }
                        else {
                            updated_tags.push(tag);
                        }
                    }
                }
                if (has1) {
                    flat.tags = updated_tags.join(' ');
                    modification = true;
                }
            }
            if (modification) {
                tot += 1;
                _onUpdateContent(item, true);
                _decorateItemTags(item);
            }
        }

        //update meta tags
        for (let item of items) {
            let modification = false;
            for (let subitem of item.subitems) {
                if (subitem._direct_tags.includes(META_IMPLIES) === false) {
                    continue;
                }
                let data = subitem.data;
                data = data.replace(/<div>/g, ' <div> '); //TODO: this is a hack
                data = data.replace(/<\/div>/g, ' </div> ');
                let parts = data.split(' ');
                if (parts.includes(tagname1) === false) {
                    continue;
                }
                for (let i = 0; i < parts.length; i++) {
                    if (parts[i] === tagname1) {
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
                _onUpdateContent(item, true);
                _decorateItemTags(item);
            }
        }

        if (tot > 0) {
            console.log('Modified ' + tot + ' items');
        }
    }

    function replaceText(text1, text2) {
        if (text1.trim() === '') {
            alert('Cannot replace empty string');
            return false;
        }
        //TODO: allow for regex?
        let tot = 0;
        for (let item of items) {
            let modification = false;
            for (let subitem of item.subitems) {
                let pre = subitem.data;
                let post = v.replaceAll(pre, text1, text2);
                if (pre !== post) {
                    subitem.data = post;
                    modification = true;
                    tot += 1;   
                }
            }
            if (modification) {
                _onUpdateContent(item, false);
            }
        }
        if (tot > 0) {
            console.log('Modified ' + tot + ' subitems');
            return true;
        }
        else {
            alert('No matches found');
            return false;
        }
    }

    function deleteTag(tagname) {
        //TODO: needs more work to properly handle meta tags...
        //TODO: make work with attribute tags
        //TODO: modify search filter...
        let tot = 0;
        for (let item of items) {
            let modification = false;
            for (let flat of item.subitems) {
                if (flat.tags === undefined || flat.tags === null) {
                    continue;
                }
                let tags = flat.tags.trim().split(' ');
                let updated_tags = [];
                let has1 = false;
                for (let tag of tags) {
                    if (tag.trim() !== '') {
                        if (tag === tagname) {
                            has1 = true;
                            //do not add to updated array
                        }
                        else {
                            updated_tags.push(tag);
                        }
                    }
                }
                if (has1) {
                    flat.tags = updated_tags.join(' ');
                    modification = true;
                }
            }
            if (modification) {
                tot += 1;
                _decorateItemTags(item);
                _onUpdateContent(item, true);
            }
        }
        if (tot > 0) {
            console.log('Modified ' + tot + ' items');
        }
    }

    function addTagToSubitem(item, subitemIndex, newTag, frontLoad) {
        let tags = item.subitems[subitemIndex].tags.trim().split(' ');
        if (tags.includes(newTag) === false) {
            if (frontLoad) {
                tags.unshift(newTag);
            }
            else {
                tags.push(newTag);
            }
        }
        item.subitems[subitemIndex].tags = tags.join(' ');
    }

    function removeTagFromSubitem(item, subitemIndex, tag) {
        let tags = item.subitems[subitemIndex].tags.trim().split(' ');
        let index = tags.indexOf(tag);
        if (index !== -1) {
            tags.splice(tag, 1);
        }
        item.subitems[subitemIndex].tags = tags.join(' ');
    }

    function addTagToCurrentView(new_tag) {
        if (_isAValidTag(new_tag) === false) {
            alert('ERROR: target tagname is not valid.');
            return;
        }
        let updates = 0;
        for (let item of items) {
            if (item.subitems[0]._include !== 1) {
                continue;
            }
            let tags = item.subitems[0].tags.trim().split(' ');
            if (tags.includes(new_tag) === false) {
                tags.push(new_tag);
                updates += 1;
            }
            item.subitems[0].tags = tags.join(' ');
            _decorateItemTags(item);
            _onUpdateContent(item, true);
        }
        console.log('Pushed '+updates+' new tags ');
    }

    function removeTagFromCurrentView(tagname) {
        //TODO: needs more work to properly handle meta tags...
        //TODO: modify search filter...
        let tot = 0;
        for (let item of items) {
            if (item.subitems[0]._include !== 1) {
                continue;
            }
            let modification = false;
            for (let flat of item.subitems) {
                if (flat.tags === undefined || flat.tags === null) {
                    continue;
                }
                let tags = flat.tags.trim().split(' ');
                let updated_tags = [];
                let has1 = false;
                for (let tag of tags) {
                    if (tag.trim() !== '') {
                        if (tag === tagname) {
                            has1 = true;
                            //do not add to updated array
                        }
                        else {
                            updated_tags.push(tag);
                        }
                    }
                }
                if (has1) {
                    flat.tags = updated_tags.join(' ');
                    modification = true;
                }
            }
            if (modification) {
                tot += 1;
                _decorateItemTags(item);
                _onUpdateContent(item, true);
            }
        }
        if (tot > 0) {
            console.log('Modified ' + tot + ' items');
        }
    }

    function getNextSubitemPath(selected_item, selectedSubitemPath) {

        if (selectedSubitemPath === null) { 
            selectedSubitemPath = selected_item.id+':0';
        }

        let parts = selectedSubitemPath.split(':');
        let index = parseInt(parts[1]);

        if (index === selected_item.subitems.length - 1) {
            return selectedSubitemPath;
        }

        return selected_item.id + ':' + (index+1);
    }

    function getPrevSubitemPath(selected_item, selectedSubitemPath) {

        if (selectedSubitemPath === null) { 
            selectedSubitemPath = selected_item.id+':0';
        }

        let parts = selectedSubitemPath.split(':');
        let index = parseInt(parts[1]);

        if (index === 0) {
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
            delete subitem._attribute_tags;
        }
        return clipboard;
    }

    function pasteSubsection(item, subitem_index, subsection_clipboard) {
        if (item.subitems[subitem_index].data === '') {
            //Replace empty subitems
            let base_indent = item.subitems[subitem_index].indent;
            let original_tags = item.subitems[subitem_index].tags;
            item.subitems.splice(subitem_index,1);
            let index_into = subitem_index;
            let first = false;
            for (let subitem of subsection_clipboard) {
                let sub_copy = copyJSON(subitem);
                if (first === false) {
                    //weave in original tags
                    let parts1 = original_tags.split(' ');
                    let parts2 = sub_copy.tags.split(' ');
                    let combined = [];
                    for (let part of parts1) {
                        if (part !== '' && combined.includes(part) === false) {
                            combined.push(part);
                        }
                    }
                    for (let part of parts2) {
                        if (part !== '' && combined.includes(part) === false) {
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
            _onUpdateContent(item, true);
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
            _onUpdateContent(item, true);
            return bookmark;
        }
    }

    function collapse(item, subitemIndex) {
        if (subitemIndex === undefined) {
            console.warn("model.collapse called with no subitem index");
            return;
        }
        if (subitemIndex === 0) {
            item.collapse = 1;
        }
        else {
            item.subitems[subitemIndex].collapse = 1;
        }
        let now = Date.now();
        timestampLastUpdate = now;
        item.last_edit = now;
    }

    function expand(item, subitemIndex) {
        if (subitemIndex === undefined) {
            debugger;
            console.warn("model.expand called with no subitem index");
            return;
        }
        if (subitemIndex === 0) {
            item.collapse = 0;
        }
        else {
            if (item.subitems[subitemIndex] !== undefined) {
                delete item.subitems[subitemIndex].collapse;
            }
        }
        let now = Date.now();
        timestampLastUpdate = now;
        item.last_edit = now;
    }

    function collapseMany(items) {
        let now = Date.now();
        for (let item of items) {
            item.collapse = 1;
            item.last_edit = now;
        }
        timestampLastUpdate = now;
    }

    function expandMany(items) {
        let now = Date.now();
        for (let item of items) {
            item.collapse = 0;
            item.last_edit = now;
        }
        timestampLastUpdate = now;
    }

    let _cached_tag_counts = null;
    let _cached_attribute_tags = null;

    function resetTagCountsCache() {
        _cached_tag_counts = null;
    }

    function resetCachedAttributeTags() {
        _cached_attribute_tags = null;
    }

    function getAttributeTags() {
        if (_cached_attribute_tags !== null) {
            return _cached_attribute_tags;
        }
        else {
            let result = [];
            for (let item of items) {
                for (let sub of item.subitems) {
                    if (sub._attribute_tags === undefined) {
                        continue;
                    }
                    for (let full_tag of sub._attribute_tags) {
                        if (result.includes(full_tag) === false) {
                            result.push(full_tag);
                        }
                    }
                }
            }
            _cached_attribute_tags = result;
            return result;
        }
    }

    //TODO: this should get called in more contexts
    function getTagCounts() {
        if (_cached_tag_counts !== null) {
            return _cached_tag_counts;

        }
        else {
            let result = {};
            for (let item of items) {
                for (let sub of item.subitems) {
                    for (let tag of sub._implied_tags) {
                        if (result[tag] !== undefined) {
                            result[tag] += 1;
                        }
                        else {
                            result[tag] = 1;
                        }
                    }
                    for (let tag of sub._direct_tags) {
                        if (result[tag] !== undefined) {
                            result[tag] += 1;
                        }
                        else {
                            result[tag] = 1;
                        }
                    }
                    for (let tag of sub._inherited_tags) {
                        if (result[tag] !== undefined) {
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
        if (selectedSubitemPath === null) {
            //TODO: deprecated
            return 0;
        }
        else {
            return parseInt(selectedSubitemPath.split(':')[1]);
        }
    }

    function itemCanBeCached(item) {
        for (let subitem of item.subitems) {
            for (let t of UNCACHEABLE_TAGS) {
                if (subitem._direct_tags.includes(t)) {
                    return false;
                }
            }
        }
        return true;
    }

    function itemHasMetaTags(item) {
        if (item === null) {
            console.warn('item is null');
            return false;
        }
        for (let subitem of item.subitems) {
            if (subitem._tags.includes(META_IMPLIES)) {
                return true;
            }
        }
        return false;
    }

    function itemHasAttributeTags(item) {
        for (let subitem of item.subitems) {
            if (subitem._attribute_tags !== undefined && subitem._attribute_tags.length > 0) {
                return true;
            }
        }
        return false;
    }

    function toggleFormatTag(selected_item, selectedSubitemPath, tagname) {
        let subitem = getSubitem(selected_item, selectedSubitemPath);
        let tag_parts = subitem.tags.split(' ');
        let match = false;
        let updated = [];

        let list_todos = [META_TODO, META_DONE];
        let list_lists = [META_LIST_BULLETED, META_LIST_NUMBERED, META_LIST_TODOS];

        for (let part of tag_parts) {
            let trimmed_part = part.trim();
            if (trimmed_part === '') {
                continue;
            }

            if (list_lists.includes(tagname)) {
                if (list_lists.includes(trimmed_part)) {
                    if (trimmed_part === tagname) {
                        match = true;
                    }
                }
                else {
                    updated.push(trimmed_part);
                }
            }
            else if (list_todos.includes(tagname)) {
                if (list_todos.includes(trimmed_part)) {
                    if (trimmed_part === tagname) {
                        match = true;
                    }
                }
                else {
                    updated.push(trimmed_part);
                }
            }
            else {
                if (trimmed_part === tagname) {
                    match = true;
                }
                else {
                    updated.push(trimmed_part);
                }
            }
        }

        if (match === false) {
            updated.push(tagname);
        }
        let text = updated.join(' ');
        updateSubTag(selected_item, selectedSubitemPath, text);
    }

    ///////////////////////////////////////////////////////////////////////////
    // Filtering stuff

    function filterItemsWithParse(parse_results, allow_prefix_matches) {
        if (parse_results.length === 0) {
            for (let item of items) {
                for (let sub of item.subitems) {
                    sub._include = 1;
                }
            }
        }
        else {
            let implications = $ontology.getImplications();
            for (let item of items) {
                _filterItemWithParseResults(item, parse_results, allow_prefix_matches, implications);
            }
        }

        hideDefaultHiddenTaggedItems(parse_results, items);
    }

    function getIncludedSearchWeightedTagCounts(parse_results) {

        let weightedHistory = $searchHistory.getWeightedHistoryFull(parse_results);
        let naive = getIncludedTagCounts();
        let tagset = new Set();
        let secondTier = [];
        for (let item of naive) {
            tagset.add(item.tag);
        }
        let firstTier = [];
        let already = new Set();
        for (let item of weightedHistory) {
            if (tagset.has(item[0]) === false) {
                continue;
            }
            if (item[1] <= 0) {
                continue;
            }
            firstTier.push({'tag': item[0], 'count': item[1]});
            //console.log('\t1st ' + item[0] + ' -> ' + item[1]);
            already.add(item[0]);
        }
        for (let item of naive) {
            if (already.has(item.tag)) {
                continue;
            }
            secondTier.push(item);
        }
        let result = firstTier.concat(secondTier);
        return result;
    }

    //TODO: this should be cached with pub/sub
    function getIncludedTagCounts() {
        let implications = $ontology.getImplications();
        let all_tags = {};
        for (let item of items) {
            for (let sub of item.subitems) {
                if (sub._include === -1) {
                    continue;
                }
                //TODO: might reconsider removing parent-inheritted tags
                for (let tag of sub._tags) {
                    if (all_tags[tag] === undefined) {
                        all_tags[tag] = 1;
                    }
                    else {
                        all_tags[tag]++;
                    }
                    if (ADD_IMPLICATIONS_TO_COUNTS && implications[tag] !== undefined) {
                        for (let imp of implications[tag]) {
                            if (all_tags[imp] === undefined) {
                                all_tags[imp] = 1;
                            }
                            else {
                                all_tags[imp]++;
                            }
                        }
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

    function fullyIncludeItem(item) {
        if (item === null) {
            return;
        }
        for (let sub of item.subitems) {
            sub._include = 1;
        }
    }

    function fullyIncludeAllItems() {
        for (let item of items) {
            for (let sub of item.subitems) {
                sub._include = 1;
            }
            //asdf asdf
            //maybeHideImplications(item);
        }
    }

    function subitemHasChildren(item, subitem, subitemIndex) {
        if (item.subitems.length > subitemIndex+1 &&
            item.subitems[subitemIndex+1].indent > subitem.indent) {
            return true;
        }
        return false;
    }

    function hideDefaultHiddenTaggedItems(parse_results, items) {
        //handle hidden-by-default tags
        for (let tag of DEFAULT_HIDDEN_TAGS) {
            let match = false;
            for (let pr of parse_results) {
                if (pr.type !== 'tag') {
                    continue;
                }
                if (pr.negated !== undefined) {
                    continue;
                }
                if (pr.text === tag) {
                    match = true;
                    break;
                }
            }
            //tag was explicitly included, so show result
            if (match) {
                continue;
            }
            for (let item of items) {
                for (let subitem of item.subitems) {
                    if (subitem._direct_tags.includes(tag) ||
                        subitem._inherited_tags.includes(tag) ||
                        subitem._implied_tags.includes(tag)) {
                        subitem._include = -1;
                    }
                }
            }
        }
    }

    function handleListTodos(item) {
        let updated = false;
        for (let i = 0; i < item.subitems.length; i++) {
            const subitem = item.subitems[i];
            if (subitem._direct_tags.includes(META_LIST_TODOS) === false) {
                continue;
            }
            for (let j = i+1; j< item.subitems.length; j++) {
                const child = item.subitems[j];
                if (child.indent <= subitem.indent) {
                    break;
                }
                if (child.indent >= subitem.indent + 2) {
                    continue;
                }
                if (!child._direct_tags.includes(META_TODO) &&
                    !child._direct_tags.includes(META_DONE)) {
                    child.tags = child.tags.trim() + ' ' + META_TODO;
                    updated = true;
                }
            }
        }
        if (updated) {
            _decorateItemTags(item);
        }
    }

    function _filterItemWithParseResults(item, parse_results, allow_prefix_matches, implications) {

        for (let sub of item.subitems) {
            sub._include = 0;
        }

        let debug_mode = false;

        //1) handle negated first
        for (let pr of parse_results) {
            if (pr.negated !== undefined && pr.negated) {
                if (pr.type === 'tag') {
                    for (let i = 0; i < item.subitems.length; i++) {
                        for (let tag of pr.valid_exact_tag_reverse_implications) {
                            if (item.subitems[i]._tags.includes(tag)) {
                                item.subitems[i]._include = -1;
                                for (let j = i+1; j < item.subitems.length; j++) {
                                    if (item.subitems[j].indent <= item.subitems[i].indent) {
                                        break; //only apply to children
                                    }
                                    item.subitems[j]._include = -1;
                                }
                                break;
                            }
                        }
                    }
                }
                else if (pr.type === 'substring') {
                    for (let i = 0; i < item.subitems.length; i++) {
                        let text = v.stripTags($format.decodeHTMLEntities(item.subitems[i].data, 0));
                        let textLower = text.toLowerCase();
                        if (textLower.includes(pr.text.toLowerCase())) {
                            item.subitems[i]._include = -1;
                            for (let j = i+1; j < item.subitems.length; j++) {
                                if (item.subitems[j].indent <= item.subitems[i].indent) {
                                    break; //only apply to children
                                }
                                item.subitems[j]._include = -1;
                            }
                            break;
                        }
                    }
                }
            }
        }

        //2) handle inclusions second
        for (let i = 0; i < item.subitems.length; i++) {

            if (item.subitems[i]._include !== 0) {
                continue;
            }

            let tags_and_implications = [];
            for (let t of item.subitems[i]._tags) {
                tags_and_implications.push(t);
                if (implications[t] !== undefined) {
                    for (let ti of implications[t]) {
                        if (tags_and_implications.includes(ti) === false) {
                            tags_and_implications.push(ti);
                        }
                    }
                }
            }

            let match_all = true;

            for (let pr of parse_results) {

                if (match_all === false) {
                    break;
                }

                if (pr.negated !== undefined && pr.negated) {
                    continue;
                }

                if (pr.type === 'tag') {

                    if (pr.value !== undefined) { //Handle attribute relations
                        
                        let matched_one = false;
                        let attribute_tags_id_augmented = [];
                        if (item.subitems[i]._attribute_tags !== undefined) {
                            attribute_tags_id_augmented = copyJSON(item.subitems[i]._attribute_tags);
                        }
                        attribute_tags_id_augmented.push(META_ID+'='+item.id);
                        //attribute_tags_id_augmented.push(META_SUBITEM_INDEX+'='+i);
                        attribute_tags_id_augmented.push(META_DATE+'='+formatDateInteger(item));

                        for (let nt of attribute_tags_id_augmented) {
                            let parts = nt.split('=');
                            let tag = parts[0];
                            let val = parts[1];

                            let parse_val = pr.value;

                            //TODO: allow implications eventually?

                            if (v.isNumeric(pr.value)) {
                                
                                parse_val = parseFloat(pr.value);
                                val = parseFloat(val);
                            }

                            //TODO: have a "smart compare" function that knows about dates, etc..
                            if (tag === pr.text) {                           
                                if (pr.relation === '=') {
                                    if (val !== parse_val) {
                                        match_all = false;
                                        break;
                                    }
                                }
                                else if (pr.relation === '>') {
                                    if (val <= parse_val) {
                                        match_all = false;
                                        break;
                                    }
                                }
                                else if (pr.relation === '<') {
                                    if (val >= parse_val) {
                                        match_all = false;
                                        break;
                                    }
                                }
                                else if (pr.relation === '>=') {
                                    if (val < parse_val) {
                                        match_all = false;
                                        break;
                                    }
                                }
                                else if (pr.relation === '<=') {
                                    if (val > parse_val) {
                                        match_all = false;
                                        break;
                                    }
                                }
                                else {
                                    console.warn('unrecognized relationship ' + pr.relation);
                                    match_all = false;
                                    break;
                                }
                                matched_one = true;
                            }
                        }
                        if (matched_one === false) {
                            match_all = false;
                        }
                    }
                    else {

                        //possibly don't match partial tags
                        if (allow_prefix_matches === false && pr.valid_exact_tag_matches.length === 0) {
                            match_all = false;
                            break;
                        }

                        let total_matches = 0;
                        for (let tag of pr.valid_exact_tag_reverse_implications) {
                            if (tags_and_implications.includes(tag)) {
                                total_matches++;
                            }
                        }

                        if (allow_prefix_matches) {
                            for (let tag of pr.valid_prefix_tag_reverse_implications) {
                                if (tags_and_implications.includes(tag)) {
                                    total_matches++;
                                }
                            }
                        }

                        if (total_matches === 0) {
                            match_all = false;
                        }
                    }
                }
                else if (pr.type === 'substring') {
                    if (pr.text === null) {
                        continue;
                    }
                    if (item.subitems[i].data.toLowerCase().includes(pr.text.toLowerCase()) === false) {
                        match_all = false;
                        break;
                    }
                }
            }

            if (match_all === true) {
                item.subitems[i]._include = 1;
                for (let j = i+1; j < item.subitems.length; j++) {
                    if (item.subitems[j].indent <= item.subitems[i].indent) {
                        break;
                    }
                    if (item.subitems[j]._include === 0) {
                        item.subitems[j]._include = 1;
                    }
                }
            }
        }
        
        //3) propagate inclusions up from children
        for (let i = 0; i < item.subitems.length; i++) {
            if (item.subitems[i]._include !== 0) {
                continue;
            }

            let positive_child = false;
            for (let j = i+1; j < item.subitems.length; j++) {
                if (item.subitems[j].indent <= item.subitems[i].indent) {
                    break;
                }
                if (item.subitems[j]._include === 1) {
                    positive_child = true;
                    break;
                }
            }
            if (positive_child) {
                item.subitems[i]._include = 1;
            }
            else {
                item.subitems[i]._include = -1;
            }
        }

        maybeHideImplications(item);
    }

    ///////////////////////////////////////////////////////////////////////////
    // Interface

    return {
        addItemFromSearchBar: addItemFromSearchBar,
        addSubItem: addSubItem,
        addTagToCurrentView: addTagToCurrentView,
        collapse: collapse,
        collapseMany: collapseMany,
        copySubsection: copySubsection,
        deleteItem: deleteItem,
        deleteTag: deleteTag,
        drag: drag,
        dragSubitem: dragSubitem,
        expand: expand,
        expandMany: expandMany,
        filterItemsWithParse: filterItemsWithParse,
        fullyIncludeItem: fullyIncludeItem,
        fullyIncludeAllItems: fullyIncludeAllItems,
        getAllTags: getAllTags,
        getEnrichedAndSortedTagList: getEnrichedAndSortedTagList,
        getFilteredItems: getFilteredItems,
        getIncludedTagCounts: getIncludedTagCounts,
        getIncludedSearchWeightedTagCounts: getIncludedSearchWeightedTagCounts,
        getItemAsText: getItemAsText,
        getItemById: getItemById,
        getUnsortedItems: getUnsortedItems,
        getSortedItems: getSortedItems,
        getItemsAsText: getItemsAsText,
        getNextSubitemPath: getNextSubitemPath,
        getAttributeTags: getAttributeTags,
        getPrevSubitemPath: getPrevSubitemPath,
        getSubItemIndex: getSubItemIndex,
        getSubitem: getSubitem,
        getSubItemTags: getSubItemTags,
        getTagCounts: getTagCounts,
        getTimestampLastUpdate: getTimestampLastUpdate,
        setTimestampLastUpdate: setTimestampLastUpdate,
        indentSubitem: indentSubitem,
        isValidTag: isValidTag,
        itemCanBeCached: itemCanBeCached,
        itemHasMetaTags: itemHasMetaTags,
        itemHasAttributeTags: itemHasAttributeTags,
        moveDown: moveDown,
        moveDownSubitem: moveDownSubitem,
        moveUp: moveUp,
        moveUpSubitem: moveUpSubitem,
        unindentSubitem: unindentSubitem,
        pasteSubsection: pasteSubsection,
        recalculateAllTags: recalculateAllTags,
        removeSubitemFormatting: removeSubitemFormatting,
        split: split,
        extract: extract,
        removeSubItem: removeSubItem,
        removeTagFromCurrentView: removeTagFromCurrentView,
        removeTagFromSubitem: removeTagFromSubitem,
        renameTag: renameTag,
        replaceText: replaceText,
        resetCachedAttributeTags: resetCachedAttributeTags,
        resetTagCountsCache: resetTagCountsCache,
        setItems: setItems,
        subitemHasChildren: subitemHasChildren,
        testConsistency: testConsistency,
        toggleFormatTag: toggleFormatTag,
        updateSubitemData: updateSubitemData,
        updateSubTag: updateSubTag,
        updateTimestamp: updateTimestamp,
        handleListTodos: handleListTodos
    };
})();