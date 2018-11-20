"use strict";

let $menu_sorting = (function() {
	function init() {
		let menu_items = [
			{
				text: 'Sort by priority',
				id: 'sort_by_priority',
				func: $todo.actionSortByPriority,
				mode_sort: 'priority'
				//icon: 'glyphicon glyphicon-sort-by-attributes-alt'
			},
			{
				text: 'Sort by reverse priority',
				id: 'sort_by_reverse_priority',
				func: $todo.actionSortByReversePriority,
				mode_sort: 'reverse-priority'
				//icon: 'glyphicon glyphicon-sort-by-attributes'
			},
			{
				text: 'Sort by date',
				id: 'sort_by_date',
				func: $todo.actionSortByDate,
				mode_sort: 'date'
				//icon: 'glyphicon glyphicon-sort-by-attributes-alt'
			},
			{
				text: 'Sort by reverse date',
				id: 'sort_by_reverse_date',
				func: $todo.actionSortByReverseDate,
				mode_sort: 'reverse-date'
				//icon: 'glyphicon glyphicon-sort-by-attributes'
			}

			/*
			{
				text: 'Advanced sorting',
				id: 'sort_by_advanced',
				func: $todo.actionSortByAdvanced,
				mode_sort: 'advanced'
				//icon: 'glyphicon glyphicon-sort-by-attributes'
			}
			*/
		];

		let html = '';
		for (let menu_item of menu_items) {
			let extra = '';
			if (menu_item.mode_sort == $todo.getModeSort()) {
				extra = '<span class="glyphicon glyphicon-ok"></span>&nbsp;&nbsp;';
			}
			else {
				extra = '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;'; //#TODO: better spacing
			}
 			html += '<li><a id="'+menu_item.id+'">'+extra+menu_item.text+'</a></li>';
 			if (menu_item.split_after != undefined) {
 				html += '<hr>';
 			}
		}
		$('#ul_menu_sorting').html(html);
		for (let menu_item of menu_items) {
			$('#'+menu_item.id).on('click', menu_item.func);
		}
	}

	return {
		init: init
	};

})();



