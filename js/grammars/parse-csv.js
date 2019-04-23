'use strict';

let $parseCsv = (function() {

	function isCsv(text) {
		let lines = text.split('\n');
		if (lines.length < 2) {
			return false;
		}
		let line_index = 0;
		let columns = 0;
		for (let line of lines) {
			let parts = line.split(',');
			if (parts.length < 2) {
				return false;
			}
			if (line_index == 0) {
				columns = parts.length;
			}
			else {
				if (parts.length != columns) {
					return false;
				}
			}
		}
		return true;
	}

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
					if (cell == '') {
						html += '<td class="empty-td">'+cell+'</td>';
					}
					else {
						html += '<td>'+cell+'</td>';
					}
					
				}
			}
			result += '<tr>'+html+'</tr>';
			header = false;
		}
		return '<table class="csv">'+result+'</table>';
	}

	return {
		getFormat: getFormat,
		isCsv: isCsv
	}

})();