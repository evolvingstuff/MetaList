let $parse_progress = (function() {

	function getFormat(rhs, is_active) {
		let percent = 100;
		if (rhs.endsWith('%')) {
			if (v.isDigit(rhs.replace('%','')) == false) {
				throw rhs + " should be a number to left of %";
			}
			percent = parseInt(rhs.replace('%',''));
		}
		else if (rhs.includes('/')) {
			let parts = rhs.split('/');
			if (parts.length != 2) {
				throw "Expected x/y format";
			}
			if (v.isDigit(parts[0]) == false) {
				throw parts[0] + " is not a digit";
			}
			if (v.isDigit(parts[1]) == false) {
				throw parts[1] + " is not a digit";
			}
			percent = parseInt((parseFloat(parts[0]) / parseFloat(parts[1])) * 100);
		}
		else {
			if (v.isNumeric(rhs) == false) {
				throw rhs + " is not numeric";
			}
			if (v.isDigit(rhs)) {
				percent = parseInt(rhs);
			}
			else {
				percent = parseInt(parseFloat(rhs) * 100);
			}
		}
		if (percent < 0) {
			throw "Percent < 0";
		}
		if (percent > 100) {
			throw "Percent > 100";
		}
		let active = is_active ? 'progress-bar-striped active' : '';
		let formatted_html = '';
		formatted_html += '<div class="progress">';
		formatted_html += '<div class="progress-bar '+active+'" role="progressbar" aria-valuenow="'+percent+'"';
		formatted_html += 'aria-valuemin="0" aria-valuemax="100" style="width:'+percent+'%">';
		formatted_html += percent + '%';
		formatted_html += '</div>';
		formatted_html += '</div>';
		return formatted_html;
	}

	return {
		getFormat: getFormat
	};

})();