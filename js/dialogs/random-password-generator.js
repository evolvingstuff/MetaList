"use strict";

let $random_password_generator_dlg = (function() {

	let DEFAULT_LENGTH = 16;

	let DEFAULT_VALID_CHARACTERS = 'abcdefghijklmnopqrstuvwxyz\n';
	DEFAULT_VALID_CHARACTERS += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\n';
	DEFAULT_VALID_CHARACTERS += '0123456789\n';
	DEFAULT_VALID_CHARACTERS += '@%+\\/\'!#$^?:.(){}[]~';

	function open_dialog(callback) {
		picoModal({
            content: 
                "<p style='font-weight:bold; margin:10px;'>Random Password Generator Utility</p>" +
                "<div style='margin:10px;'>" +
                "<p>Password Length: <input type='number' id='quantity' min='8' max='256' value='"+DEFAULT_LENGTH+"'></p>" +
                "<p>Valid Character Set:</p>" +
                "<p><textarea style='font-family: monospace;' spellcheck='false' rows='4' cols='35' id='valid_characters'>"+DEFAULT_VALID_CHARACTERS+"</textarea></p>" + 
                "<p>Result:</p>" +
                "<p><textarea style='font-family: monospace;' spellcheck='false' rows='2' cols='35' id='result'></textarea></p>" + 
                "<button id='generate'>Generate</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {

        	$('#generate').on('click', function(e) {
                let tot = parseInt($('#quantity').val());
                let valid = $('#valid_characters').val().replace(/\n/g,'').replace(/ /g,'');
                let array = new Uint32Array(tot);
				window.crypto.getRandomValues(array);
				let result = '';
				for (let i = 0; i < tot; i++) {
					result += valid.charAt(array[i]%valid.length);
				}
                $('#result').val(result);
            });
            
        }).afterShow(modal => {
            
        }).afterClose((modal, event) => {
        	callback();
            modal.destroy();
        }).show();
	}

	return {
		open_dialog: open_dialog
	}
})();