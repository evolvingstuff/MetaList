"use strict";

let $password_protection_dlg = (function() {

	function open_dialog(callback) {

		if ($protection.getModeProtected()) {
			picoModal({
	            content: 
	                "<p style='font-weight:bold; margin:10px;'>Update Password Protection</p>" +
	                "<div style='margin:10px;'>" +
	                "<p>Current password:</p>" +
	                "<p><input id='passphrase_old' type='password'></input></p>" + 
	                "<br>" + 
	                "<p>New password:</p>" +
	                "<p><input id='passphrase1' type='password'></input></p>" + 
	                "<p><input id='passphrase2' type='password'></input></p>" + 
	                "<div id='pwstrength' style='width:400px; height:80px;'>&nbsp;</div>" +
	                "</div>" +
	                "<button class='ok'>Okay</button>" +
	                "</div>",
	            closeButton: false
	        }).afterCreate(modal => {

	        	$(document).on('keyup','#passphrase1', function(e) {
	                let passphrase = $('#passphrase1').val();
	                if (passphrase == '') {
	                    $('#pwstrength').html('&nbsp;');
	                    return;
	                }
	                let result = zxcvbn(passphrase);
	                if (result.feedback.warning != "" || result.feedback.suggestions.length > 0) {
	                    let statements = [];
	                    if (result.feedback.warning != '') {
	                        statements.push('<span style="color:red;font-weight:bold;">'+result.feedback.warning+'</span>');
	                    }
	                    for (let suggestion of result.feedback.suggestions) {
	                        statements.push('<span style="color:red">'+suggestion+'</span>');
	                    }
	                    $('#pwstrength').html(statements.join('<br>'));
	                }
	                else {
	                    $('#pwstrength').html('<br><span class="glyphicon glyphicon-ok" style="color:green;"></span> Strong password');
	                }
	            });
	            
	            modal.modalElem().addEventListener("click", evt => {
	                if (evt.target && evt.target.matches(".ok")) {

	                	let passphrase_old = $('#passphrase_old').val();
	                	if ($protection.getPassword() != passphrase_old) {
	                		alert('Incorrect current password');
	                		$('#passphrase_old').val('');
	                		return;
	                	}

	                	let passphrase1 = $('#passphrase1').val();
                        let passphrase2 = $('#passphrase2').val();
                        if (passphrase1 != passphrase2) {
                            alert('Passphrases must match');
                            return;
                        }
                        if (passphrase1 == '') {
                            if (!confirm('Are you sure you want to remove password protection?')) {
                            	return;
                            }
                        }

	                	callback(passphrase1);

	                    modal.close();
	                }
	            });
	        }).afterShow(modal => {
	            
	        }).afterClose((modal, event) => {
	            modal.destroy();
	        }).show();
		}
		else {
			picoModal({
	            content: 
	                "<p style='font-weight:bold; margin:10px;'>Enable Password Protection</p>" +
	                "<div style='margin:10px;'>" +
	                "<p>Enter new password:</p>" +
	                "<p><input id='passphrase1' type='password'></input></p>" + 
	                "<p><input id='passphrase2' type='password'></input></p>" + 
	                "<div id='pwstrength' style='width:400px; height:80px;'>&nbsp;</div>" +
	                "</div>" +
	                "<button class='ok'>Okay</button>" +
	                "</div>",
	            closeButton: false
	        }).afterCreate(modal => {

	        	$(document).on('keyup','#passphrase1', function(e) {
	                let passphrase = $('#passphrase1').val();
	                if (passphrase == '') {
	                    $('#pwstrength').html('&nbsp;');
	                    return;
	                }
	                let result = zxcvbn(passphrase);
	                if (result.feedback.warning != "" || result.feedback.suggestions.length > 0) {
	                    let statements = [];
	                    if (result.feedback.warning != '') {
	                        statements.push('<span style="color:red;font-weight:bold;">'+result.feedback.warning+'</span>');
	                    }
	                    for (let suggestion of result.feedback.suggestions) {
	                        statements.push('<span style="color:red">'+suggestion+'</span>');
	                    }
	                    $('#pwstrength').html(statements.join('<br>'));
	                }
	                else {
	                    $('#pwstrength').html('<br><span class="glyphicon glyphicon-ok" style="color:green;"></span> Strong password');
	                }
	            });
	            
	            modal.modalElem().addEventListener("click", evt => {
	                if (evt.target && evt.target.matches(".ok")) {

	                	let passphrase1 = $('#passphrase1').val();
                        let passphrase2 = $('#passphrase2').val();
                        if (passphrase1 != passphrase2) {
                            alert('Passphrases must match');
                            return;
                        }
                        if (passphrase1 == '') {
                            alert('Must enter a non-empty passphrase');
                            return;
                        }

	                	callback(passphrase1);

	                    modal.close();
	                }
	            });
	        }).afterShow(modal => {
	            
	        }).afterClose((modal, event) => {
	            modal.destroy();
	        }).show();
		}

        
	}

	return {
		open_dialog: open_dialog
	}
})();