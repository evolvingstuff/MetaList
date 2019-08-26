let $unlock = (function() {

	function open_dialog(items_bundle, after) {
		picoModal({
            content: 
                "<p>Enter passphrase:</p>" +
                "<div style='margin-left: 50px;'>" +
                "<p><input id='unlock_passphrase' type='password'></input></p>" + 
                "</div>" +
                "<div' style='margin-left:50px;'>" +
                "<button class='ok'>Ok</button>" +
                "</div>",
            closeButton: false
            }).afterCreate(modal => {
                modal.modalElem().addEventListener("click", evt => {
                    if (evt.target && evt.target.matches(".ok")) {
                        let passphrase = $('#unlock_passphrase').val();
                        if (passphrase == '') {
                            alert('Must enter a non-empty passphrase');
                            return;
                        }
                        
                        function success() {
	                        modal.close();
	                        after(passphrase);
                        }

                        function failure() {
                        	alert('Incorrect passphrase');
                        }
                        
                        $persist.unencryptItemsBundle(items_bundle, passphrase, success, failure);
                    }
                });
            }).afterClose((modal, event) => {
                modal.destroy();
            }).show();
	}

	return {
		open_dialog: open_dialog
	}

})();