let $format = (function() {

	function parse(raw_html, tags, item, subitem, subitem_index) {
		try {
			let enriched_tags = $ontology.getEnrichedTags(tags);

			if (enriched_tags.includes('@meta')) {
				let text = toText(raw_html);
				raw_html = $parseMetaTagging.getFormat(text);
				return raw_html;
			}

			raw_html = $macros.transform(subitem.data, enriched_tags);

			for (let tag of enriched_tags) {

				if (tag.startsWith('@') == false) {
					continue;
				}

				if (tag == '@macro') {
					let text = toText(raw_html);
					raw_html = $parseMacro.getFormat(text);
					continue;
				}

				if (tag == '@date-headline') {
					let calendar = '<span class="glyphicon glyphicon-calendar"></span>&nbsp;&nbsp;';
					let formatted_date = formatDateAndDOW(item);
					if (raw_html != '') {
						raw_html = calendar + formatted_date + '<br>' + raw_html;
					}
					else {
						raw_html = calendar + formatted_date;
					}
					continue;
				}

				if (tag == '@csv') {
					let text = toText(raw_html);
					raw_html = $parseCsv.getFormat(text);
					continue;
				}

				if (tag == '@numbered') {
					let number = 1;
					let i = subitem_index - 1;
					let prev = item.subitems[i];
					while (i > 0 && prev.indent >= subitem.indent) {
						if (prev.indent == subitem.indent) {
							if (prev._direct_tags.includes('@numbered')) {
								number += 1;
							}
							else {
								break;
							}
						}
						i--;
						prev = item.subitems[i];
					}
					let formatted_html = '<span class="font-weight:bold;">'+number+')</span>&nbsp;'+raw_html;
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@bulleted') {
					let formatted_html = '&#x25cf;&nbsp;&nbsp;'+raw_html;
					raw_html = formatted_html;
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
					let formatted_html = '<span class="copyable"><i class="glyphicon glyphicon-share"></i> '+raw_html+'</span>';
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
					let formatted_html = '<span><i class="glyphicon glyphicon-check action-uncheck"></i>&nbsp;'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@todo') {
					let formatted_html = '<span><i class="glyphicon glyphicon-unchecked action-check"></i>&nbsp;'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@goto-search') {
					let formatted_html = '<i class="glyphicon glyphicon-link"></i>&nbsp;<span class="action-goto-search">'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}
				if (tag == '@broken-search') {
					let formatted_html = '<span style="color:red;"><i class="glyphicon glyphicon-remove"></i>&nbsp;'+raw_html+'</span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@code') {
					let formatted_html = '<span class="copyable"><code>'+raw_html+'</code></span>';
					raw_html = formatted_html;
					continue;
				}

				if (tag == '@markdown') {
					let text = toText(raw_html);
					showdown.setFlavor('github');
					let converter = new showdown.Converter();
		    		let formatted_html = converter.makeHtml(text);
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

				if (tag == '@preview') {
					//
					let text = toText(raw_html);
					let href = '<a href="'+text+'">'+text+'</a><div class="box"><iframe src="'+text+'" width = "500px" height = "500px"></iframe></div>';
					raw_html = href;
					continue;
				}

				if (tag == '@href') {
					let text = toText(raw_html);
					let href = '<a href="'+text+'" target="_blank">'+text+'</a>';
					raw_html = href;
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
					let formatted_html = text_only(raw_html);
					raw_html = formatted_html;
					continue;
				}
			}

			if ((raw_html.trim().startsWith('https://') || raw_html.trim().startsWith('http://')) && raw_html.trim().split(' ').length == 1) {
				let formatted_html = '<a href="'+raw_html.trim()+'" target="_blank">'+raw_html.trim()+'</a>';
				raw_html = formatted_html;
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

	function toEscaped(text) {
		text = text.replace(/&/g, '&amp;');
		text = text.replace(/'/g, '&apos;');
		text = text.replace(/</g, '&lt;');
		text = text.replace(/>/g, '&gt;');
		text = text.replace(/ /g, '&nbsp;');
		return text;
	}

	function text_only(html) {
		return $(html).text();
	}

	return {
		parse : parse,
		toText: toText,
		toEscaped: toEscaped
	}

})();