'use strict';

/*
Commands that can be run from inside the console to aid in app development
TODO: add functions to control console logging
*/

let $help = (function(){
	function help() {
		console.log('-----------------------------');
		console.log('help:');
		console.log('  available functions:');
		console.log('  * remove_all_items()');
	}

	function remove_all_items() {
		let items = $model.getItems();
		console.log('removing ' +items.length + ' items');
		items.length = 0;
	}

	return {
		help: help,
		remove_all_items: remove_all_items
	}
})();