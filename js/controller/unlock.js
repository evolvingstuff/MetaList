"use strict";

let $unlock = (function() {

    let modeIsLocked = false;

    function isLocked() {
        return modeIsLocked;
    }

	function prompt(items_bundle, after) {

        modeIsLocked = true;

        document.title = 'MetaList (locked)';

		$('.page-app').hide();
		$('.page-locked').show();
        window.scrollTo(0, 0);
        $('#unlock-passphrase').focus();
		$('#ok-unlock').on('click', function(e) {

			let passphrase = $('#unlock-passphrase').val();

			if (passphrase === '') {
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
            $persist.decryptItemsBundle(items_bundle, passphrase, success, failure);
		});
	}

    function exitLock() {
        document.title = 'MetaList';
        $view.hideSpinner();
        $('.page-app').show();
        $('.page-locked').hide();
        modeIsLocked = false;
    }

	return {
		prompt: prompt,
        exitLock: exitLock,
        isLocked: isLocked
	}

})();