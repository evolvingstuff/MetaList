'use strict';

let $parseCsv = (function() {

	function getFormat(text) {
		console.log('CSV todo...');
		//TODO this does not handle escape sequences
		let result = '<table>';
		let lines = text.split('\n');
		let header = true;
		for (let line of lines) {
			let parts = line.split(',');
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