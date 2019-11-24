"use strict";

let $tests = (function() {

	let tests = [
		{
			"test-name": "@markdown test 1",
			"test": function() {
				let raw_text = 'This should not be formatted.';
	   			let formatted_html = $parseMarkdown.getFormat(raw_text);
	   			console.log(raw_text + " vs " + formatted_html);
				if (formatted_html != raw_text) {
					throw $format.toEscaped(raw_text) + " != " + $format.toEscaped(formatted_html);
				}
			}
		},
		{
			"test-name": "@markdown test 2",
			"test": function() {
				let raw_text = 'This _**should**_ be formatted.';
				let formatted_html = $parseMarkdown.getFormat(raw_text);
	   			console.log(raw_text + " vs " + formatted_html);
				if (formatted_html == raw_text) {
					throw $format.toEscaped(raw_text) + " == " + $format.toEscaped(formatted_html);
				}
			}
		}
	];

	function init() {
		let html = '';
		for (let test of tests) {
			try {
				console.log('-----------------------------------');
				console.log('Running test ' + test['test-name']);
				test['test']();
				html += "<div class='tests tests-passed'><span class='glyphicon glyphicon-ok'></span> "+test["test-name"]+" passed.</div>\n";
			}
			catch (e) {
				html += "<div class='tests tests-failed'><span class='glyphicon glyphicon-remove'></span> "+test["test-name"]+" failed. Error: "+e+"</div>\n";
			}
			$('#tests').html(html);
		}
		$('#tests').html(html);
	}

	return {
		init: init
	};

})();