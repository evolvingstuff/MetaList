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
            	$('#div-spinner').hide();
                $('.page-app').show();
				$('.page-locked').hide();
                isLocked = false;
                after(passphrase, unencryptedBundle);
            }

            function failure() {
            	$('#div-spinner').hide();
            	alert('Incorrect password');
                $('#unlock-passphrase').val('');
            }

            console.log('Attempting to unencrypt bundle using provided password...');
            
            $('#spn-spin-message').html('<h3>LOADING...</h3>');
            $('#div-spinner').show();
            $persist.unencryptItemsBundle(items_bundle, passphrase, success, failure);
		});
	}

	return {
		prompt: prompt,
        getIsLocked: getIsLocked
	}

})();