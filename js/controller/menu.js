"use strict";

//https://getbootstrap.com/docs/4.0/components/dropdowns/

let $menu = (function() {

	let DEVELOPER_MODE = true;

	function init() {

		let menuItems = [

			{
				text: 'Toggle Advanced View',
				id: 'menu_tag_view',
				func: $main_controller.actionToggleAdvancedView,
				icon: 'glyphicon-menu-hamburger'
			},

			//TODO: 2020.01.25: disabling for now because very slow
			
			{
				text: 'Expand all in current view',
				id: 'menu_expand_all_view',
				func: $main_controller.actionExpandAllView,
				icon: 'glyphicon-triangle-bottom'
			},

			{
				text: 'Collapse all in current view',
				id: 'menu_collapse_all_view',
				func: $main_controller.actionCollapseAllView,
				icon: 'glyphicon-triangle-right'
			},
			

			{
				text: 'Add new logical rule',
				id: 'menu_add_meta_rule',
				func: $main_controller.actionAddMetaRule,
				icon: 'glyphicon-plus'
				//split_after: true
			},

			{
				text: 'Add tag to current view',
				id: 'menu_add_tag_current_view',
				func: $main_controller.actionAddTagCurrentView,
				icon: 'glyphicon-plus'
			},

			{
				text: 'Remove tag from current view',
				id: 'menu_remove_tag_current_view',
				func: $main_controller.actionRemoveTagCurrentView,
				icon: 'glyphicon-remove'
			},

			{
				text: 'Remove tag globally',
				id: 'menu_delete_tag',
				func: $main_controller.actionDeleteTag,
				icon: 'glyphicon-remove'
			},
			
			{
				text: 'Rename tag globally',
				id: 'menu_rename_tag',
				func: $main_controller.actionRenameTag,
				icon: 'glyphicon-pencil'
			},

			{
				text: 'Replace text globally',
				id: 'menu_replace_text',
				func: $main_controller.actionReplaceText,
				icon: 'glyphicon-pencil'
			},

			{
				text: 'Visualize categorical data',
				id: 'menu_visualize_categorical',
				func: $main_controller.actionVisualizeCategorical,
				icon: 'glyphicon-stats'
			},
			
			{
				text: 'Visualize numeric data',
				id: 'menu_visualize_numeric',
				func: $main_controller.actionVisualizeNumeric,
				icon: 'glyphicon-stats'
			},

			{
				text: 'Delete EVERYTHING',
				id: 'menu_delete_everything',
				func: $main_controller.actionDeleteEverything,
				icon: 'glyphicon-alert',
				dev_mode: true
			},

			{
				text: 'Password Protection Settings',
				id: 'menu_password_protection_settings',
				func: $main_controller.actionPasswordProtectionSettings,
				icon: 'glyphicon-lock'
			},

			{
				text: 'Generate Random Password',
				id: 'menu_generate_random_password',
				func: $main_controller.actionGenerateRandomPassword,
				icon: 'glyphicon-random'
			},

			{
				text: 'Export current view as text',
				id: 'menu_export_view_as_text',
				func: $main_controller.actionExportViewAsText,
				icon: 'glyphicon-export'
			},

			{
				text: 'Download latest software version',
				id: 'menu_download_latest',
				func: $main_controller.actionDownloadLatest,
				icon: 'glyphicon-download'
			},

			{
				text: 'Save a Backup File',
				id: 'menu_save',
				func: $main_controller.actionSave,
				icon: 'glyphicon-save'
			}
		];

		if ($protection.getModeProtected()) {
			menuItems.push(
				{
					text: 'Log Out',
					id: 'menu_logout',
					func: $main_controller.actionLogOut,
					icon: 'glyphicon-log-out',
				});
		}

		let html = '';
		for (let menuItem of menuItems) {
			if (DEVELOPER_MODE === false && menuItem.dev_mode !== undefined) {
				continue;
			}
			let extra = '';
			if (menuItem.icon !== undefined) {
				extra = '<span class="glyphicon '+menuItem.icon+'"></span>&nbsp;&nbsp;';
			}
 			html += '<li><a id="'+menuItem.id+'">'+extra+menuItem.text+'</a></li>';
 			if (menuItem.split_after !== undefined) {
 				html += '<hr>';
 			}
 			
		}
		$('#ul-main-menu').html(html);
		for (let menuItem of menuItems) {

			function onClickMenuItem() {
				$view.closeAnyOpenMenus();
				menuItem.func();
			}

			$('#'+menuItem.id).on('click', onClickMenuItem);
		}
	}

	return {
		init: init
	};

})();



