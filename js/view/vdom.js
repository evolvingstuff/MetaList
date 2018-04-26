'use strict';

let $vdom = (function() {

	let _prev = [];

	function render(items_list) {
		//console.log('dumb vdom todo...');
		let html = '';
		for (let obj of items_list) {
			html += obj.html
		}
		var div_items = document.getElementById('div_items');
        div_items.innerHTML = html;
        _prev = items_list;
	}

	/*
	function render(items_list) {
		console.log('vdom todo...');
		if (true || _prev.length == 0) {
			let html = '';
			for (let obj of items_list) {
				html += obj.html
			}
			var div_items = document.getElementById('div_items');
	        div_items.innerHTML = html;
    	}
    	else {

    		//BROKEN FOR NOW
    		
    		//be more clever
    		//1 delete nodes no longer there
    		let removed = 0;
    		for (let _obj of _prev) {
    			let match = false;
    			for (let obj of items_list) {
    				if (_obj.html_hash == obj.html_hash) {
    					match = true;
    					break;
    				}
    			}
    			if (match == false) {
    				$('[data-item-id="'+_obj.item.id+'"]').remove();
    				console.log('removed ' + _obj.item.id + ' from DOM');
    				console.log(_obj.item.data);
    				removed++;
    			}
    		}
    		console.log('removed ' + removed);
    		
    		//insert new/updated nodes
    		let added = 0;
    		let new_elements = $();
    		for (let obj of items_list) {
    			let match = false;
    			for (let _obj of _prev) {
    				if (_obj.html_hash == obj.html_hash) {
    					match = true;
    					break;
    				}
    			}
    			if (match == false) {
    				//new_elements.add(obj.html);
    				$('#div_items').prepend(obj.html);
    				console.log('added ' + obj.item.id + ' to DOM');
    				console.log(obj.item.data);
    				added++;
    			}
    		}
    		console.log('added ' + added);

    		console.log(new_elements);
    		console.log('------------');

    		if (added > 0) {
    			//$('#div_items').prepend(new_elements);
    		}

    		$('.item').sort(function (a, b) {
				var contentA =parseInt( $(a).attr('data-priority'));
				var contentB =parseInt( $(b).attr('data-priority'));
				return (contentA < contentB) ? -1 : (contentA > contentB) ? 1 : 0;
			});
    		
    	}
    	
        _prev = items_list;
	}
	*/

	return {
		render: render
	}

})();