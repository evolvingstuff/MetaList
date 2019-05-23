let $cli_response = (function() {
    function open_dialog(text, callback) {
        //TODO: factor this into a textToHTML() function...
        text = escapeHtml(text);
        text = text.replace(/\n/g, '<br>');
        text = text.replace(/ /g, '&nbsp;');
        picoModal({
            content: 
                "<p style='font-weight:bold; margin:10px;'>EXEC response</p>" +
                "<div style='margin:10px;'><code class='metalist-code copyable' style='min-width:500px;'>"+text+"</code></div>",
            closeButton: true
        }).afterCreate(modal => {

        }).afterShow(modal => {
            
        }).afterClose((modal, event) => {
            modal.destroy();
            callback();
        }).show();
	}

	return {
		open_dialog: open_dialog
	}
})();