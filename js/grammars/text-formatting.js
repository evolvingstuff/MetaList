let CLIPBOARD_ESCAPE_SEQUENCE = '{{CLIPBOARD}}';

let $format = (function() {

	let DATE_WIDGET_SEPARATOR = '<br>&nbsp;&nbsp;'; //'&nbsp;&nbsp;&nbsp;';

	function parse(raw_html, tags, item, subitem, subitemIndex) {
		try {
			let enriched_tags = $ontology.getEnrichedTags(tags);

			let hasChildren = $model.subitemHasChildren(item, subitem, subitemIndex);

			if (enriched_tags.includes('@meta')) {
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

			for (let tag of enriched_tags) {

				if (tag.startsWith('@') == false) {
					continue;
				}

				if (tag == '@date-headline') {
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

				if (tag == '@csv') {
					let text = toText(raw_html);
					raw_html = $parseCsv.getFormat(text);
					continue;
				}

				if (tag == '@json') {
					let text = toText(raw_html);
					raw_html = $parseJson.getFormat(text);
					continue;
				}

				if (tag == '@password') {
					let formatted_html = '<span style="font-family:courier new;"><i class="glyphicon glyphicon-lock"></i> Password:</span> <div class="copyable" title="Click to copy password to clipboard" style="filter: blur(5px);">'+raw_html+'</div>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@username') {
					let formatted_html = '<span style="font-family:courier new;"><i class="glyphicon glyphicon-user"></i> Username:</span> <div class="copyable" title="Click to copy username to clipboard" >'+raw_html+'</div>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@email') {
					let formatted_html = '<span style="font-family:courier new;"><i class="glyphicon glyphicon-envelope"></i> Email:</span> <a href="mailto:'+raw_html+'">'+raw_html+'</a>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@private') {
					let formatted_html = '<div style="filter: blur(5px);">'+raw_html+'</div>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@hide') {
					let formatted_html = '<span class="hide-me">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@copy') {
					let formatted_html = '<span class="copyable">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@html') {
					let text = toText(raw_html);
					raw_html = text;
					continue;
				}

				//@done takes precedence over @todo
				//TODO: figure out fancier way to handle this
				if (tag == '@done') {
					let formatted_html = '<span class="action-uncheck"><i class="glyphicon glyphicon-check"></i></span>&nbsp;'+raw_html;
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@todo') {
					let formatted_html = '<span class="action-check"><i class="glyphicon glyphicon-unchecked"></i></span>&nbsp;'+raw_html;
					raw_html = formatted_html;
					continue;
				}

				if (subitemIndex > 0 && hasChildren) {

					//Ignore @-/@+ for header subitem

					//@- takes precedence over @+
					//TODO: figure out fancier way to handle this
					if (tag == '@-' || tag == '@folded') {
						let formatted_html = '<span><i class="glyphicon glyphicon-triangle-right action-unfold"></i>&nbsp;'+raw_html+'</span>';
						raw_html = formatted_html;
						continue;
					}

					if (tag == '@+' || tag == '@unfolded') {
						let formatted_html = '<span><i class="glyphicon glyphicon-triangle-bottom action-fold"></i>&nbsp;'+raw_html+'</span>';
						raw_html = formatted_html;
						continue;
					}
				}

				if (tag == '@goto') {
					let formatted_html = '<i class="glyphicon glyphicon-link"></i>&nbsp;<span class="action-goto-search">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@embed') {
					let parts = raw_html.split('@id=');
					//TODO: this is ugly as hell
					if (parts.length == 2) {
						try {
							let id = parseInt(parts[1]);
							let embedded_item = $model.getItemById(id);

							let formatted_html = '<div class="embedded-subitem">';
							formatted_html += $render.renderEmbeddedItem(embedded_item, subitem.indent);
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

				if (tag == '@broken-search') {
					let formatted_html = '<span style="color:red;"><i class="glyphicon glyphicon-remove"></i>&nbsp;'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@monospace') {
					let formatted_html = '<span class="monospace">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@code') {
					let formatted_html = '<span class="copyable"><code class="metalist-code">'+raw_html+'</code></span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@exec') {
					raw_html = raw_html.replace(CLIPBOARD_ESCAPE_SEQUENCE, '<span class="exec-escaped">'+CLIPBOARD_ESCAPE_SEQUENCE+'</span>');
					let formatted_html = '<span class="executable"><code class="metalist-code-executable">'+raw_html+'</code></span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@markdown') {
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

				if (tag == '@LaTeX') {
					let text = toText(raw_html);
					let formatted_html = katex.renderToString(text, {
					    throwOnError: false
					});
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@nomnoml') {
					let canvasId = item.id+'_'+subitemIndex;
					let text = toText(raw_html);
					$effects.addNomnomlDrawing(canvasId, text);
					raw_html = '<canvas id="'+canvasId+'" class="nomnoml-canvas"></canvas>';
					continue;
				}

				if (tag == '@bold') {
					let formatted_html = '<span style="font-weight:bold;">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@italic') {
					let formatted_html = '<span style="font-style:italic;">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@strikethrough') {
					let formatted_html = '<span style="text-decoration:line-through;">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@h1') {
					let formatted_html = '<h1>'+raw_html+'</h1>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@h2') {
					let formatted_html = '<h2>'+raw_html+'</h2>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@h3') {
					let formatted_html = '<h3>'+raw_html+'</h3>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@h4') {
					let formatted_html = '<h4>'+raw_html+'</h4>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@heading') {
					let formatted_html = '<h4>'+raw_html+'</h4>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@red') {
					let formatted_html = '<span style="color:red;">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@blue') {
					let formatted_html = '<span style="color:blue;">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@green') {
					let formatted_html = '<span style="color:green;">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@grey') {
					let formatted_html = '<span style="color:grey;">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@text-only') {
					//TODO: this is hacky
					let lines = raw_html;
					let tags = ['\<div.*?\>','\<\/div\>','\<hr.*?\>','\<br.*?\>','\<img.*?\>','\<\/img\>',];
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
					console.log(new_lines);
					formatted_html = new_lines.join('<br>');
					console.log('@text-only');
					raw_html = formatted_html;
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
				if (parent._direct_tags.includes('@list-numbered')) {
					raw_html = '<span class="font-weight:bold;">'+(prior_peers+1)+')</span>&nbsp;'+raw_html;
				}
				else if (parent._direct_tags.includes('@list-bulleted')) {
					raw_html = '&#x25cf;&nbsp;&nbsp;'+raw_html;
				}
			}

			return raw_html;

		}
		catch (e) {
			return '<span style="color:red; font-weight:bold;">Error while applying text formatting</span>';
		}
	}

	function toText(raw_html) {
		let text = raw_html;
		text = text.replace(/&amp;/g,'&');
		text = text.replace(/&apos;/g,"'");
		text = text.replace(/&quot;/g,'"');
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
		toTextWithoutPreservedNewlines: toTextWithoutPreservedNewlines //TODO: these last two functions are named too similarly
	}

})();