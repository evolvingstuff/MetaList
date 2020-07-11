"use strict";

let CLIPBOARD_ESCAPE_SEQUENCE = '{{CLIPBOARD}}';

let $format = (function() {

	let DATE_WIDGET_SEPARATOR = '<br>&nbsp;&nbsp;'; //'&nbsp;&nbsp;&nbsp;';

	function parse(raw_html, tags, item, subitem, subitemIndex) {
		try {

			let enriched_tags = $ontology.getEnrichedTags(tags);

			let hasChildren = $model.subitemHasChildren(item, subitem, subitemIndex);

			if (enriched_tags.includes(META_IMPLIES)) {
				let text = toText(raw_html);
				raw_html = $parseMetaTagging.getFormat(text);
				return raw_html;
			}

			let addedClasses = [];
			let addedStyles = [];

			//TODO: this is broken if a large section of text starts with a link
			if ((raw_html.trim().startsWith('https://') || raw_html.trim().startsWith('http://')) && raw_html.trim().split(' ').length === 1) {
				let formatted_html = '<a href="'+raw_html.trim()+'" target="_blank">'+raw_html.trim()+'</a>';
				raw_html = formatted_html;
			}

			enriched_tags.reverse(); //This is so tags will show up in an intuitive order

			let alreadyRenderedProgress = false;

			//First, handle meta tags with attributes
			if (subitem._attribute_tags !== undefined) {
				for (let tag of subitem._attribute_tags) {

					let lhs = tag.split('=')[0];
					let rhs = tag.split('=')[1];

					if (lhs === META_CODE) {
						let lang = rhs;
						let text = toText(raw_html);
						let formatted_html = '<span class="copyable"><pre><code class="language-'+lang+'">'+text+'</code></pre></span>';
						raw_html = formatted_html;
						continue;
					}

					if (lhs === META_COLOR) {
						addedStyles.push('color:'+rhs+';');
						continue
					}

					if (lhs === META_BACKGROUND_COLOR) {
						addedStyles.push('background-color:'+rhs+';');
						continue
					}

					if (lhs === META_FONT) {
						addedStyles.push('font-family:'+rhs+';');
						continue
					}

					if (lhs === META_PROGRESS && alreadyRenderedProgress === false) {
						raw_html = raw_html + $parse_progress.getFormat(rhs, false);
						alreadyRenderedProgress = true;
						continue;
					}

					if (lhs === META_PROGRESS_ACTIVE && alreadyRenderedProgress === false) {
						raw_html = raw_html + $parse_progress.getFormat(rhs, true);
						alreadyRenderedProgress = true;
						continue;
					}

				}
			}

			//second, handle general text formatting tags
			//TODO: (should give general priorities)
			for (let tag of enriched_tags) {

				if (tag.startsWith(META_PREFIX) === false) {
					continue;
				}

				if (tag === META_MATRIX) {
					let text = toText(raw_html);
					raw_html = $parseMatrix.getFormat(text);
					continue;
				}

				if (tag === META_CSV) {
					let text = toText(raw_html);
					raw_html = $parseCsv.getFormat(text);
					continue;
				}

				if (tag === META_JSON) {
					let text = toText(raw_html);
					raw_html = $parseJson.getFormat(text);
					continue;
				}

				if (tag === META_PRIVATE) {
					addedStyles.push('filter: blur(5px);');
					continue;
				}

				if (tag === META_HIDE) {
					addedClasses.push('hide-me');
					continue;
				}

				if (tag === META_COPYABLE) {
					addedClasses.push('copyable');
					continue;
				}

				if (tag === META_HTML) {
					//TODO this seems incorrect?
					let text = toText(raw_html);
					let unescaped = unescapeHtml(raw_html);
					raw_html = unescaped;
					continue;
				}

				if (tag === META_LATEX) {
					//TODO: always order LaTeX before markdown
					//raw_html = $format.convertToTextyHTML(raw_html);
					raw_html = $parseLaTeX.getFormat(raw_html);
					continue;
				}

				if (tag === META_MARKDOWN) {
					//raw_html = $format.convertToTextyHTML(raw_html);
					raw_html = $parseMarkdown.getFormat(raw_html);
					continue;
				}

				if (tag === META_UML) {
					let canvasId = item.id+'_'+subitemIndex;
					let text = toText(raw_html);

					text += '\n';
					text += '#edges: rounded\n'; //rounded | hard
					text += '#padding: 5\n'; //8
					text += '#spacing: 20\n'; //30
					text += '#bendSize: 1.5\n'; //0.3
					text += '#fontSize: 11\n'; //10
					text += '#fillArrows: true\n'; //false
					text += '#zoom: 0.75\n'; //1
					text += '#ranker: network-simplex\n'; //network-simplex | tight-tree | longest-path
					text += '#direction: right\n'; //right | down
					text += '#fill: #ffffff; #ffffff\n';
					text += '#lineWidth: 1\n';

					$effects.addNomnomlDrawing(canvasId, text);
					raw_html = '<canvas id="'+canvasId+'" class="nomnoml-canvas"></canvas>';
					continue;
				}

				if (tag === META_QR) {
					let divId = item.id+'_'+subitemIndex;
					let text = toText(raw_html);
					$effects.addQRCode(divId, text);
					raw_html = '<div id="'+divId+'"></div>';
					continue;
				}

				if (tag === META_BOLD) {
					addedStyles.push('font-weight:bold;');
					continue;
				}

				if (tag === META_ITALIC) {
					addedStyles.push('font-style:italic;');
					continue;
				}

				if (tag === META_STRIKETHROUGH) {
					addedStyles.push('text-decoration:line-through;');
					continue;
				}

				if (tag === META_H1) {
					addedStyles.push('font-size: 2em;');
					addedStyles.push('margin-top: 0.67em;');
					addedStyles.push('margin-bottom: 0.67em;');
					continue;
				}

				if (tag === META_H2) {
					addedStyles.push('font-size: 1.5em;');
					addedStyles.push('margin-top: 0.83em;');
					addedStyles.push('margin-bottom: 0.83em;');
					continue;
				}

				if (tag === META_H3) {
					addedStyles.push('font-size: 1.17em;');
					addedStyles.push('margin-top: 1em;');
					addedStyles.push('margin-bottom: 1em;');
					continue;
				}

				if (tag === META_H4) {
					addedStyles.push('font-size: 1em;');
					addedStyles.push('margin-top: 1.33;');
					addedStyles.push('margin-bottom: 1.33;');
					continue;
				}

				if (tag === META_HEADING) {
					//taken from H2
					addedStyles.push('font-size: 1.5em;');
					addedStyles.push('margin-top: 0.83em;');
					addedStyles.push('margin-bottom: 0.83em;');
					continue;
				}

				if (tag === META_RED) {
					addedStyles.push('color:red;');
					continue;
				}

				if (tag === META_BLUE) {
					addedStyles.push('color:blue;');
					continue;
				}

				if (tag === META_GREEN) {
					addedStyles.push('color:green;');
					continue;
				}

				if (tag === META_GREY) {
					addedStyles.push('color:grey;');
					continue;
				}

				if (tag === META_TEXT_ONLY) {
					raw_html = stripFormatting(raw_html);
					continue;
				}
			}

			//third, handle tags adding graphical stuff
			for (let tag of enriched_tags) {

				if (tag.startsWith(META_PREFIX) === false) {
					continue;
				}

				//TODO: this is very hacky
				if (tag === META_PROGRESS && alreadyRenderedProgress === false) {
					raw_html = $parse_progress.getFormat(raw_html, false);
					alreadyRenderedProgress = true;
					continue;
				}

				//TODO: this is very hacky
				if (tag === META_PROGRESS_ACTIVE && alreadyRenderedProgress === false) {
					raw_html = $parse_progress.getFormat(raw_html, true);
					alreadyRenderedProgress = true;
					continue;
				}

				if (tag === META_DATE_HEADLINE) {
					let formatted_date = formatDateAndDOW(item);
					let date_widget = '<span class="date-widget">'+formatted_date+'</span>';
					
					if (raw_html !== '') {
						raw_html = date_widget + DATE_WIDGET_SEPARATOR + raw_html;
					}
					else {
						raw_html = date_widget;
					}
					continue;
				}

				if (tag === META_PASSWORD) {
					raw_html = $format.convertToTextyHTML(raw_html);
					let formatted_html = '<span style="font-family:courier new;"><i class="glyphicon glyphicon-lock"></i> Password:</span> <div class="copyable" title="Click to copy password to clipboard" style="filter: blur(5px);">'+raw_html+'</div>';
					raw_html = formatted_html;
					continue;
				}

				if (tag === META_USERNAME) {
					raw_html = $format.convertToTextyHTML(raw_html);
					let formatted_html = '<span style="font-family:courier new;"><i class="glyphicon glyphicon-user"></i> Username:</span> <div class="copyable" title="Click to copy username to clipboard" >'+raw_html+'</div>';
					raw_html = formatted_html;
					continue;
				}

				if (tag === META_EMAIL) {
					raw_html = $format.convertToTextyHTML(raw_html);
					let formatted_html = '<span style="font-family:courier new;"><i class="glyphicon glyphicon-envelope"></i> Email:</span> <a href="mailto:'+raw_html+'">'+raw_html+'</a>';
					raw_html = formatted_html;
					continue;
				}

				//@done takes precedence over @todo
				//TODO: figure out fancier way to handle this
				if (tag === META_DONE) {
					let formatted_html = '<span class="action-uncheck"><i class="glyphicon glyphicon-check"></i></span>&nbsp;'+raw_html;
					raw_html = formatted_html;
					continue;
				}

				if (tag === META_TODO) {
					let formatted_html = '<span class="action-check"><i class="glyphicon glyphicon-unchecked"></i></span>&nbsp;'+raw_html;
					raw_html = formatted_html;
					continue;
				}

				if (tag === META_GOTO) {
					let formatted_html = '<i class="glyphicon glyphicon-link"></i>&nbsp;<span class="action-goto-search">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag === META_THUMBS_UP) {
					let formatted_html = '<i class="glyphicon glyphicon-thumbs-up"></i>&nbsp;'+raw_html;
					raw_html = formatted_html;
					continue;
				}

				if (tag === META_THUMBS_DOWN) {
					let formatted_html = '<i class="glyphicon glyphicon-thumbs-down"></i>&nbsp;'+raw_html;
					raw_html = formatted_html;
					continue;
				}

				if (tag === META_EMBED) {
					let parts = raw_html.split(META_ID+'=');
					//TODO: this is ugly as hell
					if (parts.length === 2) {
						try {
							let id = parseInt(parts[1]);
							let embedded_item = $model.getItemById(id);

							let formatted_html = '<div class="embedded-subitem">';
							formatted_html += $view.renderEmbeddedItem(embedded_item, subitem.indent);
							formatted_html += '<div class="embedded-backlink"><i class="glyphicon glyphicon-link"></i>&nbsp;<span class="action-goto-search">'+raw_html+'</span></div>';
							
							formatted_html += '</div>';
							raw_html = formatted_html;
						}
						catch (e) {
							raw_html = '<span style="color:red;">ERROR PARSING EMBEDDED LINK</span>';
						}
					}
					else {
						raw_html = '<span style="color:red;">ERROR PARSING EMBEDDED LINK</span>';
					}
					continue;
				}

				if (tag === META_BROKEN_SEARCH) {
					let formatted_html = '<span style="color:red;"><i class="glyphicon glyphicon-remove"></i>&nbsp;'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag === META_MONOSPACE) {
					let formatted_html = '<span class="copyable"><code class="metalist-monospace">'+raw_html+'</code></span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag === META_MONOSPACE_DARK) {
					let formatted_html = '<span class="copyable"><code class="metalist-monospace-dark">'+raw_html+'</code></span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag === META_SHELL) {
					raw_html = raw_html.replace(CLIPBOARD_ESCAPE_SEQUENCE, '<span class="exec-escaped">'+CLIPBOARD_ESCAPE_SEQUENCE+'</span>');
					let formatted_html = '<span class="shell"><code class="metalist-code-shell">'+raw_html+'</code></span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag === META_FILE) {
					raw_html = $format.convertToTextyHTML(raw_html);
					let formatted_html = '<i class="glyphicon glyphicon-file"></i> <span class="open-file">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}
			}

			//look for parent context for lists (bulleted, numbered)
			let parent = null;
			let prior_peers = 0;
			for (let i = 0; i < subitemIndex; i++) {
				if (item.subitems[i].indent === subitem.indent-1) {
					parent = item.subitems[i];
					prior_peers = 0;
					for (let j = i+1; j < subitemIndex; j++) {
						if (item.subitems[j].indent === subitem.indent) {
							prior_peers += 1;
						}
					}
				}
			}
			if (parent !== null) {
				if (parent._direct_tags.includes(META_LIST_NUMBERED)) {
					raw_html = '<span class="font-weight:bold;">'+(prior_peers+1)+')</span>&nbsp;'+raw_html;
				}
				else if (parent._direct_tags.includes(META_LIST_BULLETED)) {
					raw_html = '&#x25cf;&nbsp;&nbsp;'+raw_html;
				}
			}

			//TODO handles addedClasses and addedStyles
			if (addedClasses.length > 0 || addedStyles.length > 0) {

				let classes = '';
				let styles = '';

				if (addedClasses.length > 0) {
					let innerClasses = addedClasses.join(' ');
					classes = `class="${innerClasses}"`;
				}

				if (addedStyles.length > 0) {
					let innerStyles = addedStyles.join(' ');
					styles = `style="${innerStyles}"`;
				}
				let updated = `<span ${classes} ${styles}>${raw_html}</span>`;

				raw_html = updated;
			}

			return raw_html;

		}
		catch (e) {
			return '<span style="color:red; font-weight:bold;">Error while applying text formatting</span>';
		}
	}

	function convertToTextyHTML(data) {
		let text = v.stripTags(decodeHTMLEntities(data, 0));
		let squashedText = text.trim();
		while (squashedText.includes('\n\n\n')) {
			squashedText = squashedText.replace('\n\n\n', '\n\n'); //TODO: regex here
		}
		let textyHtml = plainTextToHTML(squashedText);
		return textyHtml;
	}

	function stripFormatting(raw_html) {
		let lines = v.stripTags(raw_html, ['br', 'p', 'div']);
		let tags = [
			'\<div.*?\>','\<\/div\>',
			'\<hr.*?\>',
			'\<br.*?\>',
			'\<img.*?\>','\<\/img\>'];
		for (let i = 1; i <= 6; i++) {
			tags.push('\<h'+i+'.*?\>', '\<\/h'+i+'\>');
		}
		for (let tag of tags) {
			let re = new RegExp(tag, 'g');
			lines = lines.replace(re, '<<>>');
		}

		let tags2 = ['\<span.*?\>','\<\/span\>'];
		for (let tag of tags2) {
			let re = new RegExp(tag, 'g');
			lines = lines.replace(re, ' ');
		}

		lines = lines.split('<<>>');
		let new_lines = [];
		for (let line of lines) {
			if (line.trim() !== '') {
				new_lines.push(textOnly(line));
			}
		}
		let formatted_html = new_lines.join('<br>');
		return formatted_html;
	}

	function toText(raw_html) {
		let text = raw_html;
		text = text.replace(/&amp;/g,'&');
		text = text.replace(/&apos;/g,"'");
		text = text.replace(/&quot;/g,'"');
		text = text.replace(/<div><br><\/div>/g,'\n'); 
		text = text.replace(/<br>/g,'\n');
		text = text.replace(/<br.*?>/g,'\n');
		text = text.replace(/<br \/>/g,'\n'); 
		text = text.replace(/<div.*?>/g,'\n'); //TODO: different in Firefox?
		text = text.replace(/<\/div>/g,'');
		text = text.replace(/<span.*?>/g,'');
		text = text.replace(/<\/span>/g,'');
		text = text.replace(/<pre.*?>/g,'');
		text = text.replace(/<\/pre>/g,'');
		text = text.replace(/<code.*?>/g,'');
		text = text.replace(/<\/code>/g,'');
		text = text.replace(/<time.*?>/g,'');
		text = text.replace(/<\/time>/g,'');
		text = text.replace(/<button.*?>/g,'');
		text = text.replace(/<\/button>/g,'');
		text = text.replace(/<img.*?>/g,'');
		text = text.replace(/<\/img>/g,'');
		text = text.replace(/<ul.*?>/g,'');
		text = text.replace(/<\/ul>/g,'');
		text = text.replace(/<li.*?>/g,'');
		text = text.replace(/<\/li>/g,'');
		text = text.replace(/<form.*?>/g,'');
		text = text.replace(/<\/form>/g,'');
		text = text.replace(/<p.*?>/g,'');
		text = text.replace(/<\/p>/g,'\n');
		text = text.replace(/&nbsp;/g,' ');
		text = text.replace(/&lt;/g,'<');
		text = text.replace(/&gt;/g,'>');

		text = text.replace(/<h1.*?>/g,'');
		text = text.replace(/<\/h1>/g,'\n');
		text = text.replace(/<h2.*?>/g,'');
		text = text.replace(/<\/h2>/g,'\n');
		text = text.replace(/<h3.*?>/g,'');
		text = text.replace(/<\/h3>/g,'\n');
		text = text.replace(/<h4.*?>/g,'');
		text = text.replace(/<\/h4>/g,'\n');

		text = text.replace(/<a.*?>/g,'');
		text = text.replace(/<\/a>/g,'\n');

		if (text.startsWith('\n')) {
			text = text.replace('\n','');
		}
		return text;
	}

	function toTextWithoutPreservedNewlines(raw_html) {
		let text = raw_html;
		text = text.replace(/<div>/g,'<div>\n'); 
		text = text.replace(/<br>/g,'<br>\n'); 
		text = text.replace(/<br \/>/g,'\n'); 
		text = text.replace(/<div.*?>/g,'\n'); //TODO: different in Firefox?
		text = text.replace(/<\/div>/g,'');
		text = text.replace(/<span.*?>/g,'');
		text = text.replace(/<\/span>/g,'');
		text = text.replace(/<pre.*?>/g,'');
		text = text.replace(/<\/pre>/g,'');
		text = text.replace(/<code.*?>/g,'');
		text = text.replace(/<\/code>/g,'');
		text = text.replace(/<p.*?>/g,'');
		text = text.replace(/<\/p>/g,'\n');
		text = text.replace(/&nbsp;/g,' ');
		text = text.replace(/&lt;/g,'<');
		text = text.replace(/&gt;/g,'>');

		text = text.replace(/<h1.*?>/g,'');
		text = text.replace(/<\/h1>/g,'\n');
		text = text.replace(/<h2.*?>/g,'');
		text = text.replace(/<\/h2>/g,'\n');
		text = text.replace(/<h3.*?>/g,'');
		text = text.replace(/<\/h3>/g,'\n');
		text = text.replace(/<h4.*?>/g,'');
		text = text.replace(/<\/h4>/g,'\n');

		text = text.replace(/<a.*?>/g,'');
		text = text.replace(/<\/a>/g,'\n');

		//Normalize newlines
		while (text.includes('\n\n')) {
			text = text.replace('\n\n', '\n');
		}
		while (text.startsWith('\n')) {
			text = text.replace('\n','');
		}
		while (text.endsWith('\n')) {
			text = text.slice(0, -1);
		}
		return text;
	}

	function toEscaped(text) {
		text = text.replace(/&/g, '&amp;');
		text = text.replace(/'/g, '&apos;');
		text = text.replace(/"/g, '&quot;');
		text = text.replace(/</g, '&lt;');
		text = text.replace(/>/g, '&gt;');
		text = text.replace(/  /g, ' &nbsp;'); //allow for single spaces
		return text;
	}

	function plainTextToHTML(text) {
		text = toEscaped(text);
		text = text.replace(/\n/g, '<br>');
		return text;
	}

	function textOnly(html) {

		let parsed = html;
		try {
			let text = $(html).text();
			if (text !== null && text !== '') {
				parsed = text;
			}
		}
		catch (e) {

		}
		return parsed;
	}

	//https://stackoverflow.com/questions/5796718/html-entity-decode
	function decodeHTMLEntities(str, indentTabs) {
		let element = document.createElement('div');
		let indent = '';
        for (let i = 0; i < indentTabs; i++) {
            indent += '\t'
        }
        let newLineChar = '\n' + indent;
        let newLinesChar = '\n\n' + indent;
        str = indent + str;
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
	    return str;
	}

	function splitIntoSubsections(data) {
		console.log('SPLIT INTO SUBSECTIONS');
		console.log('-------------------------------');
		console.log(data);
		console.log('-------------------------------');

		let updated = convertToTextyHTML(data);  //TODO: for now HTML isn't great

		// if (data.includes('<table')) {
		// 	console.log('Cannot handle splitting up tables');
		// 	let result = [];
		// 	result.push(data);
		// 	return result;
		// }

		const token = '^!^'; //TODO

		//let pre = updated.split('<div>')[0];

		updated = updated.replace(/<br>/gmi, token);
		updated = updated.replace(/<hr>/gmi, token);
		updated = updated.replace(/<\/div>/gmi, '</div>'+token);
		updated = updated.replace(/<\/p>/gmi, '</p>'+token);
		updated = updated.replace(/<\/h1>/gmi, '</h1>'+token);
		updated = updated.replace(/<\/h2>/gmi, '</h2>'+token);
		updated = updated.replace(/<\/h3>/gmi, '</h3>'+token);
		updated = updated.replace(/<\/h4>/gmi, '</h4>'+token);
		updated = updated.replace(/<\/h5>/gmi, '</h5>'+token);
		updated = updated.replace(/<\/h6>/gmi, '</h6>'+token);

		let parts = updated.split(token);
		
		/*
		if (pre !== '') {
			console.log('front loaded TODO');
			parts[0] = parts[0].replace(pre, '');
			parts.unshift(pre);
		}
		*/

		parts = parts.filter(x => x !== '<div>' && x !== '</div>' && x !== '');

		console.log(parts);

		console.log('-------------------------------');
		return parts;
	}

	function cleanHtmlNoise(text) {

		//TODO: this appears a little buggy for now.

		/*
		const tab = '&nbsp; &nbsp; ';
        text = text.replace(/(<.+?)(class=".*?")(.*?>)/gmi, '$1$3');
        text = text.replace(/(<.+?)(data-.+?=".*?")(.*?>)/gmi, '$1$3');
        text = text.replace(/<span style="white-space:pre">.*?<\/span>/gmi, tab);
        return text;
        */

        return text;
	}

	return {
		parse : parse,
		toText: toText,
		toEscaped: toEscaped,
		textOnly: textOnly,
		toTextWithoutPreservedNewlines: toTextWithoutPreservedNewlines, //TODO: these last two functions are named too similarly
		plainTextToHTML: plainTextToHTML,
		stripFormatting: stripFormatting,
		decodeHTMLEntities: decodeHTMLEntities,
		convertToTextyHTML: convertToTextyHTML,
		splitIntoSubsections: splitIntoSubsections,
		cleanHtmlNoise: cleanHtmlNoise
	}

})();