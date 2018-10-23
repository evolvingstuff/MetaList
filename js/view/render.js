'use strict';

let count_cached_render = 0;

let SHOW_STUBS_FOR_EXCLUDED = true;

let $render = (function() {

    let TAGS_TOOLTIPS = true;

	let default_tag_placeholder = 'enter relevant tags, or create new ones...';
	let MAX_DEFAULT_RESULTS = 50;
	let _cached_items = {};
    let _prev_hash = '';
    let CACHE_ITEM_LEVEL = true;
    let CACHE_ALL_LEVEL = true;
    

    let _cache_DOM = {};

	function renderTotalResults(filtered_items) {
        if (filtered_items.length == 1) {
            document.getElementById('total_results').innerHTML = filtered_items.length + ' result';
        }
        else {
            document.getElementById('total_results').innerHTML = filtered_items.length + ' results';
        }
    }

    function renderPrioritySorted(filtered_items, selected_item, mode_more_results) {
        filtered_items.sort(function (a, b) {
            if (a.priority > b.priority) return 1;
            if (a.priority < b.priority) return -1;
            return 0;
        });

        //if selected item is past bounds of more results, open it
        if (mode_more_results == false && selected_item != null) {
            let count = 0;
            for (let item of filtered_items) {
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

    function getToolTipText(subitem) {
        //TODO: minor bug, could get e.g. "miles" and "miles=2.5" which is redundant
        //will fix later
        let tags = [];
        if (subitem._tags != undefined) {
            tags = subitem._tags;
        }
        let numeric_tags = [];
        if (subitem._numeric_tags != undefined) {
            numeric_tags = subitem._numeric_tags;
        }
        let all = tags.concat(numeric_tags);
        if (all.length > 0) {
            let tooltip_text = all.join(' ');
            return tooltip_text;
        }
        else {
            return null;
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
            html += '<div style="margin-left:0px;" class="data itemdata '+extra_inner_class+'" contenteditable="true" spellcheck="false">';
            html += item.subitems[0].data;
            html += '</div>';
        	html += renderSubItems(item, at_least_one_excluded, is_selected);
        	html += '<div class="tags">';
            html += '  <button type="button" title="Add new item\n(ctrl-enter)" class="btn btn-default btn-sm action-add">';
            html += '    <span class="glyphicon glyphicon-plus"></span>';
            html += '  </button>';
            html += '  &nbsp;';
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
            
            html += '  &nbsp;';
            html += '  <input type="text" class="tag action-edit-tag" size="48" autocomplete="off" inputmode="verbatim" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="' + default_tag_placeholder + '" value="' + item.subitems[0].tags + '">';  
            html += '  <div class="tag-suggestions" data-item-id="'+item.id+'" style="position:absolute;"></div>';
            html += '  &nbsp;';
            html += '  <input type="date" class="time action-edit-time" value="' + formatDate(item) + '"></input>';
            html += '  &nbsp;';
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
                let tooltip_text = getToolTipText(item.subitems[0]);
                if (tooltip_text != null) {
                    tooltips = 'title="'+tooltip_text+'"';
                    tooltip_class ='tooltipz';
                }
            }


            html += '<div class="item" data-item-id="' + item.id + '">';
            html += '<div style="margin-left:0px;" '+tooltips+' class="data itemdata '+extra_inner_class+' '+tooltip_class+'" contenteditable="false">';
            html += $format.parse(item.subitems[0].data, item.subitems[0]._tags);
            html += '</div>';
        	html += renderSubItems(item, at_least_one_excluded, is_selected);
        	html += '</div>';
        }

        return html;
    }

    function renderSubItems(item, at_least_one_excluded, is_selected) {
        let html = '<div class="subitems">';
        for (let i = 1; i < item.subitems.length; i++) {
            let path = item.id + ':' + i;
            html += renderSubitem(item.id, item.subitems[i], path, item.subitems[i].indent, at_least_one_excluded, is_selected);
        }
        html += '</div>';
        return html;
    }

    function renderSubitem(item_id, subitem, path, depth, at_least_one_excluded, is_selected) {
        let margin_left = 25 * depth;
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

        if (is_selected) {
            html += '<div data-item-id="' + item_id + '" data-subitem-path="' + path + '" style="width:' + width + 'px; margin-left:' + margin_left + 'px;" class="data subitemdata ' + extra_class + '" contenteditable="true" spellcheck="false">';
        
            html += subitem.data;
        }
        else {
            let tooltips = '';
            let tooltip_class = '';
            if (is_selected == false && TAGS_TOOLTIPS) {
                let tooltip_text = getToolTipText(subitem);
                if (tooltip_text != null) {
                    tooltips = 'title="'+tooltip_text+'"';
                    tooltip_class ='tooltipz';
                }
            }
            html += '<div data-item-id="' + item_id + '" data-subitem-path="' + path + '" '+tooltips+' style="width:' + width + 'px; margin-left:' + margin_left + 'px;" class="data subitemdata ' + extra_class + ' '+tooltip_class+'" contenteditable="false" spellcheck="false">';
        
            html += $format.parse(subitem.data, subitem._tags);
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
    	renderPrioritySorted: renderPrioritySorted,
    	renderTotalResults: renderTotalResults,
        renderItem: renderItem
    }
})();