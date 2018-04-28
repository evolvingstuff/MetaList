'use strict';

/*
	Responsibilities:
		Mapping of DOM and keyboard events to logical events

	Refactor:
		Sometimes passing in the event, sometimes not
		Sometimes calling an action, sometimes just naming the event
		Never call to mod other than $todo
			Pass in a ref to $todo
		Better yet, have a single place where logical events can be registered, 
		and a state machine attached to that
*/

let last_key_code = null;

let $events = (function() {

	function registerEvents() {

		console.log('registering events...');

		//prevent editable item from responding to double click
        $(document).on('dblclick', '.action-edit-tag', function(e) { e.stopPropagation(); });
        $(document).on('dblclick', '.action-edit-time', function(e) { e.stopPropagation(); });
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
        $(document).on('click', '.action-suggest', $todo.actionSuggest);
        $(document).on('input', '.action-edit-tag', $todo.actionEditTag);
        $(document).on('change', '.action-edit-time', $todo.actionEditTime);
        $(document).on('input', '.action-edit-search', $todo.actionEditSearch);
        $(document).on('click', '.action-add-subitem', $todo.actionAddSubItem);
        $(document).on('click', '#btn_save', $persist.saveToFileSystem);
        $(document).on('click', '#btn_backup', $todo.backup);
        $(document).on('click', '#btn_restore', $todo.restore);
        $(document).on('mouseover', '.item', $todo.actionMouseover);
        $(document).on('mouseout', '.item', $todo.actionMouseoff);
        $(document).on('mousedown', $todo.actionMousedown);
        $(document).on('mouseup', $todo.actionMouseup);
        $(document).on('change', '#sel_sort', $todo.actionSelectSort);
        $(document).on('focus', '.action-edit-tag', $todo.actionFocusEditTag);
        $(document).on('click', '.action-more-results', $todo.actionMoreResults);

        $('#img_home').on('click', $todo.actionHome);

        $(document).on('focusout', '#search_input', function(e){
        	console.log('focus out!');
        	last_key_code = null;
        });

        //TODO: factor this out
        $(window).focus(function () { $todo.onWindowFocus(); });

        //console.log('setting event');
        $(document).keydown(function (e) {

            last_key_code = e.keyCode;
            //console.log('last key code = ' + last_key_code);

            if (e.keyCode == 38 && e.ctrlKey) { $todo.actionUp(e); }
            if (e.keyCode == 40 && e.ctrlKey) { $todo.actionDown(e); }
            if (e.keyCode == 13 && e.ctrlKey && e.shiftKey == false) { $todo.actionAdd(e); }
            if (e.keyCode == 13 && e.ctrlKey && e.shiftKey == true) { $todo.actionAddSubItem(e); }
            if (e.keyCode == 83 && e.ctrlKey) { 
                e.preventDefault();
                $persist.saveToFileSystem();
             }
            if (e.keyCode == 9) { $todo.actionAddSubItem(e); }
            if (e.keyCode == 46 || e.keyCode == 8) {
                if (e.ctrlKey) { $todo.actionDelete(); }
            }
            if (e.keyCode == 27) { $todo.onEscape(); }
            if (e.keyCode == 16) { $todo.onShiftDown(); }
            if (e.keyCode == 8 || e.keyCode == 46) { $todo.onBackspaceDown(); }
            if (e.keyCode == 38) { // up arrow
                if ($auto_complete.getModeHidden() == false) {
                    $auto_complete.arrowUp();
                    e.preventDefault();
                }
                else if ($auto_complete_tags.getModeHidden() == false) {
                    $auto_complete_tags.arrowUp();
                    e.preventDefault();
                }
            }
            else if (e.keyCode == 40) { // down arrow
                if ($auto_complete.getModeHidden() == false) {
                    $auto_complete.arrowDown();
                    e.preventDefault();
                }
                else if ($auto_complete_tags.getModeHidden() == false) {
                    $auto_complete_tags.arrowDown();
                    e.preventDefault();
                }
            }
            else if (e.keyCode == 13 || e.keyCode == 9) { //enter | tab
                $todo.onEnterOrTab();
                //e.preventDefault();
            }
            else if (e.keyCode == 27) { //esc
                $todo.onEscape();
                e.preventDefault();
            }
        });

        $(document).keyup(function (e) {
            if (e.keyCode == 16) { $todo.onShiftUp(); }
            if (e.keyCode == 8 || e.keyCode == 46) { $todo.onBackspaceUp(); }
        });

        $(document).on({
            mouseenter: function (e) {
                let id = parseInt($(this).attr('data-suggestion-id'));
                $auto_complete.updateSelectedSearchSuggestion(id);
            },
            mouseleave:function (e) {
                $auto_complete.updateSelectedSearchSuggestion();
            }
        },'.suggestion');

        $(document).on({
            mouseenter: function (e) {
                let id = parseInt($(this).attr('data-tag-suggestion-id'));
                $auto_complete_tags.updateSelectedSearchSuggestion(id);
            },
            mouseleave:function (e) {
                $auto_complete_tags.updateSelectedSearchSuggestion();
            },
            click: function (e) {
            	$todo.onClickTagSuggestion();
            }
        },'.tag-suggestion');

        $('#search_input').focus(function() {
            if ($('#search_input').val() == '') { $auto_complete.onChange(); }
        });

        $('#search_input').click(function() { $auto_complete.showOptions(); });

        $('#div_search_bar').focusout(function() {
            $auto_complete.hideOptions();
            $auto_complete_tags.hideOptions();
        });

        $('#search_input').focus(function(e) {
            e.preventDefault();
            $todo.onSearchFocus();
        });

        $('#div_auto').on('mousedown', function(e) {
            e.preventDefault();
            $auto_complete.selectSuggestion();
            $todo.actionEditSearch();
        });

        window.onbeforeunload = function() { $persist.save(); }

        console.log('done registering events');
    }

	return {
		registerEvents: registerEvents
	}

})();