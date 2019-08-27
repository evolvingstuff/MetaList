/* This allows us to make modifications to the DOM after the initial render,
which means that this can all be separate from the main cache and render logic,
and allows for stuff like highlighted text, animations, etc... */

let $effects = (function() {

	let highlight_item_ids = [];
	let shadow_item_ids = [];
    let emphasis_paths = [];
	let highlighted_text = null;
    let APPLY_CLIPBOARD_SUBSTITUTIONS_INTO_EXEC = true; //TODO: speed this up at some point?

    let nomnomlDrawings = [];

    function addNomnomlDrawing(canvasId, sourceText) {
        console.log('addNomnomlDrawing()\tcanvasId:' + canvasId);
        nomnomlDrawings.push({
            "canvasId": canvasId,
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

    function emphasize(path) {
        emphasis_paths.push(path);
    }

    function emphasis_highlights() {
        for (let path of emphasis_paths) {
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

    function priority_highlights(highlight_item_ids, shadow_item_ids) {
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

    function clipboard_substitutions(selected_item) {
        console.log('')
        console.log('clipboard_substitutions()');
        let clipboard_text = $todo.getClipboardText();
        if (clipboard_text != undefined && clipboard_text != null && clipboard_text != '') {
            clipboard_text = escapeHtmlWithSpaces(clipboard_text);
            console.log(clipboard_text);
            let t1 = Date.now();
            let matches = 0;
            const items = $model.getItems();
            for (let item of items) {
                if (item.subitems[0]._include != 1) {
                    continue;
                }
                if (selected_item != null && item.id == selected_item.id) {
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
                    if (subitem._direct_tags.includes('@exec') && 
                        subitem.data.indexOf(CLIPBOARD_ESCAPE_SEQUENCE) > -1) {
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

	function apply_post_render_effects(selected_item) {

        let items_ = $model.getFilteredItems();

		console.log('=================================');
		console.log('apply_post_render_effects() ');

        //TODO: we should never be throwing this error
        try {

            set_link_targets();

            priority_highlights(highlight_item_ids, shadow_item_ids)

            if (APPLY_CLIPBOARD_SUBSTITUTIONS_INTO_EXEC) {
                clipboard_substitutions(selected_item);
            }

            emphasis_highlights(emphasis_paths);

            for (let nd of nomnomlDrawings) {
                console.log('drawing nomnoml: ' + JSON.stringify(nd['canvadId']));
                var canvas = document.getElementById(nd['canvasId']);
                var source = nd['sourceText']
                try {
                    nomnoml.draw(canvas, source);
                }
                catch (e) {
                    console.log('Could not draw canvas.');
                }
            }
            nomnomlDrawings = [];
            
        }
        catch (e) {
            console.log('WARNING:');
            console.error(e);
        }

        //reset stuff
        highlight_item_ids = [];
        shadow_item_ids = [];
        emphasis_paths = [];
        highlighted_text = null;
	}

	return {
		temporary_highlight: temporary_highlight,
		temporary_shadow: temporary_shadow,
		apply_post_render_effects: apply_post_render_effects,
        emphasize: emphasize,
        addNomnomlDrawing: addNomnomlDrawing
	}

})();