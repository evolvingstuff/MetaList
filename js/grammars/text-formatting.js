let $format = (function() {

	function parse(raw_html, tags) {

		let enriched_tags = $ontology.getEnrichedTags(tags);

		if (enriched_tags.includes('@meta')) {
			let text = toText(raw_html);
			return $parseMetaTagging.getFormat(text);
		}

		if (enriched_tags.includes('@markdown')) {
			let text = toText(raw_html);
			let formatted_html = markdown.toHTML(text);
			return formatted_html;
		}

		if (enriched_tags.includes('@code')) {
			let formatted_html = '<code>'+raw_html+'</code>';
			return formatted_html;
		}

		if (enriched_tags.includes('@private')) {
			let formatted_html = '<div style="filter: blur(5px);">'+raw_html+'</div>';
			return formatted_html;
		}

		return raw_html;
	}

	function toText(raw_html) {
		let text = raw_html;
		text = text.replace(/<br>/g,'\n'); 
		text = text.replace(/<div.*?>/g,'\n'); //TODO: different in Firefox?
		text = text.replace(/<\/div>/g,'');
		text = text.replace(/<span.*?>/g,'');
		text = text.replace(/<\/span>/g,'');
		text = text.replace(/<pre.*?>/g,'');
		text = text.replace(/<\/pre>/g,'');
		text = text.replace(/<code.*?>/g,'');
		text = text.replace(/<\/code>/g,'');
		text = text.replace(/&nbsp;/g,' ');
		text = text.replace(/&lt;/g,'<');
		text = text.replace(/&gt;/g,'>');
		if (text.startsWith('\n')) {
			text = text.replace('\n','');
		}
		return text;
	}

	return {
		parse : parse,
		toText: toText
	}

})();