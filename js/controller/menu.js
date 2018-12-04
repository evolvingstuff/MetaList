"use strict";

let $menu = (function() {

	let DEVELOPER_MODE = true;

	function init() {

		let menu_items = [

			/*
			{
				text: 'Visualize',
				id: 'menu_visualize',
				func: $todo.actionVisualize,
				icon: 'glyphicon-eye-open'
				//split_after: true
			},
			*/

			{
				text: 'Expand all in current view',
				id: 'menu_expand_all_view',
				func: $todo.actionExpandAllView,
				icon: 'glyphicon-menu-up'
			},


			{
				text: 'Collapse all in current view',
				id: 'menu_collapse_all_view',
				func: $todo.actionCollapseAllView,
				icon: 'glyphicon-menu-down'
			},

			{
				text: 'Add new logical rule',
				id: 'menu_add_meta_rule',
				func: $todo.actionAddMetaRule,
				icon: 'glyphicon-arrow-right'
				//split_after: true
			},

			{
				text: 'Add tag to current view',
				id: 'menu_add_tag_current_view',
				func: $todo.actionAddTagCurrentView,
				icon: 'glyphicon-plus'
			},

			{
				text: 'Remove tag from current view',
				id: 'menu_remove_tag_current_view',
				func: $todo.actionRemoveTagCurrentView,
				icon: 'glyphicon-minus'
			},
			
			{
				text: 'Rename tag globally',
				id: 'menu_rename_tag',
				func: $todo.actionRenameTag,
				icon: 'glyphicon-pencil'
			},
			{
				text: 'Remove tag globally',
				id: 'menu_delete_tag',
				func: $todo.actionDeleteTag,
				icon: 'glyphicon-remove'
			},

			/*
			{
				text: 'Delete EVERYTHING',
				id: 'menu_delete_everything',
				func: $todo.actionDeleteEverything,
				icon: 'glyphicon-alert',
				dev_mode: true
			},
			*/

			/*
			{
				text: 'Password Protection Settings',
				id: 'menu_password_protection_settings',
				func: $todo.actionPasswordProtectionSettings,
				icon: 'glyphicon-lock',
				split_after: true
			},
			*/
			
			

			{
				text: 'Save',
				id: 'menu_save',
				func: $todo.actionSave,
				icon: 'glyphicon-save'
			},

			/*
			{
				text: 'Restore from text backup',
				id: 'menu_restore_text',
				func: $todo.actionRestoreFromText,
				icon: 'glyphicon-open'
			},
			*/

			/*
			{
				text: 'Restore from JSON backup',
				id: 'menu_restore_json',
				func: $todo.actionRestoreFromJSON,
				icon: 'glyphicon-open'
			}
			*/

			/*
			{
				text: 'Set password protection mode',
				id: 'menu_set_password_protection',
				icon: 'glyphicon-lock',
				func: $todo.actionSetPasswordProtection
			},
			*/

			/*
			{
				text: 'Set sorting mode',
				id: 'menu_sorting',
				func: $todo.actionSetSortingMode,
				icon: 'glyphicon-list'
			}
			*/
		];

		let html = '';
		for (let menu_item of menu_items) {
			if (DEVELOPER_MODE == false && menu_item.dev_mode != undefined) {
				continue;
			}
			let extra = '';
			if (menu_item.icon != undefined) {
				extra = '<span class="glyphicon '+menu_item.icon+'"></span>&nbsp;&nbsp;';
			}
 			html += '<li><a id="'+menu_item.id+'">'+extra+menu_item.text+'</a></li>';
 			if (menu_item.split_after != undefined) {
 				html += '<hr>';
 			}
 			
		}
		$('#ul_menu').html(html);
		for (let menu_item of menu_items) {
			$('#'+menu_item.id).on('click', menu_item.func);
		}
	}

	return {
		init: init
	};

})();



