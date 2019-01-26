'use strict';

let count_cached_render = 0;

let SHOW_STUBS_FOR_EXCLUDED = true;

let SHOW_ID_INFO_IN_TOOLTIPS = false;

let $render = (function() {

    let TAGS_TOOLTIPS = false;

	let default_tag_placeholder = 'enter relevant tags, or create new ones...';
	let MAX_DEFAULT_RESULTS = 50;
	let _cached_items = {};
    let CACHE_ITEM_LEVEL = true;
    let CACHE_ALL_LEVEL = true;

    function resetCache() {
        _cached_items = {};
    }

	function renderTotalResults(filtered_items) {
        if (filtered_items.length == 1) {
            document.getElementById('total_results').innerHTML = filtered_items.length + ' result';
        }
        else {
            document.getElementById('total_results').innerHTML = filtered_items.length + ' results';
        }
    }

    function renderFilteredSortedItems(filtered_items, selected_item, mode_more_results) {

        //if selected item is past bounds of more results, open it
        if (mode_more_results == false && selected_item != null) {
            let count = 0;
            for (let item of filtered_items) {
                if (item.deleted != undefined) {
                    console.log('WARNING: deleted item showing up in filtered items list');
                    console.log(item);
                }
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
        let max_results = filtered_items.length;
        if (mode_more_results == false) {
            max_results = Math.min(MAX_DEFAULT_RESULTS, filtered_items.length);
        }
        for (let i = 0; i < max_results; i++) {
            if (filtered_items[i].deleted != undefined) {
                console.log('WARNING: deleted item showing up in filtered items list');
                console.log(filtered_items[i]);
            }
        	let item = filtered_items[i];
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
	        	if (is_selected == false) {
		        	_cached_items[h] = html;
		    	}
                all_html += html;
	        }
        }
        if (mode_more_results == false && filtered_items.length > MAX_DEFAULT_RESULTS) {
            all_html += renderMoreResultsButton(filtered_items.length);
        }
        let div_items = document.getElementById('div_items');
        div_items.innerHTML = all_html;

        $(".item:odd").addClass("odd-item");
        $(".item:even").addClass("even-item");
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
        	html += '<div class="item" data-item-id="' + item.id + '">';
            html += '<div style="margin-left:18px;" data-item-id="'+item.id+'" data-subitem-path="'+item.id+':0" class="data itemdata '+extra_inner_class+'" contenteditable="true" spellcheck="false">';
            html += item.subitems[0].data;
            html += '</div>';
        	html += renderSubItems(item, at_least_one_excluded, is_selected);
        	html += '<div class="tags">';

            html += '  <button type="button" title="Add new item\n(ctrl-enter)" class="btn btn-default btn-sm action-add">';
            html += '    <span class="glyphicon glyphicon-plus"></span>';
            html += '  </button>';
            html += '  <button type="button" title="Shift item down\n(ctrl-down-arrow)" class="btn btn-default btn-sm action-down">';
            html += '    <span class="glyphicon glyphicon-triangle-bottom"></span>';
            html += '  </button>';
            html += '  <button type="button" title="Shift item up\n(ctrl-up-arrow)" class="btn btn-default btn-sm action-up">';
            html += '    <span class="glyphicon glyphicon-triangle-top"></span>';
            html += '  </button>';
            html += '  <button type="button" title="Outdent\n(ctrl-left-arrow)" class="btn btn-default btn-sm action-outdent">';
            html += '    <span class="glyphicon glyphicon-triangle-left"></span>';
            html += '  </button>';
            html += '  <button type="button" title="Indent\n(ctrl-right-arrow)" class="btn btn-default btn-sm action-indent">';
            html += '    <span class="glyphicon glyphicon-triangle-right"></span>';
            html += '  </button>';

            html += '  <input type="text" class="tag action-edit-tag" size="41" autocomplete="off" inputmode="verbatim" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="' + default_tag_placeholder + '" value="' + item.subitems[0].tags + '">';  
            html += '  <div class="tag-suggestions" data-item-id="'+item.id+'" style="position:absolute;"></div>';
            html += '  <input style="width:128px;" type="date" class="time action-edit-time" size="5" value="' + formatDate(item) + '"></input>';

            html += '  <button type="button" title="Create link to this item in clipboard\n(ctrl-shift-L)" class="btn btn-default btn-sm action-make-link">';
            html += '    <span class="glyphicon glyphicon-link"></span>';
            html += '  </button>';

            html += '  <button type="button" title="Copy subsection to clipboard\n(ctrl-shift-C)" class="btn btn-default btn-sm action-copy-subsection">';
            html += '    <span class="glyphicon glyphicon-copy"></span>';
            html += '  </button>';
            html += '  <button type="button" title="Paste from clipboard\n(ctrl-shift-V)" class="btn btn-default btn-sm action-paste-subsection">';
            html += '    <span class="glyphicon glyphicon-paste"></span>';
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

            html += '<div class="item" data-item-id="' + item.id + '">';
            
            if (item.collapse == 0) {
                html += '<div style="margin-left:0px;" '+tooltips+' data-item-id="'+item.id+'" data-subitem-path="'+item.id+':0" class="data itemdata '+extra_inner_class+' '+tooltip_class+'" contenteditable="false">';
                if (item.subitems.length > 1) {
                    html += '<span class="glyphicon glyphicon-menu-up action-collapse" style="vertical-align:top;"></span>&nbsp;';
                }
                else {
                    html += '<div style="display:inline-block; width:14px; background-color:red;"></div>&nbsp;';
                }
                html += '<div style="display:inline-block; width:810px;">';
                html += $format.parse(item.subitems[0].data, item.subitems[0]._direct_tags, item, item.subitems[0], 0);
                html += '</div>';

                html += '</div>';
                html += renderSubItems(item, at_least_one_excluded, is_selected);
            }
            else {
                html += '<div style="margin-left:0px;" '+tooltips+' data-item-id="'+item.id+'"  data-subitem-path="'+item.id+':0" class="data itemdata '+extra_inner_class+' '+tooltip_class+'" contenteditable="false">';
                if (item.subitems.length > 1) {
                    html += '<span class="glyphicon glyphicon-menu-down action-expand" style="vertical-align:top;"></span>&nbsp;';
                }
                else {
                    html += '<div style="display:inline-block; width:14px; background-color:red;"></div>&nbsp;';
                }
                html += '<div style="display:inline-block; width:810px;">';
                html += $format.parse(item.subitems[0].data, item.subitems[0]._direct_tags, item, item.subitems[0], 0);
                html += '</div>';

                html += '</div>';
            }
        	html += '</div>';
        }

        return html;
    }

    function renderSubItems(item, at_least_one_excluded, is_selected) {
        let html = '<div class="subitems">';
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
                    if (item.subitems[i]._tags.includes('@fold')) {
                        fold = true;
                        fold_indent = item.subitems[i].indent;
                    }
                }
            }
        }
        html += '</div>';
        return html;
    }

    function renderSubitem(item, subitem, path, depth, at_least_one_excluded, is_selected, subitem_index) {
        let extra = 13;
        let margin_left = 25 * depth + extra;
        let width = 835 - margin_left;
        let html = '';
        let extra_class = '';

        if (SHOW_STUBS_FOR_EXCLUDED && subitem._include != 1) {
            return '<div style="width:' + width + 'px; margin-top:2px;margin-bottom:2px; margin-left:' + margin_left + 'px; height:5px; background-color:#999999;" ></div>';
        }

        if (at_least_one_excluded) {
            if (subitem._include == 1) {
                extra_class = ' highlight';
            }
            else {
                extra_class = ' no-highlight';
            }
        }

        extra_class += ' subitem';

        if (subitem_index % 2 == 0) {
            extra_class += ' even-subitem';
        }
        else {
            extra_class += ' odd-subitem';
        }

        if (is_selected) {
            html += '<div data-item-id="' + item.id + '" data-subitem-path="' + path + '" style="width:' + width + 'px; margin-left:' + margin_left + 'px;" class="data subitemdata ' + extra_class + '" contenteditable="true" spellcheck="false">';
        
            html += subitem.data;
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
            html += '<div data-item-id="' + item.id + '" data-subitem-path="' + path + '" '+tooltips+' style="width:' + width + 'px; margin-left:' + margin_left + 'px;" class="data subitemdata ' + extra_class + ' '+tooltip_class+'" contenteditable="false" spellcheck="false">';
        
            html += $format.parse(subitem.data, subitem._direct_tags, item, subitem, subitem_index);
        }
        html += '</div>';
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

    return {
    	renderFilteredSortedItems: renderFilteredSortedItems,
    	renderTotalResults: renderTotalResults,
        renderItem: renderItem,
        resetCache: resetCache
    }
})();