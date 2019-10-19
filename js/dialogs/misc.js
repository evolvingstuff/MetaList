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
                "<button class='ok'>Add @meta rule</button>" +
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
                    let tags = '@meta';
                    let validSearchTags = $todo.getValidSearchTags();
                    if (validSearchTags. length > 0) {
                        tags += ' ' + validSearchTags.join(' ');
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


	return {
		renameTag: renameTag,
		deleteTag: deleteTag,
		addMetaRule: addMetaRule
	}
})();