"use strict";

//TODO split these out into separate files?

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
                        $view.setSearchText(updated_search);
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

    function replaceText(after) {
        picoModal({
            content: 
                "<p>Replace text:</p>" +
                "<div style='margin-left: 50px;'>" +
                "<p><input id='text1'></input></p>" + 
                "<p><input id='text2'></input></p>" + 
                "</div>" +
                "<div style='margin-left:50px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Replace Text</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    let text1 = $('#text1').val();
                    let text2 = $('#text2').val();
                    if (text1 == '') {
                        alert('Search text must be non-empty');
                        return;
                    }
                    let updated = $model.replaceText(text1, text2);
                    if (updated) {
                        let current_search = $auto_complete.getSearchString();
                        let updated_search = current_search.replace(text1, text2);
                        if (current_search != updated_search) {
                            $view.setSearchText(updated_search);
                            $todo.actionEditSearch();
                        }
                        modal.close();
                    }
                }
                else if (evt.target && evt.target.matches(".cancel")) {
                    modal.close();
                }
            });
        }).afterShow(modal => {
            $('#text1').focus();
        }).afterClose((modal, event) => {
            modal.destroy();
            after();
        }).show();
    }


    function deleteTag(after) {
        picoModal({
            content: 
                "<p>Remove tag:</p>" +
                "<div style='margin-left: 50px;'>" +
                "<p><input id='tagname'></input></p>" + 
                "</div>" +
                "<div style='margin-left:50px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Delete Tag</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    let tag = $('#tagname').val();
                    if (tag == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    $model.deleteTag(tag);
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


    function addMetaRule(after) {
        picoModal({
            content: 
                "<div style='margin-left: 15px;'>" +
                "<p>" +
                "<table>" +
                "<tr><th id='th_lhs' style='text-align:center'>specific tag</th>" + 
                "<th style='text-align:center'>" + 
                "<select id='sel_relation' data-show-icon='true'>" +
                "<option value='gt'>implies</option>" +
                "<option value='eq'>is equal to</option>" +
                "</select> " +
                "</th>" + 
                "<th id='th_rhs' style='text-align:center'>general tag</th></tr>" +
                "<tr>" +
                "<td>" +
                "<input id='tagname_lhs' size='15'></input> " + 
                "</td>" +
                "<td id='td_relation' style='text-align:center;'>" +
                "<small><span class='glyphicon glyphicon-arrow-right'></span></small>" +
                "</td>" +
                "<td>" + 
                "<input id='tagname_rhs' size='15'></input>" +
                "</td>"+
                "<tr>" +
                "</table>"+
                "</p>" +
                "</div>" +
                "<div style='margin-left:15px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Add @implies rule</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            $('body').on('change', '#sel_relation', function(e) {
                let relation = $(e.target).val();
                if (relation == 'eq') {
                    $('#th_lhs').html('tag');
                    $('#th_rhs').html('tag');
                    $('#td_relation').html("<span style='font-weight:bold;'>=</span>");
                }
                else if (relation == 'gt') {
                    $('#th_lhs').html('specific tag');
                    $('#th_rhs').html('general tag');
                    $('#td_relation').html("<small><span class='glyphicon glyphicon-arrow-right'></span></small>");
                }
                else {
                    alert('ERROR: unknown relation');
                }
            })

            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    
                    let tagsLhs = $('#tagname_lhs').val().trim();
                    if (tagsLhs == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    for (let tagLhs of tagsLhs.split(' ')) {
                        if ($model.isValidTag(tagLhs) == false) {
                            alert('Left hand side tag "'+tagLhs+'" was invalid'); //TODO: this is crude feedback
                            return;
                        }
                    }

                    let tagsRhs = $('#tagname_rhs').val().trim();
                    if (tagsRhs == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    for (let tagRhs of tagsRhs.split(' ')) {
                        if ($model.isValidTag(tagRhs) == false) {
                            alert('Right hand side tag "'+tagRhs+'" was invalid'); //TODO: this is crude feedback
                            return;
                        }
                    }

                    let relation = '';
                    if ($('#sel_relation').val() == 'gt') {
                        relation = '=>';
                    }
                    else if ($('#sel_relation').val() == 'eq') {
                        relation = '=';
                    }
                    else {
                        alert('ERROR: unknown logical relationship "'+relation+'"');
                        return;
                    }

                    //Add tags from search context
                    let tags = ''
                    let validSearchTags = $todo.getValidSearchTags();
                    if (validSearchTags.length > 0) {
                        if (validSearchTags.includes(META_IMPLIES) == false) {
                            tags = META_IMPLIES + ' ' + validSearchTags.join(' ');
                        }
                        else {
                            tags = validSearchTags.join(' ');
                        }
                    }
                    else {
                        tags = META_IMPLIES;
                    }
                    let newMetaItem = $model.addItemFromSearchBar(tags);
                    let text = tagsLhs + ' ' + relation + ' ' + tagsRhs;
                    $model.updateSubitemData(newMetaItem, newMetaItem.id+':0', text);
                    $model.recalculateAllTags();
                    let recalculated = $ontology.maybeRecalculateOntology();
                    if (recalculated) {
                        $todo.resetAllCache();
                    }
                    modal.close();
                }
                else if (evt.target && evt.target.matches(".cancel")) {
                    modal.close();
                }
            });
        }).afterShow(modal => {
            $('#tagname_lhs').focus();
        }).afterClose((modal, event) => {
            modal.destroy();
            after();
        }).show();
    }


    function addTagToCurrentView(after) {
        picoModal({
            content: 
                "<p>Add tag to all items in current view:</p>" +
                "<div style='margin-left: 50px;'>" +
                "<p><input id='tagname'></input></p>" + 
                "</div>" +
                "<div style='margin-left:50px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Add Tag</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    let tag = $('#tagname').val();
                    if (tag == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    //TODO: check for valid tag name
                    $model.addTagToCurrentView(tag);
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


    function removeTagFromCurrentView(after) {
        picoModal({
            content: 
                "<p>Remove tag from all items in current view:</p>" +
                "<div style='margin-left: 50px;'>" +
                "<p><input id='tagname'></input></p>" + 
                "</div>" +
                "<div style='margin-left:50px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Remove Tag</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    let tag = $('#tagname').val();
                    if (tag == '') {
                        alert('Must enter a non-empty tag name');
                        return;
                    }
                    $model.removeTagFromCurrentView(tag);
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


    function deleteEverything(after) {

        picoModal({
            content: 
                "<p style='font-weight:bold; color:red;'>Are you SURE you want to delete EVERYTHING??</p>" +
                "<div style='margin-left:50px;'>" +
                "<button class='cancel'>Cancel</button> " +
                "<button class='ok'>Yes, delete it all</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            modeModal = true;
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                	$todo.deleteEverything();
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


    function restoreFromFile(obj, after) {
        picoModal({
        content: 
            "<p>Enter password:</p>" +
            "<div style='margin-left: 10px;'>" +
            "<p><input id='reload_passphrase' type='password'></input></p>" + 
            "</div>" +
            "<div' style='margin-left:10px;'>" +
            "<button class='cancel'>Cancel</button> " +
            "<button class='ok'>Ok</button>" +
            "</div>",
        closeButton: false
        }).afterCreate(modal => {
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    let passphrase = $('#reload_passphrase').val();
                    if (passphrase == '') {
                        alert('Must enter a non-empty password');
                        return;
                    }

                    $view.showSpinner();

                    //TODO: handle failure here
                    $persist.decryptFromFileObject(passphrase, obj, 
                        function success(loaded_items) {
                            try {
                                let newItems = $schema.checkSchemaUpdate(loaded_items, obj.data_schema_version);
                                $model.setItems(newItems);
                                $persist.setItemsCache(newItems);
                                $protection.setPassword(passphrase);
                                let start = Date.now();
                                $persist.saveToHostFull(
                                    function saveSuccess() {
                                        $todo.successfulInit();
                                        $unlock.exitLock();
                                        modal.close();
                                    }, 
                                    function saveFail() {
                                        alert('Failed saving file');
                                        debugger;
                                    });
                            }
                            catch (e) {
                                $view.hideSpinner();
                                alert(e);
                            }
                        },
                        function failure() {
                            $view.hideSpinner();
                            alert('Incorrect password.');
                            modal.close();
                        });
                }
                else if (evt.target && evt.target.matches(".cancel")) {
                    modal.close();
                }
            });
        }).afterClose((modal, event) => {
            modal.destroy();
            after();
        }).show();
    }


	return {
		renameTag: renameTag,
        replaceText: replaceText,
		deleteTag: deleteTag,
		addMetaRule: addMetaRule,
		addTagToCurrentView: addTagToCurrentView,
		removeTagFromCurrentView: removeTagFromCurrentView,
		deleteEverything: deleteEverything,
		restoreFromFile: restoreFromFile
	}
})();