'use strict';

let $events = (function() {

	function registerEvents() {

        //prevent editable item from responding to double click
        $(document).on('dblclick', '.action-edit-tag', function(e) { e.stopPropagation(); });
        $(document).on('dblclick', '.action-edit-time', function(e) { e.stopPropagation(); });
        $(document).on('click', '.copyable', $todo.onCopy);
        $(document).on('dblclick', '.item', $todo.onDblClickItem);
        $(document).on('dblclick', $todo.onDblClickDocument);
        $(document).on('input', '.itemdata', $todo.onEditItem);
        $(document).on('input', '.subitemdata', $todo.onEditSubitem);
        $(document).on('focus', '.itemdata', $todo.onFocusItem);
        $(document).on('focus', '.subitemdata', $todo.onFocusSubitem);
        $(document).on('click', '.action-up', $todo.actionUp);
        $(document).on('click', '.action-down', $todo.actionDown);
        $(document).on('click', '.action-delete', $todo.actionDeleteButton);
        $(document).on('click', '.action-add', $todo.actionAdd);
        $(document).on('input', '.action-edit-tag', $todo.actionEditTag);
        $(document).on('change', '.action-edit-time', $todo.actionEditTime);
        $(document).on('input', '.action-edit-search', $todo.actionEditSearch);
        $(document).on('click', '.action-add-subitem', $todo.actionAddSubItem);
        $(document).on('mouseover', '.item', $todo.actionMouseover);
        $(document).on('mouseout', '.item', $todo.actionMouseoff);
        $(document).on('mousedown', $todo.actionMousedown);
        $(document).on('mouseup', $todo.actionMouseup);
        $(document).on('focus', '.action-edit-tag', $todo.actionFocusEditTag);
        $(document).on('click', '.action-more-results', $todo.actionMoreResults);
        $('#img_home').on('click', $todo.actionHome);
        $(window).focus($todo.onWindowFocus);
        $(window).blur($todo.onWindowBlur);

        $(document).keydown(function (e) {
            //console.log(e.keyCode);

            if (e.ctrlKey) {
                if (e.shiftKey == true && e.keyCode >= 48 && e.keyCode <= 57 ) {
                    e.preventDefault();
                    $todo.actionSetShortcut(e.keyCode);
                    return;
                }

                if (e.ctrlKey && e.keyCode >= 48 && e.keyCode <= 57 ) {
                    e.preventDefault();
                    $todo.actionGetShortcut(e.keyCode);
                    return;
                }

                if (e.keyCode == 38 && e.ctrlKey) { 
                    if (e.shiftKey == true) {
                        $todo.actionFullUp(e); 
                    }
                    else {
                        $todo.actionUp(e); 
                    }
                }
                if (e.keyCode == 40 && e.ctrlKey) { 
                    if (e.shiftKey == true) {
                        $todo.actionFullDown(e); 
                    }
                    else {
                        $todo.actionDown(e); 
                    }
                }
                if (e.keyCode == 13 && e.ctrlKey && e.shiftKey == false) { $todo.actionAdd(e); }
                if (e.keyCode == 13 && e.ctrlKey && e.shiftKey == true) { $todo.actionAddSubItem(e); }
                if (e.keyCode == 82 && e.ctrlKey) { $todo.actionSpacedRep(e); }
                if (e.keyCode == 83 && e.ctrlKey) { $todo.actionSave(e); };
            }
            
            if (e.keyCode == 9) { $todo.onHotkeyToFromTags(e); }
            if ((e.keyCode == 46 || e.keyCode == 8) && e.ctrlKey) { $todo.actionDelete(e); }
            if (e.keyCode == 27) { $todo.onEscape(e); }
            if (e.keyCode == 8 || e.keyCode == 46) { $todo.onBackspaceDown(e); }
            if (e.keyCode == 38) { $todo.onUpArrow(e); }
            if (e.keyCode == 40) { $todo.onDownArrow(e); }
            if (e.keyCode == 13 || e.keyCode == 9) { $todo.onEnterOrTab(e); }
        });

        $(document).keyup(function (e) {
            if (e.keyCode == 8 || e.keyCode == 46) { $todo.onBackspaceUp(e); }
        });

        $(document).on({
            mouseenter: function (e) {
                let id = parseInt($(this).attr('data-suggestion-id'));
                $todo.updateSelectedSearchSuggestion(id);
            },
            mouseleave:function (e) {
                $todo.updateSelectedSearchSuggestion();
            }
        },'.suggestion');

        $(document).on({
            mouseenter: function (e) {
                let id = parseInt($(this).attr('data-tag-suggestion-id'));
                $todo.updateSelectedTagSuggestion(id);
            },
            mouseleave:function (e) {
                $todo.updateSelectedTagSuggestion();
            },
            click: function (e) {
            	$todo.onClickTagSuggestion();
            }
        },'.tag-suggestion');
        $('#search_input').click($todo.onSearchClick);
        $('#div_search_bar').focusout($todo.onSearchFocusOut);
        $('#div_auto').on('mousedown', $todo.onClickSelectSearchSuggestion);
        $('.action-check').on('click', $todo.onCheck);
        $('.action-uncheck').on('click', $todo.onUncheck);
        window.onbeforeunload = $todo.onBeforeUnload;

        $('#btn_menu').on('click', $todo.onClickMenu);
        $menu.init();

        console.log('done registering events');
    }

	return {
		registerEvents: registerEvents
	}

})();