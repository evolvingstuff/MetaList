"use strict";

let $events = (function() {

	function registerEvents() {

        $(document).on('click', 'a', function(e) {
            e.stopPropagation();
        });

        $(document).on('click', '.action-toggle-advanced', $todo.actionToggleAdvancedView);

        $('body').bind("paste", function(e){
            // access the clipboard using the api
            var pastedTextData = e.originalEvent.clipboardData.getData('text');
            let pastedHTMLData = e.originalEvent.clipboardData.getData('text/html');
            $todo.actionPaste(e, pastedTextData, pastedHTMLData);
        } );

        $(document).on('click', '.edit-bar', $todo.onClickEditBar);
        $(document).on('click', '.copyable', $todo.onCopy);
        $(document).on('click', '.shell', $todo.onShell);
        $(document).on('click', '.item', $todo.onClickItem);
        $(document).on('click', 'body', $todo.onClickDocument);
        $(document).on('click', '.subitemdata', $todo.onClickSubitem);
        $(document).on('input', '.subitemdata', $todo.onEditSubitem);
        $(document).on('focus', '.subitemdata', $todo.onFocusSubitem);
        $(document).on('click', '.action-expand', $todo.actionExpandItem);
        $(document).on('click', '.action-collapse', $todo.actionCollapseItem);
        $(document).on('click', '.action-up', $todo.actionUp);
        $(document).on('click', '.action-down', $todo.actionDown);
        $(document).on('click', '.action-delete', $todo.actionDeleteButton);
        $(document).on('click', '.action-add', $todo.actionAdd);
        $(document).on('click', '.action-add-new-item', $todo.actionAddNewItem);
        $(document).on('click', '.action-make-link', $todo.actionMakeLinkEmbed); //TODO: could do other
        $(document).on('click', '.action-copy-subsection', $todo.actionCopySubsection);
        $(document).on('click', '.action-paste-subsection', $todo.actionPasteSubsection);
        $(document).on('click', '.action-remove-formatting', $todo.actionRemoveFormatting);
        $(document).on('click', '.action-goto-search', $todo.actionGotoSearch);
        $(document).on('input', '.action-edit-tag', $todo.actionEditTag);
        $(document).on('click', '.action-edit-time', function(e) { e.stopPropagation()});
        $(document).on('change', '.action-edit-time', $todo.actionEditTime);
        $(document).on('input', '.action-edit-search', $todo.actionEditSearch);
        $(document).on('click', '.action-indent', $todo.actionIndent);
        $(document).on('click', '.action-unindent', $todo.actionUnindent);
        $(document).on('mouseover', '.item', $todo.actionMouseover);
        $(document).on('mouseout', '.item', $todo.actionMouseoff);
        $(document).on('mousedown', $todo.actionMousedown);
        $(document).on('click', '.action-toggle-heading', $todo.actionToggleHeading);
        $(document).on('click', '.action-toggle-expanded', $todo.actionToggleExpanded);
        $(document).on('click', '.action-toggle-collapsed', $todo.actionToggleCollapsed);
        $(document).on('click', '.action-toggle-bold', $todo.actionToggleBold);
        $(document).on('click', '.action-toggle-italic', $todo.actionToggleItalic);
        $(document).on('click', '.action-toggle-todo', $todo.actionToggleTodo);
        $(document).on('click', '.action-toggle-done', $todo.actionToggleDone);
        $(document).on('click', '.action-toggle-code', $todo.actionToggleCode);
        $(document).on('click', '.action-toggle-list-bulleted', $todo.actionToggleListBulleted);
        $(document).on('click', '.action-toggle-list-numbered', $todo.actionToggleListNumbered);
        $(document).on('click', '.action-toggle-date-headline', $todo.actionToggleDateHeadline);
        $(document).on('mouseup', $todo.actionMouseup);
        $(document).on('focus', '.action-edit-tag', $todo.actionFocusEditTag);
        $(document).on('click', '.action-more-results', $todo.actionMoreResults);
        $(window).focus($todo.onWindowFocus);
        $(window).blur($todo.onWindowBlur);

        $(document).keydown(function (e) {

            //console.log(e.keyCode);

            if (e.ctrlKey) {

                if (e.keyCode == 80) {
                    if (e.shiftKey == true) {
                        e.preventDefault();
                        $todo.actionSortByReversePriority();
                    }
                    else {
                        e.preventDefault();
                        $todo.actionSortByPriority();
                    }
                }

                if (e.keyCode == 68) {
                    if (e.shiftKey == true) {
                        e.preventDefault();
                        $todo.actionSortByReverseDate();
                    }
                    else {
                        e.preventDefault();
                        $todo.actionSortByDate();
                    }
                }

                if (e.shiftKey == true && e.keyCode == 67) {
                    e.preventDefault();
                    $todo.actionCopySubsection();
                    return;
                }

                if (e.keyCode == 86) {
                    if (e.shiftKey == true) {
                        e.preventDefault();
                        $todo.actionPasteSubsection();
                        return;
                    }
                }

                if (e.keyCode == 39) {
                    e.stopPropagation();
                    e.preventDefault();
                    $todo.actionIndent(e);
                }

                if (e.keyCode == 37) {
                    e.stopPropagation();
                    e.preventDefault();
                    $todo.actionUnindent(e);
                }

                if (e.keyCode == 38) { 
                    if (e.shiftKey == true) {
                        $todo.actionFullUp(e); 
                    }
                    else {
                        $todo.actionUp(e); 
                    }
                }
                if (e.keyCode == 40) { 
                    if (e.shiftKey == true) {
                        $todo.actionFullDown(e); 
                    }
                    else {
                        $todo.actionDown(e); 
                    }
                }
                if (e.keyCode == 13 && e.ctrlKey && e.shiftKey == false) { $todo.actionAdd(e); }
                if (e.keyCode == 13 && e.ctrlKey && e.shiftKey == true) { $todo.actionAddSubItem(e); }
                if (e.keyCode == 83 && e.ctrlKey) { $todo.actionSave(e); };
                if (e.keyCode == 77 && e.ctrlKey) { $todo.actionAddMetaRule(e); };
            }
            else {
                if (e.keyCode == 38) { $todo.onUpArrow(e); }
                if (e.keyCode == 40) { $todo.onDownArrow(e); }
            }
            
            if (e.keyCode == 9) { $todo.onHotkeyToFromTags(e); }
            if ((e.keyCode == 46 || e.keyCode == 8) && e.ctrlKey) { $todo.actionDelete(e); }
            if (e.keyCode == 27) { $todo.onEscape(e); }
            if (e.keyCode == 8 || e.keyCode == 46) { $todo.onBackspaceDown(e); }
            
            if (e.keyCode == 13 || e.keyCode == 9) { $todo.onEnterOrTab(e); }

            if (e.keyCode == 32) { $todo.onSpace(e); }
        });

        $(document).keyup(function (e) {
            if (e.keyCode == 8 || e.keyCode == 46) { $todo.onBackspaceUp(e); }
        });

        $(document).on({
            mouseenter: function (e) {
                let id = parseInt($(e.currentTarget).attr('data-suggestion-id'));
                $todo.updateSelectedSearchSuggestion(id);
            },
            mouseleave:function (e) {
                $todo.updateSelectedSearchSuggestion();
            }
        },'.suggestion');

        $(document).on({
            mouseenter: function (e) {
                let id = parseInt($(e.currentTarget).attr('data-tag-suggestion-id'));
                $todo.updateSelectedTagSuggestion(id);
            },
            mouseleave:function (e) {
                $todo.updateSelectedTagSuggestion();
            },
            click: function (e) {
            	$todo.onClickTagSuggestion();
            }
        },'.tag-suggestion');
        $('#search-input').click($todo.onSearchClick);
        $('#search-bar').focusout($todo.onSearchFocusOut);
        $('#div-auto').on('mousedown', $todo.onClickSelectSearchSuggestion);
        $('body').on('click','.action-check', $todo.onCheck);
        $('body').on('click','.action-uncheck', $todo.onUncheck);
        $('body').on('click','.action-fold', $todo.onFold);
        $('body').on('click','.action-unfold', $todo.onUnfold);
        window.onbeforeunload = $todo.onBeforeUnload;

        $(document).on('mouseover', '.subitemdata', $todo.setSidebar);
        $(document).on('mouseout', '#div-items', $todo.clearSidebar); //.item

        $(document).on('dblclick', '.subitemdata', $todo.onDblClickSubitem);

        $('#btn_menu').on('click', $todo.onClickMenu);

        document.onload = $todo.resetInactivityTimer;
        document.onmousemove = $todo.resetInactivityTimer;
        document.onmousedown = $todo.resetInactivityTimer;
        document.ontouchstart = $todo.resetInactivityTimer;
        document.onclick = $todo.resetInactivityTimer;
        document.onscroll = $todo.resetInactivityTimer;
        document.onkeypress = $todo.resetInactivityTimer;
        $('body').on('mousemove', $todo.onMouseMove);
        $(document).mouseleave($todo.onMouseLeave);

        console.log('done registering events');
    }

	return {
		registerEvents: registerEvents
	}

})();