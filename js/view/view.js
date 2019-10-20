"use strict";

let $view = (function () {

    let MAX_DEFAULT_RESULTS = 50;
    let count_cached_render = 0;
    let SHOW_STUBS_FOR_EXCLUDED = true;
    let SHOW_ID_INFO_IN_TOOLTIPS = false;

    function render(selected_item, mousedItemId, selectedSubitemPath, mode_more_results) { //TODO: is mousedItemId used??
        
        if (selected_item != null && selectedSubitemPath == null) {
            //TODO2 this should not be needed
            debugger;
            selectedSubitemPath = selected_item.id + ':0';
        }

        let timer = new Timer('Render');

        let parse_results = $auto_complete.getParseResults();

        if (parse_results == null) {
            console.log('Illegal parse');
            timer.end();
            timer.display();
            return;
        }
        
        //This may be overkill, but currently needed for Add Item button to work
        let allow_prefix_matches = false;
        $model.filterItemsWithParse(parse_results, allow_prefix_matches);
        $model.fullyIncludeItem(selected_item);

        renderItems(selected_item, mode_more_results);
        
        /////////////////////////////////////////////////////////////////////////////////////////
        
        if (selectedSubitemPath != null) {
            $('[data-item-id="' + selected_item.id + '"] .subitemdata[data-subitem-path="' + selectedSubitemPath + '"]').addClass('selected-item');
        }

        ////////////////////////////////////////////////////////////////////////////////////////////

        timer.end();
        timer.display();
    }


    function renderWithoutRefilter(item, mousedItemId, selectedSubitemPath, mode_more_results) { //TODO: is mousedItemId used??
        
        if (selectedSubitemPath != null) {
            console.log('Unexpected: selectedSubitemPath != null in renderWithoutRefilter() view.js line 48')
        }

        let timer = new Timer('Render');

        let parse_results = $auto_complete.getParseResults();

        if (parse_results == null) {
            console.log('Illegal parse');
            timer.end();
            timer.display();
            return;
        }

        renderItems(item, mode_more_results);

        timer.end();
        timer.display();
    }


    function updateTag(item, text) {
        let $input = $('[data-item-id='+item.id+']').find('.action-edit-tag');
        $($input).val(text);
        $($input).focus();
    }

    function legalTag(item) {
        $('[data-item-id='+item.id+']').find('.action-edit-tag').css('color','black');
    }

    function illegalTag(item) {
        $('[data-item-id='+item.id+']').find('.action-edit-tag').css('color','red');
    }

    function renderItems(item, mode_more_results) {

        count_cached_render = 0;
        let timer = new Timer('renderItems()');

        //get filtered results
        let filtered_items = $model.getFilteredItems();

        let tot1 = filtered_items.length;

        console.log('rendering ' + filtered_items.length + ' items');

        if (item != null) {
            $model.fullyIncludeItem(item);
        }

        renderTotalResults(filtered_items);
        renderFilteredSortedItems(filtered_items, item, mode_more_results);

        if (filtered_items.length > 0) {
            if (mode_more_results == false) {
                console.log('items cached/new = '+count_cached_render+'/'+Math.min(MAX_DEFAULT_RESULTS, filtered_items.length));
            }
            else {
                console.log('items cached/new = '+count_cached_render+'/'+filtered_items.length);
            }
        }
        timer.end();
    }

    ////////////////////////////////////////////////////////////////////

    let TAGS_TOOLTIPS = false;
    let DEFAULT_TAG_PLACEHOLDER = 'enter relevant tags, or create new ones...';
    let CACHE_ITEM_LEVEL = true;
    let CACHE_ALL_LEVEL = true;
    let DEFAULT_NO_RESULTS = ''; // 0 results
    let _cached_items = {};

    function resetCache() {
        _cached_items = {};
    }

    function renderTotalResults(filtered_items) {

        let lock = '';
        if ($protection.getModeProtected()) {
            lock = '&nbsp;<i class="glyphicon glyphicon-lock"></i>'
        }

        if (filtered_items.length == 0) {
            document.getElementById('total-results').innerHTML = DEFAULT_NO_RESULTS + lock;
        }
        else if (filtered_items.length == 1) {
            document.getElementById('total-results').innerHTML = filtered_items.length + ' result' + lock;
        }
        else {
            document.getElementById('total-results').innerHTML = filtered_items.length + ' results' + lock;
        }
    }

    function renderFilteredSortedItems(filtered_sorted_items, selected_item, mode_more_results) {

        let total_filtered = filtered_sorted_items.length;

        //if selected item is past bounds of more results, open it
        if (mode_more_results == false && selected_item != null) {
            let count = 0;
            for (let item of filtered_sorted_items) {
                if (item.id == selected_item.id) {
                    if (count >= MAX_DEFAULT_RESULTS) {
                        mode_more_results = true;
                        //TODO: factor this reference out
                        $todo.setMoreResults(true);
                        console.log('Auto-expanding more results. Count was ' + count);
                    }
                    break;
                }
                count++;
            }
        }

        let all_html = '';
        let max_results = total_filtered;
        if (mode_more_results == false) {
            max_results = Math.min(MAX_DEFAULT_RESULTS, total_filtered);
        }
        let i = 0;
        for (let item of filtered_sorted_items) {
            i++;
            if (i > max_results) {
                break;
            }
            let is_selected = false;
            if (selected_item != null && item.id == selected_item.id) {
                is_selected = true;
            }
            let h = hashCode(JSON.stringify(item));
            let html = '';
            if (is_selected == false && CACHE_ITEM_LEVEL && _cached_items[h] != undefined) {
                count_cached_render += 1;
                all_html += _cached_items[h];
            }
            else {
                let html = renderItem(item, i, is_selected);
                if (is_selected == false && $model.itemCanBeCached(item)) {
                    _cached_items[h] = html;
                }
                all_html += html;
            }
        }
        if (mode_more_results == false && total_filtered > MAX_DEFAULT_RESULTS) {
            all_html += renderMoreResultsButton(total_filtered);
        }
        let div_items = document.getElementById('div-items');

        div_items.innerHTML = all_html;

        $effects.apply_post_render_effects(selected_item);
    }

    function getToolTipText(subitem, item_id, subitem_index) {

        let numeric_tags = [];
        let units_of_measure = [];
        if (subitem._numeric_tags != undefined) {
            numeric_tags = subitem._numeric_tags;
            for (let nt of subitem._numeric_tags) {
                units_of_measure.push(nt.split('=')[0]);
            }
        }

        let tags = [];
        if (subitem._tags != undefined) {
            for (let tag of subitem._tags) {
                //Don't include "miles" AND "miles=2.5"
                if (units_of_measure.includes(tag) == false) {
                    tags.push(tag);
                }
            }
        }
        
        let all = tags.concat(numeric_tags);

        let at_id = '@id='+item_id;
        let at_subindex = '@subitem-index='+subitem_index;

        if (all.length > 0) {
            if (SHOW_ID_INFO_IN_TOOLTIPS) {
                return all.join(' ') + '\n'+at_id+' '+at_subindex;
            }
            else {
                return all.join(' ');
            }
        }
        else {
            if (SHOW_ID_INFO_IN_TOOLTIPS) {
                return at_id+' '+at_subindex;
            }
            else {
                return null;
            }
        }
    }

    function renderItem(item, index, is_selected) {

        let at_least_one_excluded = false;
        for (let sub of item.subitems) {
            if (sub._include == -1) {
                at_least_one_excluded = true;
                break;
            }
        }

        let extra_inner_class = '';
        if (at_least_one_excluded) {
            extra_inner_class += ' highlight';
        }

        let html = '';

        if (is_selected) {
            html += '<div class="item hot" data-item-id="' + item.id + '">';

                html += '<div class="item-editing">';

                    html += '<div style="margin-left:18px; margin-top:2px;" data-item-id="'+item.id+'" data-subitem-path="'+item.id+':0" class="subitemdata '+extra_inner_class+'" contenteditable="true" spellcheck="false">';
                        html += item.subitems[0].data;
                    html += '</div>';
                    html += '<div class="subitems" style="margin-top:2px;">';
                    html += renderSubItems(item, at_least_one_excluded, is_selected);
                    html += '</div>';

                html += '</div>';

                html += '<div class="tags edit-bar">';

                html += '  <button type="button" title="Add new subitem\n(ctrl-enter)" class="btn btn-default btn-sm action-add">';
                html += '    <span class="glyphicon glyphicon-plus"></span>';
                html += '  </button>';

                html += '  <input type="text" class="tag tag-bar-input action-edit-tag" size="60" autocomplete="off" inputmode="verbatim" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="' + DEFAULT_TAG_PLACEHOLDER + '" value="' + item.subitems[0].tags + '">';  
                
                html += '  <div class="tag-suggestions" data-item-id="'+item.id+'" style="position:absolute; margin-left:2px; margin-right:2px;"></div>';
                
                html += '  <button type="button" title="Shift item down\n(ctrl-down-arrow)" class="btn btn-default btn-sm action-down">';
                html += '    <span class="glyphicon glyphicon-triangle-bottom"></span>';
                html += '  </button>';
                html += '  <button type="button" title="Shift item up\n(ctrl-up-arrow)" class="btn btn-default btn-sm action-up">';
                html += '    <span class="glyphicon glyphicon-triangle-top"></span>';
                html += '  </button>';
                html += '  <button type="button" title="Unindent\n(ctrl-left-arrow)" class="btn btn-default btn-sm action-unindent">';
                html += '    <span class="glyphicon glyphicon-triangle-left"></span>';
                html += '  </button>';
                html += '  <button type="button" title="Indent\n(ctrl-right-arrow)" class="btn btn-default btn-sm action-indent">';
                html += '    <span class="glyphicon glyphicon-triangle-right"></span>';
                html += '  </button>';

                html += '  <button type="button" title="Delete item\n(ctrl-backspace or ctrl-delete)" class="btn btn-default btn-sm action-delete">';
                html += '    <span class="glyphicon glyphicon-trash"></span>';
                html += '  </button>';

                html += '</div>';

            html += '</div>';
        }
        else {
            let tooltips = '';
            let tooltip_class = '';
            if (is_selected == false && TAGS_TOOLTIPS) {
                let tooltip_text = getToolTipText(item.subitems[0], item.id, 0);
                if (tooltip_text != null) {
                    tooltips = 'title="'+tooltip_text+'"';
                    tooltip_class ='tooltipz';
                }
            }

            html += '<div class="item no-select cold" data-item-id="' + item.id + '">';
            
            if (item.collapse == 0) {
                html += '<div style="margin-left:0px;" '+tooltips+' data-subitem-path="'+item.id+':0" class="subitemdata '+extra_inner_class+' '+tooltip_class+'" contenteditable="false">';
                if (item.subitems.length > 1) {
                    html += '<span class="glyphicon glyphicon-triangle-bottom action-collapse" style="margin-top:5px; vertical-align:top;"></span>&nbsp;';
                }
                else {
                    html += '<div style="display:inline-block; width:14px; background-color:red;"></div>&nbsp;';
                }
                html += '<div style="display:inline-block; width:810px;" class="subitem">';
                html += $format.parse(item.subitems[0].data, item.subitems[0]._direct_tags, item, item.subitems[0], 0);
                html += '</div>';

                html += '</div>';
                html += '<div class="subitems">';
                html += renderSubItems(item, at_least_one_excluded, is_selected);
                html += '</div>';
            }
            else {
                html += '<div style="margin-left:0px;" '+tooltips+' data-subitem-path="'+item.id+':0" class="subitemdata '+extra_inner_class+' '+tooltip_class+'" contenteditable="false">';
                if (item.subitems.length > 1) {
                    html += '<span class="glyphicon glyphicon-triangle-right action-expand" style="margin-top:5px; vertical-align:top; "></span>&nbsp;';
                }
                else {
                    html += '<div style="display:inline-block; width:14px; background-color:red;"></div>&nbsp;';
                }
                html += '<div style="display:inline-block; width:810px;" class="subitem subitem-collapsed">';
                html += $format.parse(item.subitems[0].data, item.subitems[0]._direct_tags, item, item.subitems[0], 0);
                html += '</div>';

                html += '</div>';
            }
            html += '</div>';
        }

        return html;
    }

    function renderSubItems(item, at_least_one_excluded, is_selected) {
        let html = '';
        let fold = false;
        let fold_indent = -1;
        for (let i = 1; i < item.subitems.length; i++) {
            if (is_selected) {
                let path = item.id + ':' + i;
                html += renderSubitem(item, item.subitems[i], path, item.subitems[i].indent, at_least_one_excluded, is_selected, i);    
            }
            else {
                if (fold == true) {
                    if (item.subitems[i].indent <= fold_indent) {
                        fold = false;
                        fold_indent = -1;
                    }
                }
                if (fold == false) {
                    let path = item.id + ':' + i;
                    html += renderSubitem(item, item.subitems[i], path, item.subitems[i].indent, at_least_one_excluded, is_selected, i);
                    if (item.subitems[i]._tags.includes('@folded')) {
                        fold = true;
                        fold_indent = item.subitems[i].indent;
                    }
                }
            }
        }
        return html;
    }

    function renderSubitem(item, subitem, path, depth, at_least_one_excluded, is_selected, subitem_index) {
        let extra = 13;
        let margin_left = 25 * depth + extra;
        let width = 837 - margin_left;
        let html = '';
        let extra_class = '';

        if (SHOW_STUBS_FOR_EXCLUDED && subitem._include != 1) {

            if (subitem._direct_tags.includes('@hidden') ||
                subitem._inherited_tags.includes('@hidden') ||
                subitem._implied_tags.includes('@hidden')) {
                return '';
            }
            else {
                return '<div style="width:' + width + 'px; margin-top:2px;margin-bottom:2px; margin-left:' + margin_left + 'px; height:5px; background-color:#999999;" ></div>';
            }
        }

        if (at_least_one_excluded) {
            if (subitem._include == 1) {
                extra_class = ' highlight';
            }
            else {
                extra_class = ' no-highlight';
            }
        }

        if (is_selected) {
            html += '<div data-subitem-path="' + path + '" style="width:' + width + 'px; margin-left:' + margin_left + 'px;" class="subitemdata after-first ' + extra_class + '" contenteditable="true" spellcheck="false">';
        
            html += subitem.data;

            html += '</div>';
        }
        else {
            let tooltips = '';
            let tooltip_class = '';
            if (is_selected == false && TAGS_TOOLTIPS) {
                let tooltip_text = getToolTipText(subitem, item.id, subitem_index);
                if (tooltip_text != null) {
                    tooltips = 'title="'+tooltip_text+'"';
                    tooltip_class ='tooltipz';
                }
            }
            html += '<div data-subitem-path="' + path + '" '+tooltips+' style="width:' + width + 'px; margin-left:' + margin_left + 'px;" class="subitemdata after-first ' + extra_class + ' '+tooltip_class+'" contenteditable="false" spellcheck="false">';
        
            html += $format.parse(subitem.data, subitem._direct_tags, item, subitem, subitem_index);

            html += '</div>';
        }
        
        return html;
    }

    function renderEmbeddedItem(item, starting_indent) {

        let html = '';
        
        let subitem_index = 0;
        for (let subitem of item.subitems) {
            if (subitem._direct_tags.includes('@embed')) {
                subitem_index++;
                continue; //Do not want to go down that rabbit hole
            }

            let extra = -2;
            let margin_left = 25 * subitem.indent;
            let width = 809 - margin_left - starting_indent*25;

            //Show all items, otherwise mostly hidden
            html += '<div style="width:' + width + 'px; margin-left:' + margin_left + 'px;" class="subitem" contenteditable="false" spellcheck="false">';
            html += $format.parse(subitem.data, subitem._direct_tags, item, subitem, subitem_index);
            html += '</div>';
            subitem_index++;

        }
        return html;
    }

    function renderMoreResultsButton(count) {
        let more = count-MAX_DEFAULT_RESULTS;
        if (more == 0) {
            return;
        }
        let html = '';
        html += '  <br>'
        html += '  <button type="button" title="Return all '+count+' results" class="action-more-results">';
        if (more > 1) {
            html += '    '+more+' More Results';
        }
        else {
            html += '    1 More Result';
        }
        
        html += '  </button>';
        return html;
    }

    ////////////////////////////////////////////////////////////////////

    function getItemElementById(id) {
        let query = '[data-item-id="'+id+'"]';
        let el = $(query)[0];
        return el;
    }

    function getSubitemElementByPath(path) {
        let query = '[data-subitem-path="'+path+'"]';
        let el = $(query)[0];
        return el;
    }

    function getItemTagSuggestionsElementById(id) {
        let div = getItemElementById(id);
        let sugg = $(div).find('.tag-suggestions')[0];
        return sugg;
    }

    function getItemTagElementById(id) {
        let div = getItemElementById(id);
        let sugg = $(div).find('.tag')[0];
        return sugg;
    }

    function getSearchText() {
        return $('.action-edit-search')[0].value;
    }

    function setSearchText(text) {
        $('.action-edit-search')[0].value = text;
    }

    function getSubitemPathFromEventTarget(target) {
        return $(target).attr('data-subitem-path');
    }

    function getItemIdFromEventTarget(target) {
        if ($(target).attr('data-subitem-path') != undefined) {
            return parseInt($(target).attr('data-subitem-path').split(':')[0]);
        }
        return null;
    }

    function getSubitemIdFromEventTarget(target) {
        if ($(target).attr('data-item-id') != undefined) {
            return parseInt($(target).attr('data-item-id'));
        }
        if ($(target).attr('data-subitem-path') != undefined) {
            return parseInt($(target).attr('data-subitem-path').split(':')[1]);
        }
        return null;
    }

    function getPathFromCheckboxlike(target) {
        let parent = $(target).parents('[data-subitem-path]');
        let path = $(parent).attr('data-subitem-path');
        return path;
    }

    function showSpinner() {
        $('#div-spinner').show();
    }

    function hideSpinner() {
        $('#div-spinner').hide();
    }

    function setSpinnerContent(content) {
        $('#spn-spin-message').html(content);
    }

    function closeAnyOpenMenus() {
        //This is hacky but works for now
        //It is because I am capturing events to stop them from bubbling up to the document
        if ($('.dropdown-menu').hasClass('show')) {
            $('.dropdown-toggle').dropdown('toggle');
        }
    }

    function onFocusSubitem(event) {
        let path = $view.getSubitemPathFromEventTarget(event.target);
        $('.subitemdata').removeClass('selected-item');
        $(getSubitemElementByPath(path)).addClass('selected-item');
        let item = $model.getItemById(parseInt(path.split(':')[0]));
        getItemTagElementById(item.id).value = $model.getSubItemTags(item, path);
    }

    function onMouseover(target) {
        $(target).addClass('moused');
    }

    function onMouseoverAndSelected(target) {
        $(target).addClass('moused-selected');
    }

    function onMouseoff() {
        $('.subitemdata').removeClass('moused');
        $('.subitemdata').removeClass('moused-selected');
    }

    function setCursor(state) {
        document.body.style.cursor = state;
    }

    return {
        render: render,
        renderWithoutRefilter: renderWithoutRefilter,
        updateTag: updateTag,
        legalTag: legalTag,
        illegalTag: illegalTag,
        renderEmbeddedItem: renderEmbeddedItem,
        resetCache: resetCache,
        getItemElementById: getItemElementById,
        getSubitemElementByPath: getSubitemElementByPath,
        getItemTagSuggestionsElementById: getItemTagSuggestionsElementById,
        getItemTagElementById: getItemTagElementById,
        getSearchText: getSearchText,
        setSearchText: setSearchText,
        getSubitemPathFromEventTarget: getSubitemPathFromEventTarget,
        getItemIdFromEventTarget: getItemIdFromEventTarget,
        getSubitemIdFromEventTarget: getSubitemIdFromEventTarget,
        getPathFromCheckboxlike: getPathFromCheckboxlike,
        showSpinner: showSpinner,
        hideSpinner: hideSpinner,
        setSpinnerContent: setSpinnerContent,
        closeAnyOpenMenus: closeAnyOpenMenus,
        onFocusSubitem: onFocusSubitem,
        onMouseover: onMouseover,
        onMouseoverAndSelected: onMouseoverAndSelected,
        onMouseoff: onMouseoff,
        setCursor: setCursor
    };
})();
