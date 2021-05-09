"use strict";

//https://getbootstrap.com/docs/4.0/components/dropdowns/

let $menu = (function() {

	let DEVELOPER_MODE = true;

	function init() {

		let menuItems = [

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
				text: 'Add new implication',
				id: 'menu_add_meta_rule',
				func: $main_controller.actionAddMetaRule,
				icon: 'glyphicon-plus'
			},

			{
				text: 'Toggle display implications',
				id: 'menu_toggle_show_meta_rule',
				func: $main_controller.actionToggleShowMetaRule,
				icon: state.state_show_implications ? 'glyphicon-check' : 'glyphicon-unchecked'
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
				text: 'Save a Backup File',
				id: 'menu_save',
				func: (e) => $main_controller.eventRouter(EVENT_ON_SAVE, e),
				icon: 'glyphicon-save'
			}
		];

		if ($protection.getModeProtected()) {
			menuItems.push(
				{
					text: 'Log Out',
					id: 'menu_logout',
					func: (e) => {$main_controller.eventRouter(EVENT_ON_LOGOUT, e)},
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

			function onClickMenuItem(e) {
				$view.closeAnyOpenMenus();
				menuItem.func(e);
			}

			$('#'+menuItem.id).on('click', onClickMenuItem);
		}
	}

	return {
		init: init
	};

})();



