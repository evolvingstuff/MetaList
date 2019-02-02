'use strict';

let $parseCsv = (function() {

	function getFormat(text) {
		//TODO this does not handle escape sequences
		let result = '<table>';
		let lines = text.split('\n');
		let header = true;
		for (let line of lines) {
			let parts = line.split(',');
			if (parts.length == 1 && parts[0].trim() == '') {
				continue;
			}
			let cells = [];
			let html = '';
			for (let part of parts) {
				let cell = part.trim();
				if (header) {
					html += '<th>'+cell+'</th>';
				}
				else {
					html += '<td>'+cell+'</td>';
				}
			}
			result += '<tr>'+html+'</tr>';
			header = false;
		}
		return '<table class="csv">'+result+'</table>';
	}

	return {
		getFormat: getFormat
	}

})();