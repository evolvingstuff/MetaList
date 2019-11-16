"use strict";

let $parseMatrix = (function() {
	function getFormat(text) {
		let latex = '\\begin{bmatrix}\n';
		text = text.replace(/;/g, '\n');
		let lines = text.split('\n');
		for (let line of lines) {
			let parts = line.split(',');
			if (parts.length == 1 && parts[0].trim() == '') {
				continue;
			}
			let cells = [];
			for (let part of parts) {
				cells.push(part.trim());
			}
			latex += cells.join(' & ') + ' \\\\\n';
		}
		latex += '\\end{bmatrix}'
		let formatted_html = katex.renderToString(latex, {throwOnError: false});
		return formatted_html;
	}

	return {
		getFormat: getFormat
	}

})();