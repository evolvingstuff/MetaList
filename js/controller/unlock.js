"use strict";

let $unlock = (function() {

    let isLocked = false;

    function getIsLocked() {
        return isLocked;
    }

	function prompt(items_bundle, after) {

        isLocked = true;

        document.title = 'MetaList (locked)';

		$('.page-app').hide();
		$('.page-locked').show();
        window.scrollTo(0, 0);
        $('#unlock-passphrase').focus();
		$('#ok-unlock').on('click', function(e) {

			let passphrase = $('#unlock-passphrase').val();

			if (passphrase == '') {
                alert('Must enter a non-empty password');
                return;
            }

            function success(passphrase, unencryptedBundle) {
                document.title = 'MetaList';
            	$view.hideSpinner();
                $('.page-app').show();
				$('.page-locked').hide();
                isLocked = false;
                after(passphrase, unencryptedBundle);
            }

            function failure() {
            	$view.hideSpinner();
            	alert('Incorrect password');
                $('#unlock-passphrase').val('');
            }

            console.log('Attempting to unencrypt bundle using provided password...');
            
            $view.setSpinnerContent('<h3>LOADING...</h3>');
            $view.showSpinner();
            $persist.unencryptItemsBundle(items_bundle, passphrase, success, failure);
		});
	}

	return {
		prompt: prompt,
        getIsLocked: getIsLocked
	}

})();