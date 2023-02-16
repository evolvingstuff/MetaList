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

        let text = $unifiedText.htmlToText(html);

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

const $parseMarkdown = (function() {

	function getFormat(raw_html) {
		let text = $unifiedText.htmlToText(raw_html);
		let md = window.markdownit();
		let formatted_html = '';
		if (text.includes('\n')) {
			formatted_html = md.render(text);
		}
		else {
			formatted_html = md.renderInline(text);
		}
		return formatted_html;
	}

	return {
		getFormat: getFormat
	}

})();


//TODO perhaps refactor this into a class


const $unifiedText = (function() {

	// TODO 2023.01.18: can this be done by voca?
	//html-like -> text-like
	function escapeHtmlEntities(html) {
	    let escaped = v.escapeHtml(html);
	    return escaped;
	 }

	//TODO maybe rename htmlToTextToHtml()
	function removeHtmlFormatting(html) {
		let text = htmlToText(html);
		return textToHtml(text);
	}

	function textToHtml(text) {
		let textyHtml = text;
		textyHtml = textyHtml.replace(/&/g, '&amp;');
		textyHtml = textyHtml.replace(/'/g, '&apos;');
		textyHtml = textyHtml.replace(/"/g, '&quot;');
		textyHtml = textyHtml.replace(/</g, '&lt;');
		textyHtml = textyHtml.replace(/>/g, '&gt;');
		textyHtml = textyHtml.replace(/  /g, ' &nbsp;'); //allow for single spaces
		textyHtml = textyHtml.replace(/\n/g, '<br>');
		textyHtml = textyHtml.replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
		return textyHtml;
	}

	/////////////////////////////////////////////////////
	//html-like -> text-like
	//this converts divs and paragraphs to /n/n's
	//I think this could be rewritten MUCH better
	function htmlToText(html) {
		let element = document.createElement('div');
        let newLineChar = '\n';
        let newLinesChar = '\n\n';
        let str = html;
        //TODO 2023.01.18 not sure why I am retaining the HTML in here...
        str = str.replace(/<div/, newLineChar+'<div'); //only first
    	str = str.replace(/<\/div>/gmi, '<\/div>'+newLineChar);
    	str = str.replace(/<\/p>/gmi, '<\/p>'+newLinesChar);
    	str = str.replace(/<br.*?>/gmi, '<br>'+newLineChar);
    	str = str.replace(/<tr.*?>/gmi, '<tr>'+newLineChar);
    	str = str.replace(/<li.*?>/gmi, '<li>'+newLineChar);
    	str = str.replace(/<ol.*?>/gmi, '<ol>'+newLineChar);
    	str = str.replace(/<ul.*?>/gmi, '<ul>'+newLineChar);
    	str = str.replace(/<p.*?>/gmi, '<p>'+newLineChar);
    	str = str.replace(/&nbsp;/gmi, ' ');
    	str = str.replace(/<img[^>]*>/gmi, ' '); //[IMAGE]
		str = str.replace(/<script[^>]*>([\S\s]*?)<\/script>/gmi, '');
		str = str.replace(/<\/?\w(?:[^"'>]|"[^"]*"|'[^']*')*>/gmi, '');
		str = str.replace(/[\r\n\t]+$/, '');
		element.innerHTML = str;
		str = element.textContent;
		element.textContent = '';
		let text = v.stripTags(str);
		text = text.trim();
		while (text.includes('\n\n\n')) {
			text = text.replace('\n\n\n', '\n\n'); //TODO: regex here
		}
	    return text;
	}

	///////////////////////////////////////////////////////////////////////
	function sanitizeFilename(str) {
		//TODO 2023.01.19 unit test this
		let regex = /[\\\\/:*?\"<>|]/ig;
		let invalidCharRemoved = str.replaceAll(regex, "_");
		return invalidCharRemoved;
	}


	return {
	 	escapeHtmlEntities:escapeHtmlEntities,
	 	removeHtmlFormatting:removeHtmlFormatting,
	 	htmlToText:htmlToText,
	 	sanitizeFilename: sanitizeFilename
	 }

})();