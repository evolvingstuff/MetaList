"use strict";

/* This allows us to make modifications to the DOM after the initial render,
which means that this can all be separate from the main cache and render logic,
and allows for stuff like highlighted text, animations, etc... */

let $effects = (function() {

    const DARKEN_UNSELECTED_ITEMS = false;
    let APPLY_CLIPBOARD_SUBSTITUTIONS_INTO_EXEC = true; //TODO: speed this up at some point?

	let highlight_item_ids = [];
	let shadow_item_ids = [];
    let emphasis_subitem_paths = [];
    
    let nomnomlDrawings = [];
    let qrCodes = [];

    function addNomnomlDrawing(canvasId, sourceText) {
        nomnomlDrawings.push({
            "canvasId": canvasId,
            "sourceText": sourceText
        });
    }

    function addQRCode(divId, sourceText) {
        qrCodes.push({
            "divId": divId,
            "sourceText": sourceText
        });
    }

	function temporary_highlight(id) {
        if (highlight_item_ids.includes(id) == false) {
		  highlight_item_ids.push(id);
        }
	}

	function temporary_shadow(id) {
        if (shadow_item_ids.includes(id) == false) {
		  shadow_item_ids.push(id);
        }
	}

    function emphasizeSubitem(path) {
        emphasis_subitem_paths.push(path);
    }

    function emphasizeSubitemAndChildren(item, path) {
        emphasis_subitem_paths.push(path);
        let subitem_index = parseInt(path.split(':')[1]);
        for (let i = subitem_index + 1; i < item.subitems.length; i++) {
            if (item.subitems[i].indent <= item.subitems[subitem_index].indent) {
                break;
            }
            emphasis_subitem_paths.push(item.id+':'+i);
        }
    }

    function emphasisSubitemHighlights() {
        for (let path of emphasis_subitem_paths) {
            console.log(path);
            let $el = $("div").find(`[data-subitem-path='${path}']`);
            $el.removeClass('temporary-highlight-at-instant');
            $el.removeClass('temporary-highlight-after');
            $el.addClass('temporary-highlight-at-instant');
            window.setTimeout(function() {
                $el.addClass('temporary-highlight-after');
            }, 1);
        }
    }

    function priorityHighlights(highlight_item_ids, shadow_item_ids) {
        for (let id of highlight_item_ids) {
            let $el = $("div").find(`[data-item-id='${id}']`);
            $el.removeClass('temporary-highlight-at-instant');
            $el.removeClass('temporary-highlight-after');
            $el.addClass('temporary-highlight-at-instant');
            window.setTimeout(function() {
                $el.addClass('temporary-highlight-after');
            }, 1);
        }

        for (let id of shadow_item_ids) {
            let $el = $("div").find(`[data-item-id='${id}']`);

            $el.removeClass('temporary-highlight-at-instant');
            $el.removeClass('temporary-highlight-after');

            $el.addClass('temporary-shadow-at-instant');
            window.setTimeout(function() {
                $el.addClass('temporary-shadow-after');
            }, 1);
        }
    }

    function clipboard_substitutions(selectedItem) {
        console.log('')
        console.log('clipboard_substitutions()');
        let clipboard_text = $todo.getClipboardText();
        if (clipboard_text != undefined && clipboard_text != null && clipboard_text != '') {
            clipboard_text = escapeHtmlWithSpaces(clipboard_text);
            console.log(clipboard_text);
            let t1 = Date.now();
            let matches = 0;
            const items = $model.getUnsortedItems();
            for (let item of items) {
                if (item.subitems[0]._include != 1) {
                    continue;
                }
                if (selectedItem != null && item.id == selectedItem.id) {
                    console.log('Do not attempt to render items in edit mode.');
                    continue;
                }
                for (let i = 0; i < item.subitems.length; i++) {
                    let subitem = item.subitems[i];
                    if (subitem._include == -1) {
                        continue;
                    }
                    if (item.collapse != undefined && item.collapse == 1 && i > 0) {
                        break;
                    }
                    if (subitem._direct_tags.includes('@shell') && 
                        subitem.data.includes(CLIPBOARD_ESCAPE_SEQUENCE)) {
                        console.log('-------------------------------');
                        console.log(subitem);
                        matches += 1;
                        let path = item.id + ':'+i;
                        console.log('path = ' + path)
                        let query = "[data-subitem-path='"+path+"']";
                        console.log($(query));
                        let $el1 = $(query)[0];
                        $el2 = $($el1).find('code');
                        let html = $($el2).html();
                        if (html == undefined) {
                            console.error('html is undefined');
                        }
                        html = html.replace(CLIPBOARD_ESCAPE_SEQUENCE, clipboard_text);
                        $el2.html(html);
                    }
                }
            }
            let t2 = Date.now();
            console.log('CLIPBOARD UPDATES ('+(t2-t1)+'ms) = ' + matches);
        }
    }

    function set_link_targets() {
        $("a").attr("target","_blank");
    }

    function highlightsFromTextSearch(selectedItem) {

        //TODO: currently a little buggy if a subitem has 
        //html formatted stuff

        let search = $auto_complete.getSearchString();
        let parse = $parseSearch.parse(search);
        let highlights = [];
        for (let part of parse) {
            if (part.type != 'substring') {
                continue;
            }
            if (part.negated != undefined) {
                continue
            }
            highlights.push(part.text);
        }
        if (highlights.length == 0) {
            return;
        }
        const items = $model.getUnsortedItems();
        for (let item of items) {
            if (item._include == -1) {
                continue;
            }
            if (selectedItem != null && selectedItem.id == item.id) {
                continue;
            }
            let el = $view.getItemElementById(item.id);
            if (el == undefined) {
                continue;
            }
            for (let i = 0; i < item.subitems.length; i++) {
                let subitem = item.subitems[i];
                if (subitem._include == -1) {
                    continue;
                }
                for (let hl of highlights) {
                    //TODO: need to escape for regex
                    if (hl.length < 2) {
                        continue;
                    }
                    let strippedText = $format.stripFormatting(item.subitems[i].data).toLowerCase();
                    if (strippedText.includes(hl.toLowerCase())) {
                        let sub = $view.getSubitemElementByPath(item.id+':'+i);
                        if (sub == undefined) {
                            continue;
                        }
                        let escapedRegex = v.escapeRegExp(hl);
                        console.log('DEBUG: escapedRegex = ' + escapedRegex);
                        let rgxp = new RegExp('('+escapedRegex+')', 'gi');
                        let repl = '<span class="highlight-substring-from-search">$1</span>';
                        let updated = $(sub).html().replace(rgxp, repl);
                        //console.log('updated -> ' + updated);
                        $(sub).html(updated);
                    }
                }
            }
        }
    }

    function nomnomlEffects() {
        for (let nd of nomnomlDrawings) {
            console.log('drawing nomnoml: ' + JSON.stringify(nd['canvadId']));
            var canvas = document.getElementById(nd['canvasId']);
            var source = nd['sourceText']
            try {
                nomnoml.draw(canvas, source);
            }
            catch (e) {
                console.error('Could not draw canvas.');
            }
        }
        
    }

    function qrEffects() {
        for (let qr of qrCodes) {
            console.log('drawing qr: ' + JSON.stringify(qr['divId']));
            try {
                let qrcode = new QRCode(document.getElementById(qr['divId']), {
                    text: qr['sourceText'],
                    width: 128,
                    height: 128,
                    colorDark : "#000000",
                    colorLight : "#ffffff",
                    correctLevel : QRCode.CorrectLevel.H
                });
            }
            catch (e) {
                console.error('Could not draw qr code ' + e);
            }
        }
    }

    function darkenUnselected(selectedItem) {
        if (selectedItem == null) {
            return;
        }
        $('div.item').addClass('darken-unselected-item');
        let div = $view.getItemElementById(selectedItem.id);
        $(div).removeClass('darken-unselected-item');
    }


	function apply_post_render_effects(selectedItem) {

		console.log('=================================');
		console.log('apply_post_render_effects() ');

        //TODO: we should never be throwing this error
        try {

            set_link_targets();

            priorityHighlights(highlight_item_ids, shadow_item_ids)

            if (APPLY_CLIPBOARD_SUBSTITUTIONS_INTO_EXEC) {
                clipboard_substitutions(selectedItem);
            }

            emphasisSubitemHighlights(emphasis_subitem_paths);

            nomnomlEffects();

            qrEffects();

            highlightsFromTextSearch(selectedItem);

            if (DARKEN_UNSELECTED_ITEMS) {
                darkenUnselected(selectedItem);
            }
            
        }
        catch (e) {
            console.log('WARNING:');
            console.error(e);
        }

        //reset stuff
        highlight_item_ids = [];
        shadow_item_ids = [];
        emphasis_subitem_paths = [];
        nomnomlDrawings = [];
        qrCodes = [];
	}

	return {
		temporary_highlight: temporary_highlight,
		temporary_shadow: temporary_shadow,
		apply_post_render_effects: apply_post_render_effects,
        emphasizeSubitem: emphasizeSubitem,
        emphasizeSubitemAndChildren: emphasizeSubitemAndChildren,
        addNomnomlDrawing: addNomnomlDrawing,
        addQRCode: addQRCode
	}

})();