
"use strict";

let $menu = (function() {

	function init() {

		let items = [
			{
				text: 'Rename tag',
				id: 'menu_rename_tag',
				func: $todo.actionRenameTag
			},
			{
				text: 'Delete tag',
				id: 'menu_delete_tag',
				func: $todo.actionDeleteTag
			},
			{
				text: 'Save JSON backup (complete)',
				id: 'menu_save',
				func: $todo.actionSave
			},

			{
				text: 'Save JSON backup (current view)',
				id: 'menu_save_view',
				func: $todo.actionSaveView
			},

			{
				text: 'Save text version (complete)',
				id: 'menu_save_as_text',
				func: $todo.actionSaveAsText
			},

			{
				text: 'Save text version (current view)',
				id: 'menu_save_as_text_view',
				func: $todo.actionSaveAsTextView
			}
		];

		let html = '';
		for (let item of items) {
			html += '<li><a id="'+item.id+'">'+item.text+'</a></li>';
		}
		$('#ul_menu').html(html);
		for (let item of items) {
			$('#'+item.id).on('click', item.func);
		}
	}

	return {
		init: init
	};

})();



