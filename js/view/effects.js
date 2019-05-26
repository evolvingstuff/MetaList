/* This allows us to make modifications to the DOM after the initial render,
which means that this can all be separate from the main cache and render logic,
and allows for stuff like highlighted text, animations, etc... */

let $effects = (function() {

	let highlight_item_ids = [];
	let shadow_item_ids = [];
	let highlighted_text = null;

	function temporary_highlight(id) {
		highlight_item_ids.push(id);
	}

	function temporary_shadow(id) {
		shadow_item_ids.push(id);
	}

	function apply_post_render_effects() {

		console.log('=================================');
		console.log('apply_post_render_effects() ');

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