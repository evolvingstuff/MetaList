"use strict";

//TODO perhaps refactor this into a class

const $parseJson = (function() {

	function isJson(text) {
		if (text.trim().startsWith('{') === false ||
			text.trim().endsWith('}') === false) {
			return false;
		}
		try {
        	JSON.parse(text);
	    } catch (e) {
	        return false;
	    }
	    return true;
	}

	function getFormat(html) {

        let text = htmlToText(html);

		if (isJson(text) === false) {
			return '<span style="color:red; font-weight:bold;">Invalid JSON</span>';
		}

		let json = JSON.stringify(JSON.parse(text), null, 4);

		//https://stackoverflow.com/questions/4810841/how-can-i-pretty-print-json-using-javascript
		//http://jsfiddle.net/KJQ9K/554/
		json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	    json = json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
	        let cls = 'metalist-json-number';
	        if (/^"/.test(match)) {
	            if (/:$/.test(match)) {
	                cls = 'metalist-json-key';
	            } else {
	                cls = 'metalist-json-string';
	            }
	        } else if (/true|false/.test(match)) {
	            cls = 'metalist-json-boolean';
	        } else if (/null/.test(match)) {
	            cls = 'metalist-json-null';
	        }
	        return '<span class="' + cls + '">' + match + '</span>';
	    });
		return '<span class="copyable"><pre class="metalist-json">'+json+'</pre></span>'
	}

	return {
		getFormat: getFormat,
		isJson: isJson
	}

})();


//TODO perhaps refactor this into a class


