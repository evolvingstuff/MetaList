let $cli_response = (function() {
    function open_dialog(text, callback) {
        text = text.replace(/\n/g,'<br>');
        //TODO: more clean up of results
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