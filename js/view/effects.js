/* This allows us to make modifications to the DOM after the initial render,
which means that this can all be separate from the main cache and render logic,
and allows for stuff like highlighted text, animations, etc... */

let $effects = (function() {

	let highlight_item_ids = [];
	let shadow_item_ids = [];
	let highlighted_text = null;

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

	function apply_post_render_effects(items, selected_item) {

		console.log('=================================');
		console.log('apply_post_render_effects() ');

        //TODO: we should never be throwing this error
        try {

            //apply stuff
            for (let id of highlight_item_ids) {
            	let $el = $("div").find(`[data-item-id='${id}']`);
            	$el.addClass('temporary-highlight-at-instant');
            	window.setTimeout(function() {
            		$el.addClass('temporary-highlight-after');
            	}, 1);
            }

            for (let id of shadow_item_ids) {
            	let $el = $("div").find(`[data-item-id='${id}']`);
            	$el.addClass('temporary-shadow-at-instant');
            	window.setTimeout(function() {
            		$el.addClass('temporary-shadow-after');
            	}, 1);
            }

            let clipboard_text = $todo.getClipboardText();

            if (clipboard_text != undefined && clipboard_text != null && clipboard_text != '') {

                console.log(clipboard_text);

                //TODO: does this handle tabs?
                clipboard_text = escapeHtmlWithSpaces(clipboard_text);
                console.log(clipboard_text);

                let t1 = Date.now();
                let matches = 0;
                for (let item of items) {
                    if (item.deleted != undefined) {
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
                        if (subitem._direct_tags.includes('@exec') && 
                            subitem.data.indexOf(CLIPBOARD_ESCAPE_SEQUENCE) > -1) {
                            matches += 1;
                            let path = item.id + ':'+i;
                            let query = "[data-subitem-path='"+path+"']";
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
        catch (e) {
            console.log('WARNING:');
            console.error(e);
        }

        //reset stuff
        highlight_item_ids = [];
        shadow_item_ids = [];
        highlighted_text = null;
	}

	return {
		temporary_highlight: temporary_highlight,
		temporary_shadow: temporary_shadow,
		apply_post_render_effects: apply_post_render_effects
	}

})();