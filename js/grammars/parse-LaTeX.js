"use strict";

let $parseLaTeX = (function() {

	function getFormat(raw_html) {
		if (raw_html.includes('$')) {
			//TODO: handle inline formulas with $$ $$
			let sections = [];
			let parts = raw_html.split('$');
			let latex_mode = false;
			for (let i = 0; i < parts.length; i++) {
				let section = {
					'content': parts[i],
					'latex_mode': latex_mode
				};
				if (latex_mode == true) {
					let text = $format.toText(parts[i]);
					section.content = katex.renderToString(text, {throwOnError: false})
					latex_mode = false;
				}
				else {
					latex_mode = true;
				}
				sections.push(section);
			}
			let result = '';
			for (let section of sections) {
				result += section.content;
			}
			return result;
		}
		else {
			let text = $format.toText(raw_html);
			return katex.renderToString(text, {throwOnError: false});
		}
	}

	return {
		getFormat: getFormat
	}

})();