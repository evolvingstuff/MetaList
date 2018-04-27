'use strict';

let $vdom = (function() {

    let _DOM = {};

    function render(items_list) {
        console.log('rendering ' + items_list.length + ' items');
        let $items = $('#div_items');
        $items.empty();
        for (let obj of items_list) {
            if (_DOM[obj.h] == undefined) {
                _DOM[obj.h] = $(obj.html);
            }
            $items.append(_DOM[obj.h]);
        }
    }

    /*
	function render(items_list) {
        console.log('rendering ' + items_list.length + ' items');
        let div_items = document.getElementById('div_items');
		let html = '';
		for (let obj of items_list) {
			html += obj.html
		}
        div_items.innerHTML = html;
	}
    */

	return {
		render: render
	}

})();