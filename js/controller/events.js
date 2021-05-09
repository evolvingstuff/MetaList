"use strict";

const EVENT_ON_CLICK_ENTER = 'EVENT_ON_CLICK_ENTER';
const EVENT_ON_CLICK_TAB = 'EVENT_ON_CLICK_TAB';
const EVENT_ON_SAVE = 'EVENT_ON_SAVE';
const EVENT_ON_CLICK_ADD_NEW_ITEM = 'EVENT_ON_CLICK_ADD_NEW_ITEM';
const EVENT_ON_CLICK_ADD_NEW_SUBITEM = 'EVENT_ON_CLICK_ADD_NEW_SUBITEM';
const EVENT_ON_CLICK_CTRL_SHIFT_ENTER = 'EVENT_ON_CLICK_CTRL_SHIFT_ENTER';
const EVENT_ON_CLICK_CTRL_ENTER = 'EVENT_ON_CLICK_CTRL_ENTER';
const EVENT_ON_CLICK_DELETE = 'EVENT_ON_CLICK_DELETE';
const EVENT_ON_LOGOUT = 'EVENT_ON_LOGOUT';

let $events = (function() {

    const KEY_ENTER = 13;
    const KEY_CTRL = 17;
    const KEY_TAB = 9;
    const KEY_C = 67;
    const KEY_V = 86;
    const KEY_I = 73;
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

        $(document).on('click', 'a', function(e) { e.stopPropagation(); });

        $('#search-input').bind("paste", function(e) {
            console.log('paste into search-input');
            e.stopPropagation();
        });

        $(document).on('mousedown', 'a', $main_controller.onMousedownLink);

        $(document).on('click', '.action-expand-redacted', $main_controller.actionExpandRedacted);
        $(document).on('click', '.edit-bar', $main_controller.onClickEditBar);
        $(document).on('click', '.copyable', $main_controller.onCopy);
        $(document).on('click', '.shell', $main_controller.onShell);
        $(document).on('click', '.open-file', $main_controller.onOpenFile);
        $(document).on('click', 'body', $main_controller.onClickDocument);
        $(document).on('click', '.subitemdata', $main_controller.onClickSubitem);
        $(document).on('input', '.subitemdata', $main_controller.onEditSubitem);
        $(document).on('focus', '.subitemdata', $main_controller.onFocusSubitem);
        $(document).on('click', '.action-expand', $main_controller.actionExpandItem);
        $(document).on('click', '.action-collapse', $main_controller.actionCollapseItem);
        $(document).on('click', '.action-up', $main_controller.actionUp);
        $(document).on('click', '.action-down', $main_controller.actionDown);
        $(document).on('click', '.action-delete', (e) => { $main_controller.eventRouter(EVENT_ON_CLICK_DELETE, e); });
        $(document).on('click', '.action-add', (e) => { $main_controller.eventRouter(EVENT_ON_CLICK_ADD_NEW_SUBITEM, e) });
        $(document).on('click', '.action-add-new-item', (e) => { $main_controller.eventRouter(EVENT_ON_CLICK_ADD_NEW_ITEM, e); });
        $(document).on('click', '.action-make-link', $main_controller.actionMakeLinkEmbed); //TODO: could do other
        $(document).on('click', '.action-copy-subsection', $main_controller.actionCopySubsection);
        $(document).on('click', '.action-paste-subsection', $main_controller.actionPasteSubsection);
        $(document).on('click', '.action-remove-formatting', $main_controller.actionRemoveFormatting);
        $(document).on('click', '.action-split', $main_controller.actionSplit);
        $(document).on('click', '.action-extract', $main_controller.actionExtract);
        $(document).on('input', '.action-edit-tag', $main_controller.actionEditTag);
        $(document).on('click', '.action-edit-time', function(e) { e.stopPropagation()});
        $(document).on('change', '.action-edit-time', $main_controller.actionEditTime);
        $(document).on('input', '.action-edit-search', $main_controller.actionEditSearch);
        $(document).on('click', '.action-indent', $main_controller.actionIndent);
        $(document).on('click', '.action-unindent', $main_controller.actionUnindent);
        $(document).on('mouseover', '.action-delete', $main_controller.onMouseoverDelete);
        $(document).on('mouseout', '.action-delete', $main_controller.onMouseoutDelete);
        $(document).on('mouseover', '.item', $main_controller.actionMouseoverItem);
        $(document).on('mouseout', '.item', $main_controller.actionMouseoffItem);
        $(document).on('mousedown', '.item', $main_controller.actionMousedownItem);
        $(document).on('mouseup', '.item', $main_controller.actionMouseupItem);
        $(document).on('click', '.action-toggle-heading', (e) => { $main_controller.genericToggleFormatTag(META_HEADING, e); });
        $(document).on('click', '.action-toggle-bold', (e) => { $main_controller.genericToggleFormatTag(META_BOLD, e); });
        $(document).on('click', '.action-toggle-italic', (e) => { $main_controller.genericToggleFormatTag(META_ITALIC, e); });
        $(document).on('click', '.action-toggle-todo', (e) => { $main_controller.genericToggleFormatTag(META_TODO, e); });
        $(document).on('click', '.action-toggle-done', (e) => { $main_controller.genericToggleFormatTag(META_DONE, e); });
        $(document).on('click', '.action-toggle-code', (e) => { $main_controller.genericToggleFormatTag(META_CODE, e); });
        $(document).on('click', '.action-toggle-list-bulleted', (e) => { $main_controller.genericToggleFormatTag(META_LIST_BULLETED, e); });
        $(document).on('click', '.action-toggle-list-numbered', (e) => { $main_controller.genericToggleFormatTag(META_LIST_NUMBERED, e); });
        $(document).on('click', '.action-toggle-date-headline', (e) => { $main_controller.genericToggleFormatTag(META_DATE_HEADLINE, e); });
        $(document).on('focus', '.action-edit-tag', $main_controller.onClickTagBar);
        $(document).on('click', '.action-more-results', $main_controller.actionMoreResults);
        $(window).focus($main_controller.onWindowFocus);
        $(document).on('mousemove', '.subitemdata', $main_controller.onMouseMoveOverSubitem);

        $(document).keydown(function (e) { //TODO: don't attach to entire document?

            //console.log(e.keyCode);

            if (e.ctrlKey) {

                if (e.shiftKey && e.keyCode === KEY_C) {
                    $main_controller.actionCopySubsection();
                    return;
                }

                if (e.shiftKey && e.keyCode === KEY_V) {
                    $main_controller.actionPasteSubsection();
                    return;
                }

                if (e.keyCode === KEY_RIGHT_ARROW) {
                    $main_controller.actionIndent(e);
                    return;
                }

                if (e.keyCode === KEY_LEFT_ARROW) {
                    $main_controller.actionUnindent(e);
                    return;
                }

                if (e.keyCode === KEY_UP_ARROW) { 
                    if (e.shiftKey === true) {
                        $main_controller.actionFullUp(e); 
                        return;
                    }
                    else {
                        $main_controller.actionUp(e); 
                        return;
                    }
                }
                if (e.keyCode === KEY_DOWN_ARROW) { 
                    if (e.shiftKey) {
                        $main_controller.actionFullDown(e); 
                        return;
                    }
                    else {
                        $main_controller.actionDown(e); 
                        return;
                    }
                }

                if (e.keyCode === KEY_ENTER && e.ctrlKey) {
                    if (e.shiftKey) {
                        $main_controller.eventRouter(EVENT_ON_CLICK_CTRL_SHIFT_ENTER, e);
                    }
                    else {
                        $main_controller.eventRouter(EVENT_ON_CLICK_CTRL_ENTER, e);
                    }
                    return;
                }

                if (e.keyCode === KEY_S && e.ctrlKey) {
                    $main_controller.eventRouter(EVENT_ON_SAVE, e);
                    return;
                };
                
                if (e.keyCode === KEY_I && e.ctrlKey && e.shiftKey === false) { 
                    $main_controller.actionAddMetaRule(e); 
                    return;
                };
            }

            if (e.keyCode === KEY_UP_ARROW) { 
                $main_controller.onUpArrow(e); 
                return;
            }

            if (e.keyCode === KEY_DOWN_ARROW) { 
                $main_controller.onDownArrow(e); 
                return;
            }

            if (e.keyCode === KEY_ENTER) { 
                $main_controller.onEnter(e); 
                return;
            }

            if (e.keyCode === KEY_TAB) {
                $main_controller.onTab(e); 
                return;
            }
            
            if ((e.keyCode === KEY_DEL || e.keyCode === KEY_BACKSPACE) && e.ctrlKey) { 
                $main_controller.actionDelete(e); 
                return;
            }
            
            if (e.keyCode === KEY_ESC) {
                $main_controller.onEscape(e); 
                return;
            }
            if (e.keyCode === KEY_BACKSPACE || e.keyCode === KEY_DEL) { 
                $main_controller.onBackspaceDown(e); 
                return;
            }
            
        });

        $(document).keyup(function (e) {
            if (e.keyCode === KEY_BACKSPACE || e.keyCode === KEY_DEL) { 
                $main_controller.onBackspaceUp(e); 
                return;
            }
        });

        $(document).on({
            //mouseenter
            mousemove: function (e) {
                let id = parseInt($(e.currentTarget).attr('data-suggestion-id'));
                $main_controller.updateSelectedSearchSuggestion(id);
            },
            mouseleave:function (e) {
                //$main_controller.updateSelectedSearchSuggestion();
            }
        },'.suggestion');

        $(document).on({
            //mouseenter
            mousemove: function (e) {
                let id = parseInt($(e.currentTarget).attr('data-tag-suggestion-id'));
                $main_controller.updateSelectedTagSuggestion(id);
            },
            mouseleave:function (e) {
                $main_controller.updateSelectedTagSuggestion();
            },
            click: function (e) {
            	$main_controller.onClickTagSuggestion();
            }
        },'.tag-suggestion');

        $('#div-search-suggestions').on('mousedown', $main_controller.onClickSelectSearchSuggestion);
        $('body').on('click','.action-check', $main_controller.onCheck);
        $('body').on('click','.action-uncheck', $main_controller.onUncheck);

        $(document).on('mouseover', '.subitemdata', $main_controller.onMouseOverSubitem);
        $(document).on('mouseout', '#div-items', $main_controller.onMouseOutItems);

        $('#btn_menu').on('click', $main_controller.onClickMenu);

        document.onload = $main_controller.resetInactivityTimer;
        document.onmousemove = $main_controller.resetInactivityTimer;
        document.onmousedown = $main_controller.resetInactivityTimer;
        document.ontouchstart = $main_controller.resetInactivityTimer;
        document.onclick = $main_controller.resetInactivityTimer;
        document.onscroll = $main_controller.resetInactivityTimer;
        document.onkeypress = $main_controller.resetInactivityTimer;
    }

	return {
		registerEvents: registerEvents
	}

})();