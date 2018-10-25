let $format = (function() {

	function parse(raw_html, tags, item, subitem) {

		let enriched_tags = $ontology.getEnrichedTags(tags);

		if (enriched_tags.includes('@meta')) {
			let text = toText(raw_html);
			return $parseMetaTagging.getFormat(text);
		}

		//TODO: handle overlaps better
		//TODO: handle propagation to children

		if (enriched_tags.includes('@date')) {
			let formatted_date = formatDateAndDOW(item);
			if (raw_html != '') {
				return formatted_date + '<br>' + raw_html;
			}
			else {
				return formatted_date;
			}
		}

		if (enriched_tags.includes('@csv')) {
			let text = toText(raw_html);
			return $parseCsv.getFormat(text);
		}

		if (enriched_tags.includes('@password')) {
			let formatted_html = '<span style="font-family:courier new;"><i class="glyphicon glyphicon-share"></i> Password:</span> <div class="copyable" title="Click to copy password to clipboard" style="filter: blur(5px);">'+raw_html+'</div>';
			return formatted_html;
		}

		if (enriched_tags.includes('@username')) {
			let formatted_html = '<span style="font-family:courier new;"><i class="glyphicon glyphicon-share"></i> Username:</span> <div class="copyable" title="Click to copy username to clipboard" >'+raw_html+'</div>';
			return formatted_html;
		}

		if (enriched_tags.includes('@email')) {
			let formatted_html = '<span style="font-family:courier new;"><i class="glyphicon glyphicon-share"></i> Email:</span> <div class="copyable" title="Click to copy email to clipboard" >'+raw_html+'</div>';
			return formatted_html;
		}

		if (enriched_tags.includes('@private')) {
			let formatted_html = '<div style="filter: blur(5px);">'+raw_html+'</div>';
			return formatted_html;
		}

		if (enriched_tags.includes('@hide')) {
			let formatted_html = '<div class="hide-me">'+raw_html+'</div>';
			return formatted_html;
		}

		if (enriched_tags.includes('@copy')) {
			let formatted_html = '<div class="copyable"><i class="glyphicon glyphicon-share"></i> '+raw_html+'</div>';
			return formatted_html;
		}

		//@done takes precedence over @todo
		//TODO: figure out fancier way to handle this
		if (enriched_tags.includes('@done')) {
			let formatted_html = '<div><i class="glyphicon glyphicon-check action-uncheck"></i>&nbsp;'+raw_html+'</div>';
			return formatted_html;
		}

		if (enriched_tags.includes('@todo')) {
			let formatted_html = '<div><i class="glyphicon glyphicon-unchecked action-check"></i>&nbsp;'+raw_html+'</div>';
			return formatted_html;
		}

		if (enriched_tags.includes('@goto-search')) {
			let formatted_html = '<i class="glyphicon glyphicon-link"></i>&nbsp;<span class="action-goto-search">'+raw_html+'</span>';
			return formatted_html;
		}

		//TODO: children should not inherit!
		if (enriched_tags.includes('@bug')) {
			let formatted_html = '<div><i class="glyphicon glyphicon-exclamation-sign"></i>&nbsp;'+raw_html+'</div>';
			return formatted_html;
		}

		if (enriched_tags.includes('@code')) {
			let formatted_html = '<div class="copyable"><code>'+raw_html+'</code></div>';
			return formatted_html;
		}

		if (enriched_tags.includes('@markdown')) {
			let text = toText(raw_html);
			showdown.setFlavor('github');
			let converter = new showdown.Converter();
    		let formatted_html = converter.makeHtml(text);
			return formatted_html;
		}

		if (enriched_tags.includes('@LaTeX')) {
			let text = toText(raw_html);
			let formatted_html = katex.renderToString(text, {
			    throwOnError: false
			});
			return formatted_html;
		}

		if (enriched_tags.includes('@html')) {
			let text = toText(raw_html);
			return text;
		}

		if (enriched_tags.includes('@href')) {
			let text = toText(raw_html);
			let href = '<a href="'+text+'" target="_blank">'+text+'</a>';
			return href;
		}

		if (enriched_tags.includes('@bold')) {
			let formatted_html = '<div style="font-weight:bold;">'+raw_html+'</div>';
			return formatted_html;
		}


		if (enriched_tags.includes('@h1')) {
			let formatted_html = '<h1>'+raw_html+'</h1>';
			return formatted_html;
		}

		if (enriched_tags.includes('@h2')) {
			let formatted_html = '<h2>'+raw_html+'</h2>';
			return formatted_html;
		}

		if (enriched_tags.includes('@h3')) {
			let formatted_html = '<h3>'+raw_html+'</h3>';
			return formatted_html;
		}

		if (enriched_tags.includes('@h4')) {
			let formatted_html = '<h4>'+raw_html+'</h4>';
			return formatted_html;
		}

		if (enriched_tags.includes('@red')) {
			let formatted_html = '<div style="color:red;">'+raw_html+'</div>';
			return formatted_html;
		}

		if (enriched_tags.includes('@blue')) {
			let formatted_html = '<div style="color:blue;">'+raw_html+'</div>';
			return formatted_html;
		}

		if (enriched_tags.includes('@green')) {
			let formatted_html = '<div style="color:green;">'+raw_html+'</div>';
			return formatted_html;
		}

		if (enriched_tags.includes('@grey')) {
			let formatted_html = '<div style="color:grey;">'+raw_html+'</div>';
			return formatted_html;
		}

		return raw_html;
	}

	function toText(raw_html) {
		let text = raw_html;
		text = text.replace(/&amp;/g,'&');
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