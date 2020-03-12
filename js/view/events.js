"use strict";

const NEW_SUBITEM_ON_ENTER = false; //TODO there is a bug with this

let $events = (function() {

    const KEY_ENTER = 13;
    const KEY_CTRL = 17;
    const KEY_TAB = 9;
    const KEY_C = 67;
    const KEY_V = 86;
    const KEY_LEFT_ARROW = 37;
    const KEY_UP_ARROW = 38;
    const KEY_RIGHT_ARROW = 39;
    const KEY_DOWN_ARROW = 40;
    const KEY_ESC = 27;
    const KEY_S = 83;
    const KEY_M = 77;
    const KEY_DEL = 46;
    const KEY_BACKSPACE = 8;

	function registerEvents() {

        $(document).on('click', 'a', function(e) {
            e.stopPropagation();
        });

        $(document).on('click', '.action-toggle-advanced', $todo.actionToggleAdvancedView);

        $('#search-input').bind("paste", function(e) {
            console.log('paste into search-input');
            e.stopPropagation();
        });

        $('body').bind("paste", function(e){
            // access the clipboard using the api
            var pastedTextData = e.originalEvent.clipboardData.getData('text');
            let pastedHTMLData = e.originalEvent.clipboardData.getData('text/html');
            $todo.actionPaste(e, pastedTextData, pastedHTMLData);
        } );

        $(document).on('click', '.action-expand-redacted', $todo.actionExpandRedacted);

        $(document).on('click', '.edit-bar', $todo.onClickEditBar);
        $(document).on('click', '.copyable', $todo.onCopy);
        $(document).on('click', '.shell', $todo.onShell);
        $(document).on('click', '.open-file', $todo.onOpenFile);
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
        $(document).on('mousedown', '.item', $todo.actionMousedown);
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
        $(document).on('mouseup', '.item', $todo.actionMouseup);
        $(document).on('focus', '.action-edit-tag', $todo.actionFocusEditTag);
        $(document).on('click', '.action-more-results', $todo.actionMoreResults);
        $(window).focus($todo.onWindowFocus);

        $(document).keydown(function (e) { //TODO: don't attach to entire document?

            //console.log(e.keyCode);

            if (NEW_SUBITEM_ON_ENTER && e.keyCode == KEY_ENTER && e.shiftKey) {
                $todo.onShiftEnter(e);
                return;
            }

            if (e.ctrlKey) {

                if (e.keyCode == KEY_BACKSPACE) {
                    $todo.onCtrlBackspace(e);
                    return;
                }

                if (e.shiftKey && e.keyCode == KEY_C) {
                    $todo.actionCopySubsection();
                    return;
                }

                if (e.shiftKey && e.keyCode == KEY_V) {
                    $todo.actionPasteSubsection();
                    return;
                }

                if (e.keyCode == KEY_RIGHT_ARROW) {
                    $todo.actionIndent(e);
                    return;
                }

                if (e.keyCode == KEY_LEFT_ARROW) {
                    $todo.actionUnindent(e);
                    return;
                }

                if (e.keyCode == KEY_UP_ARROW) { 
                    if (e.shiftKey == true) {
                        $todo.actionFullUp(e); 
                        return;
                    }
                    else {
                        $todo.actionUp(e); 
                        return;
                    }
                }
                if (e.keyCode == KEY_DOWN_ARROW) { 
                    if (e.shiftKey) {
                        $todo.actionFullDown(e); 
                        return;
                    }
                    else {
                        $todo.actionDown(e); 
                        return;
                    }
                }

                if (NEW_SUBITEM_ON_ENTER == false) {
                    if (e.keyCode == KEY_ENTER && e.ctrlKey && e.shiftKey == false) { 
                        $todo.actionAdd(e); 
                        return;
                    }
                    if (e.keyCode == KEY_ENTER && e.ctrlKey && e.shiftKey) { 
                        $todo.actionAddSubItem(e); 
                        return;
                    }
                }

                if (e.keyCode == KEY_S && e.ctrlKey) { 
                    $todo.actionSave(e); 
                    return;
                };
                if (e.keyCode == KEY_M && e.ctrlKey) { 
                    $todo.actionAddMetaRule(e); 
                    return;
                };
            }

            if (e.keyCode == KEY_UP_ARROW) { 
                $todo.onUpArrow(e); 
                return;
            }

            if (e.keyCode == KEY_DOWN_ARROW) { 
                $todo.onDownArrow(e); 
                return;
            }

            if (e.keyCode == KEY_ENTER) { 
                $todo.onEnter(e); 
                return;
            }

            if (e.keyCode == KEY_TAB) {
                $todo.onTab(e); 
                return;
            }
            
            if ((e.keyCode == KEY_DEL || e.keyCode == KEY_BACKSPACE) && e.ctrlKey) { 
                $todo.actionDelete(e); 
                return;
            }
            if (e.keyCode == KEY_ESC) {
                $todo.onEscape(e); 
                return;
            }
            if (e.keyCode == KEY_BACKSPACE || e.keyCode == KEY_DEL) { 
                $todo.onBackspaceDown(e); 
                return;
            }
            
        });

        $(document).keyup(function (e) {
            if (e.keyCode == KEY_BACKSPACE || e.keyCode == KEY_DEL) { 
                $todo.onBackspaceUp(e); 
                return;
            }
        });

        $(document).on({
            //mouseenter
            mousemove: function (e) {
                let id = parseInt($(e.currentTarget).attr('data-suggestion-id'));
                $todo.updateSelectedSearchSuggestion(id);
                //$todo.handleEvent(e);
            },
            mouseleave:function (e) {
                //$todo.updateSelectedSearchSuggestion();
            }
        },'.suggestion');

        $(document).on({
            //mouseenter
            mousemove: function (e) {
                let id = parseInt($(e.currentTarget).attr('data-tag-suggestion-id'));
                $todo.updateSelectedTagSuggestion(id);
                //$todo.handleEvent(e);
            },
            mouseleave:function (e) {
                $todo.updateSelectedTagSuggestion();
            },
            click: function (e) {
            	$todo.onClickTagSuggestion();
            }
        },'.tag-suggestion');

        // $(document).on({ 
        //     mouseover: function(e) {
        //         $todo.updateSelectedSearchSuggestion();
        //         //$todo.updateSelectedTagSuggestion();
        //         //console.log('DEBUG: mousemove document');
        //     }
        // }, 'body');

        $('#search-input').click($todo.onSearchClick);
        $('#search-bar').focusout($todo.onSearchFocusOut);
        $('#div-auto').on('mousedown', $todo.onClickSelectSearchSuggestion);
        $('body').on('click','.action-check', $todo.onCheck);
        $('body').on('click','.action-uncheck', $todo.onUncheck);
        $('body').on('click','.action-fold', $todo.onFold);
        $('body').on('click','.action-unfold', $todo.onUnfold);

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
    }

	return {
		registerEvents: registerEvents
	}

})();