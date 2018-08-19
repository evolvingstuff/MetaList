
"use strict";

let $menu = (function() {

	function init() {

		let items = [
			
			{
				text: 'Rename tag',
				id: 'menu_rename_tag',
				func: $todo.actionRenameTag,
				icon: 'glyphicon-pencil'
			},
			{
				text: 'Remove tag',
				id: 'menu_delete_tag',
				func: $todo.actionDeleteTag,
				icon: 'glyphicon-remove'
			},
			

			{
				text: 'Save text version (complete)',
				id: 'menu_save_as_text',
				func: $todo.actionSaveAsText,
				icon: 'glyphicon-save'
			},

			{
				text: 'Save text version (current view)',
				id: 'menu_save_as_text_view',
				func: $todo.actionSaveAsTextView,
				icon: 'glyphicon-save'
			},

			{
				text: 'Save JSON backup (complete)',
				id: 'menu_save',
				func: $todo.actionSave,
				icon: 'glyphicon-save'
			},

			{
				text: 'Save JSON backup (current view)',
				id: 'menu_save_view',
				func: $todo.actionSaveView,
				icon: 'glyphicon-save'
			},

			{
				text: 'Restore from text backup',
				id: 'menu_restore_text',
				func: $todo.actionRestoreFromText,
				icon: 'glyphicon-open'
			},

			{
				text: 'Restore from JSON backup',
				id: 'menu_restore_json',
				func: $todo.actionRestoreFromJSON,
				icon: 'glyphicon-open'
			},

			{
				text: 'Set password protection mode',
				id: 'menu_set_password_protection',
				icon: 'glyphicon-lock',
				func: $todo.actionSetPasswordProtection
			},
			{
				text: 'Set sorting mode',
				id: 'menu_sorting',
				func: $todo.actionSetSortingMode,
				icon: 'glyphicon-list'
			}
		];

		let html = '';
		for (let item of items) {
			let extra = '';
			if (item.icon != undefined) {
				extra = '<span class="glyphicon '+item.icon+'"></span>&nbsp;&nbsp;';
			}
 			html += '<li><a id="'+item.id+'">'+extra+item.text+'</a></li>';
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



