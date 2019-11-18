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

			//TODO: this is broken if a large section of text starts with a link
			if ((raw_html.trim().startsWith('https://') || raw_html.trim().startsWith('http://')) && raw_html.trim().split(' ').length == 1) {
				let formatted_html = '<a href="'+raw_html.trim()+'" target="_blank">'+raw_html.trim()+'</a>';
				raw_html = formatted_html;
			}

			enriched_tags.reverse(); //This is so tags will show up in an intuitive order

			if (subitem._attribute_tags != undefined) {
				for (let tag of subitem._attribute_tags) {

					let lhs = tag.split('=')[0];
					let rhs = tag.split('=')[1];

					if (lhs == META_CODE) {
						let lang = rhs;
						let text = toText(raw_html);
						console.log('DEBUG META CODE TEXT');
						console.log(raw_html);
						console.log(text);
						let formatted_html = '<span class="copyable"><pre><code class="language-'+lang+'">'+text+'</code></pre></span>';
						raw_html = formatted_html;
						continue;
					}

					if (lhs == META_COLOR) {
						let formatted_html = '<span style="color:'+rhs+';">'+raw_html+'</span>';
						raw_html = formatted_html;
						continue
					}

					if (lhs == META_BACKGROUND_COLOR) {
						let formatted_html = '<span style="background-color:'+rhs+';">'+raw_html+'</span>';
						raw_html = formatted_html;
						continue
					}

					if (lhs == META_FONT) {
						let formatted_html = '<span style="font-family:'+rhs+';">'+raw_html+'</span>';
						raw_html = formatted_html;
						continue
					}

				}
			}

			for (let tag of enriched_tags) {

				if (tag.startsWith(META_PREFIX) == false) {
					continue;
				}

				if (tag == META_DATE_HEADLINE) {
					let formatted_date = formatDateAndDOW(item);
					let date_widget = '<span class="date-widget">'+formatted_date+'</span>';
					
					if (raw_html != '') {
						raw_html = date_widget + DATE_WIDGET_SEPARATOR + raw_html;
					}
					else {
						raw_html = date_widget;
					}
					continue;
				}

				if (tag == META_MATRIX) {
					let text = toText(raw_html);
					raw_html = $parseMatrix.getFormat(text);
					continue;
				}

				if (tag == META_CSV) {
					let text = toText(raw_html);
					raw_html = $parseCsv.getFormat(text);
					continue;
				}

				if (tag == META_JSON) {
					let text = toText(raw_html);
					raw_html = $parseJson.getFormat(text);
					continue;
				}

				if (tag == META_PASSWORD) {
					let formatted_html = '<span style="font-family:courier new;"><i class="glyphicon glyphicon-lock"></i> Password:</span> <div class="copyable" title="Click to copy password to clipboard" style="filter: blur(5px);">'+raw_html+'</div>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_USERNAME) {
					let formatted_html = '<span style="font-family:courier new;"><i class="glyphicon glyphicon-user"></i> Username:</span> <div class="copyable" title="Click to copy username to clipboard" >'+raw_html+'</div>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_EMAIL) {
					let formatted_html = '<span style="font-family:courier new;"><i class="glyphicon glyphicon-envelope"></i> Email:</span> <a href="mailto:'+raw_html+'">'+raw_html+'</a>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_PRIVATE) {
					let formatted_html = '<div style="filter: blur(5px);">'+raw_html+'</div>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_HIDE) {
					let formatted_html = '<span class="hide-me">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_COPYABLE) {
					let formatted_html = '<span class="copyable">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_HTML) {
					let text = toText(raw_html);
					raw_html = text;
					continue;
				}

				//@done takes precedence over @todo
				//TODO: figure out fancier way to handle this
				if (tag == META_DONE) {
					let formatted_html = '<span class="action-uncheck"><i class="glyphicon glyphicon-check"></i></span>&nbsp;'+raw_html;
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_TODO) {
					let formatted_html = '<span class="action-check"><i class="glyphicon glyphicon-unchecked"></i></span>&nbsp;'+raw_html;
					raw_html = formatted_html;
					continue;
				}

				if (subitemIndex > 0 && hasChildren) {

					//Ignore @folded/@unfolded for header subitem

					//@unfolded takes precedence over @folded
					//TODO: figure out fancier way to handle this
					if (tag == META_FOLDED) {
						let formatted_html = '<span><i class="glyphicon glyphicon-triangle-right action-unfold"></i>&nbsp;'+raw_html+'</span>';
						raw_html = formatted_html;
						continue;
					}

					if (tag == META_UNFOLDED) {
						let formatted_html = '<span><i class="glyphicon glyphicon-triangle-bottom action-fold"></i>&nbsp;'+raw_html+'</span>';
						raw_html = formatted_html;
						continue;
					}
				}

				if (tag == META_GOTO) {
					let formatted_html = '<i class="glyphicon glyphicon-link"></i>&nbsp;<span class="action-goto-search">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_EMBED) {
					let parts = raw_html.split(META_ID+'=');
					//TODO: this is ugly as hell
					if (parts.length == 2) {
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

				if (tag == META_BROKEN_SEARCH) {
					let formatted_html = '<span style="color:red;"><i class="glyphicon glyphicon-remove"></i>&nbsp;'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_MONOSPACE) {
					let formatted_html = '<span class="copyable"><code class="metalist-monospace">'+raw_html+'</code></span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_MONOSPACE_DARK) {
					let formatted_html = '<span class="copyable"><code class="metalist-monospace-dark">'+raw_html+'</code></span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_SHELL) {
					raw_html = raw_html.replace(CLIPBOARD_ESCAPE_SEQUENCE, '<span class="exec-escaped">'+CLIPBOARD_ESCAPE_SEQUENCE+'</span>');
					let formatted_html = '<span class="shell"><code class="metalist-code-shell">'+raw_html+'</code></span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_MARKDOWN) {
					let text = toText(raw_html);
					// showdown.setFlavor('github');
					// let converter = new showdown.Converter();
		   			// let formatted_html = converter.makeHtml(text);
		   			var md = window.markdownit();
		   			let formatted_html = md.render(text);
		   			console.log('DEBUG markdown:');
		   			console.log('\t' + raw_html);
		   			console.log('\t' + text);
		   			console.log('\t' + formatted_html);
					//let formatted_html = md.renderInline(text);
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_LATEX) {
					let text = toText(raw_html);
					let formatted_html = katex.renderToString(text, {throwOnError: false});
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_UML) {
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

				if (tag == META_QR) {
					let divId = item.id+'_'+subitemIndex;
					let text = toText(raw_html);
					$effects.addQRCode(divId, text);
					raw_html = '<div id="'+divId+'"></div>';
					continue;
				}

				if (tag == META_BOLD) {
					let formatted_html = '<span style="font-weight:bold;">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_ITALIC) {
					let formatted_html = '<span style="font-style:italic;">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_STRIKETHROUGH) {
					let formatted_html = '<span style="text-decoration:line-through;">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_H1) {
					let formatted_html = '<h1>'+raw_html+'</h1>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_H2) {
					let formatted_html = '<h2>'+raw_html+'</h2>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_H3) {
					let formatted_html = '<h3>'+raw_html+'</h3>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_H4) {
					let formatted_html = '<h4>'+raw_html+'</h4>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_HEADING) {
					let formatted_html = '<h4>'+raw_html+'</h4>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_RED) {
					let formatted_html = '<span style="color:red;">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_BLUE) {
					let formatted_html = '<span style="color:blue;">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_GREEN) {
					let formatted_html = '<span style="color:green;">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_GREY) {
					let formatted_html = '<span style="color:grey;">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == META_TEXT_ONLY) {
					console.log(META_TEXT_ONLY);
					raw_html = stripFormatting(raw_html);
					console.log(raw_html);
					continue;
				}
			}

			//look for parent context
			let parent = null;
			let prior_peers = 0;
			for (let i = 0; i < subitemIndex; i++) {
				if (item.subitems[i].indent == subitem.indent-1) {
					parent = item.subitems[i];
					prior_peers = 0;
					for (let j = i+1; j < subitemIndex; j++) {
						if (item.subitems[j].indent == subitem.indent) {
							prior_peers += 1;
						}
					}
				}
			}
			if (parent != null) {
				if (parent._direct_tags.includes(META_LIST_NUMBERED)) {
					raw_html = '<span class="font-weight:bold;">'+(prior_peers+1)+')</span>&nbsp;'+raw_html;
				}
				else if (parent._direct_tags.includes(META_LIST_BULLETED)) {
					raw_html = '&#x25cf;&nbsp;&nbsp;'+raw_html;
				}
			}

			return raw_html;

		}
		catch (e) {
			return '<span style="color:red; font-weight:bold;">Error while applying text formatting</span>';
		}
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
			if (line.trim() != '') {
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

		if (text.startsWith('\n')) {
			text = text.replace('\n','');
		}
		return text;
	}

	function toTextWithoutPreservedNewlines(raw_html) {
		let text = raw_html;
		text = text.replace(/&amp;/g,'&');
		text = text.replace(/&apos;/g,"'");
		text = text.replace(/&quot;/g,'"');
		text = text.replace(/<div><br><\/div>/g,'\n'); 
		text = text.replace(/<br>/g,'\n'); 
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
		text = text.replace(/ /g, '&nbsp;');
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
			if (text != null && text != '') {
				parsed = text;
			}
		}
		catch (e) {

		}
		return parsed;
	}

	return {
		parse : parse,
		toText: toText,
		toEscaped: toEscaped,
		textOnly: textOnly,
		toTextWithoutPreservedNewlines: toTextWithoutPreservedNewlines, //TODO: these last two functions are named too similarly
		plainTextToHTML: plainTextToHTML,
		stripFormatting: stripFormatting
	}

})();