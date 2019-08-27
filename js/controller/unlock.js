let $unlock = (function() {

	function prompt(items_bundle, after) {

        document.title = 'MetaList (locked)';

		$('.page-app').hide();
		$('.page-locked').show();
        $('#unlock-passphrase').focus();
		$('#ok-unlock').on('click', function(e) {

			let passphrase = $('#unlock-passphrase').val();

			if (passphrase == '') {
                alert('Must enter a non-empty password');
                return;
            }

            function success() {
                document.title = 'MetaList';
            	$('#div-spinner').hide();
                $('.page-app').show();
				$('.page-locked').hide();
                after(passphrase);
            }

            function failure() {
            	$('#div-spinner').hide();
            	alert('Incorrect password');
            }

            console.log('Attempting to unencrypt bundle using provided password...');
            
            $('#spn-spin-message').html('<h3>LOADING...</h3>');
            $('#div-spinner').show();
            $persist.unencryptItemsBundle(items_bundle, passphrase, success, failure);
		});
	}

	return {
		prompt: prompt
	}

})();