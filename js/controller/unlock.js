"use strict";

let $unlock = (function() {

    let isLocked = false;

    function getIsLocked() {
        return isLocked;
    }

	function prompt(items_bundle, after) {
        console.log('$unlock.prompt()');

        isLocked = true;

        document.title = 'MetaList (locked)';

		$('.page-app').hide();
		$('.page-locked').show();
        window.scrollTo(0, 0);
        $('#unlock-passphrase').focus();
		$('#ok-unlock').on('click', function(e) {

            console.log('on click');

			let passphrase = $('#unlock-passphrase').val();

			if (passphrase == '') {
                alert('Must enter a non-empty password');
                return;
            }

            function success(passphrase, decryptedBundle) {
                exitLock();
                $protection.setPassword(passphrase);
                after(decryptedBundle);
            }

            function failure() {
            	$view.hideSpinner();
            	alert('Incorrect password');
                $('#unlock-passphrase').val('');
                $('#unlock-passphrase').focus();
            }
            
            $view.setSpinnerContentLoading();
            $view.showSpinner();
            console.log('DEBUG: unlock.decryptItemsBundle()');
            $persist.decryptItemsBundle(items_bundle, passphrase, success, failure);
		});
	}

    function exitLock() {
        document.title = 'MetaList';
        $view.hideSpinner();
        $('.page-app').show();
        $('.page-locked').hide();
        isLocked = false;
    }

	return {
		prompt: prompt,
        exitLock: exitLock,
        getIsLocked: getIsLocked
	}

})();