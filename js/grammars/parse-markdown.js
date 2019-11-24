"use strict";

let $parseMarkdown = (function() {

	function getFormat(raw_html) {
		let text = $format.toText(raw_html);
		var md = window.markdownit();
		let formatted_html = '';
		if (text.includes('\n')) {
			formatted_html = md.render(text);
		}
		else {
			formatted_html = md.renderInline(text);
		}
		return formatted_html;
	}

	return {
		getFormat: getFormat
	}

})();