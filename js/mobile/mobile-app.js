"use strict";

let $mobile_app = (function() {
	
	function init() {
		load();
	}

	function getSortedItems(items) {
        if (items.length == 0) {
            return [];
        }
        let mapByPrev = {};
        for (let item of items) {
            mapByPrev[item.prev] = item;
        }
        let result = [];
        let prevId = null;
        let prevItem = null;
        while (true) {
            if (mapByPrev[prevId] == undefined) {
                break;
            }
            prevItem = mapByPrev[prevId];
            result.push(prevItem);
            prevId = prevItem.id;
        }
        return result;
    }

	function render(unencryptedBundle) {
		html = '';
		let sortedItems = getSortedItems(unencryptedBundle.data);
		//$model.setItems(unencryptedBundle.data);
		//let sortedItems = $model.getSortedItems();
		for (let item of sortedItems) {
			html += '<div class="item" style="margin:10px;">'
			for (let subitem of item.subitems) {
				let indent = 30 * subitem.indent;
				html += '<div style="margin-left:'+indent+'px;">'+subitem.data+'</div>';
			}
			html += '</div>'
		}
		$('#items').html(html);
	}

	function load() {
		
		$.ajax({
            url: '/items',
            type: 'get',
            contentType: 'application/json',
            success: function(rawItemsBundle) {

            	function afterMaybeDecrypt(unencryptedBundle) {
            		render(unencryptedBundle);
            	}

                if (rawItemsBundle.encryption.encrypted == true) {

                	function success(passphrase, unencryptedBundle) {
                		afterMaybeDecrypt(unencryptedBundle);
                	}

                	function failure() {
                		alert('Incorrect password');
                		attempt();
                	}

                	function attempt() {
                		let password = prompt('Enter password', 'password');
                		$persist.unencryptItemsBundle(rawItemsBundle, password, success, failure);
                	}

                	attempt();
                }
                else {
                	afterMaybeDecrypt(rawItemsBundle)
                }
            },
            fail: function(xhr, textStatus, errorThrown){
                alert('fail');
            },
            error: function(request, status, error) {
                alert('fail');
            }
        });
	}

	return {
		init: init
	};

})();
$mobile_app.init();