"use strict";

//https://getbootstrap.com/docs/4.0/components/dropdowns/

let $menu = (function() {

	let DEVELOPER_MODE = true;

	function init() {

		let menuItems = [

			{
				text: 'Toggle Advanced View',
				id: 'menu_tag_view',
				func: $todo.actionToggleAdvancedView,
				icon: 'glyphicon-menu-hamburger'
			},

			{
				text: 'Visualize categorical data',
				id: 'menu_visualize_categorical',
				func: $todo.actionVisualizeCategorical,
				icon: 'glyphicon-equalizer'
			},
			
			{
				text: 'Visualize numeric data',
				id: 'menu_visualize_numeric',
				func: $todo.actionVisualizeNumeric,
				icon: 'glyphicon-stats'
			},

			{
				text: 'Expand all in current view',
				id: 'menu_expand_all_view',
				func: $todo.actionExpandAllView,
				icon: 'glyphicon-triangle-bottom'
			},

			{
				text: 'Collapse all in current view',
				id: 'menu_collapse_all_view',
				func: $todo.actionCollapseAllView,
				icon: 'glyphicon-triangle-right'
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
				text: 'Password Protection Settings',
				id: 'menu_password_protection_settings',
				func: $todo.actionPasswordProtectionSettings,
				icon: 'glyphicon-lock',
				split_after: true
			},
			*/

			
			
			{
				text: 'Delete EVERYTHING',
				id: 'menu_delete_everything',
				func: $todo.actionDeleteEverything,
				icon: 'glyphicon-alert',
				dev_mode: true
			},

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
		for (let menuItem of menuItems) {
			if (DEVELOPER_MODE == false && menuItem.dev_mode != undefined) {
				continue;
			}
			let extra = '';
			if (menuItem.icon != undefined) {
				extra = '<span class="glyphicon '+menuItem.icon+'"></span>&nbsp;&nbsp;';
			}
 			html += '<li><a id="'+menuItem.id+'">'+extra+menuItem.text+'</a></li>';
 			if (menuItem.split_after != undefined) {
 				html += '<hr>';
 			}
 			
		}
		$('#ul-main-menu').html(html);
		for (let menuItem of menuItems) {
			$('#'+menuItem.id).on('click', menuItem.func);
		}
	}

	return {
		init: init
	};

})();



