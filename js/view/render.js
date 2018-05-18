'use strict';

let count_cached_render = 0;

let SHOW_STUBS_FOR_EXCLUDED = true;

let $render = (function() {

	let default_tag_placeholder = 'enter relevant tags, or create new ones...';
	let MAX_DEFAULT_RESULTS = 50;//100
	let _cached_items = {};
    //let _cached_all_items = {};
    let _prev_hash = '';
    let CACHE_ITEM_LEVEL = true;
    let CACHE_ALL_LEVEL = true;
    let TAGS_TOOLTIPS = true;

    let _cache_DOM = {};

	function renderTotalResults(filtered_items) {
        if (filtered_items.length == 1) {
            document.getElementById('total_results').innerHTML = filtered_items.length + ' result';
        }
        else {
            document.getElementById('total_results').innerHTML = filtered_items.length + ' results';
        }
    }

    /*
	function renderDateSorted(filtered_items, selectedItemId, mode_more_results) {

		alert('WARNING: this is not efficient yet, like renderPrioritySorted');

        filtered_items.sort(function (a, b) {
            if (a.timestamp < b.timestamp) return 1;
            if (a.timestamp > b.timestamp) return -1;
            if (a.priority < b.priority) return -1;
            if (a.priority > b.priority) return 1;
            return 0;
        });
        let prev_datestring = null;

        let all_html = '';
        let max_results = filtered_items.length;
        if (mode_more_results == false) {
            max_results = Math.min(MAX_DEFAULT_RESULTS, filtered_items.length);
        }
        for (let i = 0; i < max_results; i++) {
        	let item = filtered_items[i];
            let date = new Date(item.timestamp); //TODO use a different attribute?
            let year = '' + date.getFullYear();
            let month = '' + (date.getMonth() + 1);
            let day = '' + date.getDate();
            if (month.length < 2) {
                month = '0' + month;
            }
            if (day.length < 2) {
                day = '0' + day;
            }
            let datestring = year + '.' + month + '.' + day;
            if (prev_datestring != datestring) {
                html += '<div><h4>' + datestring + '</h4></div>';
            }
            prev_datestring = datestring;
            let is_selected = false;
            if (selectedItemId != null && item.id == selectedItemId) {
                is_selected = true;
            }
            let h = hashCode(JSON.stringify(item));
            let html = ''
	        if (is_selected == false && CACHE_ITEM_LEVEL && _cached_items[h] != undefined) {
	            count_cached_render += 1;
	            html = _cached_items[h];
	        }
	        else {
	        	html = renderItem(item, i, is_selected);
	        	if (is_selected == false) {
		        	_cached_items[h] = html;
		    	}
	        }
            all_html += html; 
        }
        if (mode_more_results == false && filtered_items.length > MAX_DEFAULT_RESULTS) {
            all_html += renderMoreResultsButton(filtered_items.length);
        }
        let div_items = document.getElementById('div_items');
        div_items.innerHTML = all_html;

        $(".item:odd").addClass("odd-item");
        $(".item:even").addClass("even-item");
    }
    */


    function renderPrioritySorted(filtered_items, selectedItemId, mode_more_results) {
        filtered_items.sort(function (a, b) {
            if (a.priority > b.priority) return 1;
            if (a.priority < b.priority) return -1;
            return 0;
        });

        //if selected item is past bounds of more results, open it
        if (mode_more_results == false && selectedItemId != null) {
            let count = 0;
            for (let item of filtered_items) {
                if (item.id == selectedItemId) {
                    if (count >= MAX_DEFAULT_RESULTS) {
                        mode_more_results = true;
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
            if (selectedItemId != null && item.id == selectedItemId) {
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

	function renderItem(item, index, is_selected) {

        let at_least_one_excluded = false;
        let flat = $model.enumerate(item);
        for (let sub of flat) {
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
            html += item.data;
            html += '</div>';
        	html += renderSubItems(item, at_least_one_excluded, is_selected);
        	html += '<div class="tags">';
            html += '  <button type="button" title="Shift item down\n(ctrl-down-arrow)" class="btn btn-default btn-sm action-down">';
            html += '    <span class="glyphicon glyphicon-triangle-bottom"></span>';
            html += '  </button>';
            html += '  <button type="button" title="Shift item up\n(ctrl-up-arrow)" class="btn btn-default btn-sm action-up">';
            html += '    <span class="glyphicon glyphicon-triangle-top"></span>';
            html += '  </button>';
            html += '  &nbsp;&nbsp;&nbsp;';
            html += '  <button type="button" title="Add new item\n(ctrl-enter)" class="btn btn-default btn-sm action-add">';
            html += '    <span class="glyphicon glyphicon-plus"></span>';
            html += '  </button>';
            html += '  <button type="button" title="Add new sub-item\n(ctrl-shift-enter or tab)" class="btn btn-default btn-sm action-add-subitem">';
            html += '    <span class="glyphicon glyphicon-th-list"></span>';
            html += '  </button>';
            html += '  <button type="button" title="Delete item\n(ctrl-backspace or ctrl-delete)" class="btn btn-default btn-sm action-delete">';
            html += '    <span class="glyphicon glyphicon-trash"></span>';
            html += '  </button>';
            html += '  &nbsp;&nbsp;&nbsp;';
            html += '  <input type="text" class="tag action-edit-tag" size="40" autocomplete="off" inputmode="verbatim" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="' + default_tag_placeholder + '" value="' + item.tags + '">';  
            html += '  <div class="tag-suggestions" data-item-id="'+item.id+'" style="position:absolute;"></div>';
            /*
            html += '  <button type="button" title="Auto-suggest tags (work in progress)" class="btn btn-default btn-sm action-suggest">';
            html += '    <span class="glyphicon glyphicon-flash"></span>';
            html += '  </button>';
            */
            html += '  &nbsp;&nbsp;&nbsp;';
            html += '  <input type="date" class="time action-edit-time" value="' + formatDate(item) + '"></input>';
            html += '</div>';
            html += '</div>';
        }
        else {
            let tooltips = '';
            let tooltip_class = '';
            if (TAGS_TOOLTIPS && item._tags != undefined && item._tags.length > 0) {
                tooltips = 'title="'+item._tags.join(' ')+'"'
                tooltip_class = 'tooltipz';
            }
            html += '<div class="item" data-item-id="' + item.id + '">';
            html += '<div style="margin-left:0px;" '+tooltips+' class="data itemdata '+extra_inner_class+' '+tooltip_class+'" contenteditable="false">';
            html += $format.parse(item.data, item._tags);
            html += '</div>';
        	html += renderSubItems(item, at_least_one_excluded, is_selected);
        	html += '</div>';
        }

        return html;
    }

    function renderSubItems(item, at_least_one_excluded, is_selected) {
        if (item.subitems.length > 0) {
            let html = '';
            html += '<div class="subitems">';
            for (let i = 0; i < item.subitems.length; i++) {
                let path = '' + i;
                html += renderSubitem(item.id, item.subitems[i], path, 1, at_least_one_excluded, is_selected);
            }
            html += '</div>';
            return html;
        }
        return '';
    }

    function renderSubitem(item_id, subitem, path, depth, at_least_one_excluded, is_selected) {
        let margin_left = 25 * depth;
        //let width = 828 - margin_left;
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
            if (is_selected == false && TAGS_TOOLTIPS && subitem._tags != undefined && subitem._tags.length > 0) {
                tooltips = 'title="'+subitem._tags.join(' ')+'"'
                tooltip_class ='tooltipz'
            }
            html += '<div data-item-id="' + item_id + '" data-subitem-path="' + path + '" '+tooltips+' style="width:' + width + 'px; margin-left:' + margin_left + 'px;" class="data subitemdata ' + extra_class + ' '+tooltip_class+'" contenteditable="false" spellcheck="false">';
        
            html += $format.parse(subitem.data, subitem._tags);
        }
        html += '</div>';
        if (subitem.subitems.length > 0) {
            for (let i = 0; i < subitem.subitems.length; i++) {
                html += renderSubitem(item_id, subitem.subitems[i], path + '/' + i, depth + 1, at_least_one_excluded, is_selected);
            }
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

    return {
    	//renderDateSorted: renderDateSorted,
    	renderPrioritySorted: renderPrioritySorted,
    	renderTotalResults: renderTotalResults
    }
})();