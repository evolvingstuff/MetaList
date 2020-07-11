"use strict";

let $backup_dlg = (function() {

    let modeEncryptSave = false;

	function open_dialog(after) {
		if ($protection.getModeProtected()) {
			protectedModeDlg(after);
		}
		else {
			unprotectedModeDlg(after);
		}
    };

    $(document).on('change', '#cb_encrypt', actionToggleEncryptSave);

	function actionToggleEncryptSave() {
        if($("#cb_encrypt").is(':checked')) {
            modeEncryptSave = true;
        }
        else {
        	//TODO: warn user of unprotected backup
            modeEncryptSave = false;
        }

        if (modeEncryptSave) {
            $('#inputs_pw').show();
        }
        else {
            $('#inputs_pw').hide();
        }
    }

    function unprotectedModeDlg(after) {
    	picoModal({
            content: 
                "<select id='sel_save_format'>" +
                "<option value='json'>JSON format</option>" +
                "<option value='text'>Plain text format</option>" +
                "</select>" +
                "<div style='width:300px;'><input id='cb_encrypt' type='checkbox' checked> Password Protected</div>" +
                "<div id='inputs_pw' style='margin-left: 25px;'>" +
                "<p>Enter your password to encrypt the result:</p>" +
                "<br>" + 
                "<p><input id='passphrase1' type='password'></input></p>" + 
                "<p><input id='passphrase2' type='password'></input></p>" + 
                "<div id='pwstrength' style='width:400px; height:80px;'>&nbsp;</div>" +
                "</div>" +
                "<div>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Save</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {

            actionToggleEncryptSave();

            $(document).on('keyup','#passphrase1', function(e) {
                let passphrase = $('#passphrase1').val();
                if (passphrase === '') {
                    $('#pwstrength').html('&nbsp;');
                    return;
                }
                let result = zxcvbn(passphrase);
                if (result.feedback.warning !== "" || result.feedback.suggestions.length > 0) {
                    let statements = [];
                    if (result.feedback.warning !== '') {
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

                    let format = $('#sel_save_format').val();

                    let passphrase1 = null;

                    if (modeEncryptSave) {

                        if (format === 'text') {
                            alert('Not able to encrypt a plain text format.');
                            return;
                        }

                        passphrase1 = $('#passphrase1').val();
                        let passphrase2 = $('#passphrase2').val();
                        if (passphrase1 !== passphrase2) {
                            alert('Passwords must match');
                            return;
                        }
                        if (passphrase1 === '') {
                            alert('Must enter a non-empty password');
                            return;
                        }
                    }

                    $persist.saveToFileSystem(format, modeEncryptSave, passphrase1);
                    modal.close();
                }
                else if (evt.target && evt.target.matches(".cancel")) {
                    modal.close();
                }
            });
        }).afterShow(modal => {
            $('#passphrase1').focus();
        }).afterClose((modal, event) => {
            modal.destroy();
            after();
        }).show();
    }

    function protectedModeDlg(after) {
    	picoModal({
            content: 
                "<select id='sel_save_format'>" +
                "<option value='json'>JSON format</option>" +
                "<option value='text'>Plain text format</option>" +
                "</select>" +
                "<div style='width:300px;'><input id='cb_encrypt' type='checkbox' checked> Password Protected</div>" +
                "<div>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Save</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {

            actionToggleEncryptSave();
            
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {

                    let format = $('#sel_save_format').val();

                    if (modeEncryptSave) {

                        if (format === 'text') {
                            alert('Not able to encrypt a plain text format.');
                            return;
                        }

                    }
                    let passphrase = $protection.getPassword();
                    $persist.saveToFileSystem(format, modeEncryptSave, passphrase);
                    modal.close();
                    
                }
                else if (evt.target && evt.target.matches(".cancel")) {
                    modal.close();
                }
            });
        }).afterShow(modal => {
            $('#passphrase1').focus();
        }).afterClose((modal, event) => {
            modal.destroy();
            after();
        }).show();
    }

    return {
    	open_dialog: open_dialog
    }
})();