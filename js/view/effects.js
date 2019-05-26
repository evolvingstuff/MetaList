/* This allows us to make modifications to the DOM after the initial render,
which means that this can all be separate from the main cache and render logic,
and allows for stuff like highlighted text, animations, etc... */

let $effects = (function() {

	let dragged_item_id = null;
	let highlighted_text = null;

	function temporary_highlight(item) {
		console.log('------------------------------------');
		console.log('highlighted item id = ' + item.id);
		dragged_item_id = item.id;
	}

	function apply_post_render_effects() {

		console.log('=================================');
		console.log('apply_post_render_effects() ');

        //apply stuff
        if (dragged_item_id != null) {
        	console.log('Highlighted item');
        	let $el = $("div").find(`[data-item-id='${dragged_item_id}']`);
        	$el.addClass('temporary_highlight-at-instant');
        	window.setTimeout(function() {
        		$el.addClass('temporary_highlight-after');
        	}, 1);
        }

        //reset stuff
        dragged_item_id = null;
        highlighted_text = null;
	}

	return {
		temporary_highlight: temporary_highlight,
		apply_post_render_effects: apply_post_render_effects
	}

})();