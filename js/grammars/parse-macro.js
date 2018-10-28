'use strict';

let $parseMacro = (function() {

	function getFormat(text) {

		//console.log('-----------------------------------------------------');
		//console.log('MACRO');
		text = $format.toEscaped(text);
		//console.log(text);

		let parts = text.split(/\:(.+)/);
		text = '<span class="badge badge-primary" style="background-color:green;">'+parts[0].trim()+'</span> <span style="font-family: monospace;">' + parts[1]+'</span>';

		//TODO: do this properly later!
		text = text.replace(/\$1/g, '<span class="macro-var">$1</span>');
		text = text.replace(/\$2/g, '<span class="macro-var">$2</span>');
		text = text.replace(/\$3/g, '<span class="macro-var">$3</span>');
		text = text.replace(/\$4/g, '<span class="macro-var">$4</span>');
		text = text.replace(/\$5/g, '<span class="macro-var">$5</span>');
		text = text.replace(/\$6/g, '<span class="macro-var">$6</span>');
		text = text.replace(/\$7/g, '<span class="macro-var">$7</span>');
		text = text.replace(/\$8/g, '<span class="macro-var">$8</span>');
		text = text.replace(/\$9/g, '<span class="macro-var">$9</span>');
		text = text.replace(/\$1o/g, '<span class="macro-var">$10</span>');

		//console.log(text);

		return text;
	}

	return {
		getFormat: getFormat
	}
})();