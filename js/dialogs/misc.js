let $dlg = (function () {

	function renameTag(after) {
        picoModal({
            content: 
                "<p>Rename tag:</p>" +
                "<div style='margin-left: 50px;'>" +
                "<p><input id='tagname1'></input></p>" + 
                "<p><input id='tagname2'></input></p>" + 
                "</div>" +
                "<div style='margin-left:50px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Rename Tag</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    let tag1 = $('#tagname1').val();
                    let tag2 = $('#tagname2').val();
                    if (tag1 == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    if (tag2 == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    //TODO: check for valid tag name
                    $model.renameTag(tag1, tag2);
                    
                    let current_search = $auto_complete.getSearchString();
                    let updated_search = current_search.replace(tag1, tag2);
                    if (current_search != updated_search) {
                        $('.action-edit-search')[0].value = updated_search;
                        $todo.actionEditSearch();
                    }
                    modal.close();
                }
                else if (evt.target && evt.target.matches(".cancel")) {
                    modal.close();
                }
            });
        }).afterShow(modal => {
            $('#tagname1').focus();
        }).afterClose((modal, event) => {
            modal.destroy();
            after();
        }).show();
    }

	return {
		renameTag: renameTag
	}
})();