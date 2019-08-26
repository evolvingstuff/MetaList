let $unlock = (function() {

	function prompt(items_bundle, after) {

        document.title = 'MetaList (locked)';

		$('.page-app').hide();
		$('.page-locked').show();
		$('#ok-unlock').on('click', function(e) {

			let passphrase = $('#unlock-passphrase').val();

			if (passphrase == '') {
                alert('Must enter a non-empty passphrase');
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
                debugger;
            	$('#div-spinner').hide();
            	alert('Incorrect passphrase');
            }

            console.log('Attempting to unencrypt bundle using provided passphrase...');
            
            $('#div-spinner').show();

            $persist.unencryptItemsBundle(items_bundle, passphrase, success, failure);
		});
	}

	return {
		prompt: prompt
	}

})();