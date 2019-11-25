"use strict";

let $parseCsv = (function() {

	function isCsv(text) {
		try {
			let lines = CSV.parse(text);
			if (lines.length <= 1) {
				return false;
			}
			if (lines[0].length <= 1) {
				return false;
			}
			for (let i = 1; i < lines.length; i++) {
				if (lines[i].length != lines[0].length) {
					return false;
				}
			}
			return true;
		}
		catch (e) {
			return false;
		}
	}

	function getFormat(text) {
		let lines = CSV.parse(text);
		let result = '<table class="csv">';
		let header = true;
		for (let line of lines) {
			let cells = [];
			let html = '';
			for (let cell of line) {
				if (header) {
					if (cell == '' || cell == null) {
						html += '<th class="empty-td csv">&nbsp;</th>';
					}
					else {
						html += '<th class="csv">'+String(cell)+'</th>';
					}
				}
				else {
					if (cell == '' || cell == null) {
						html += '<td class="empty-td csv">&nbsp;</td>';
					}
					else {
						html += '<td class="csv">'+String(cell)+'</td>';
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