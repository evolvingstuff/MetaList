"use strict";

function autoformat(item, path, text1, text2) {

	if (text1 == text2) {
		return;
	}
	
	//For now, just do this for new subitems (or rather, previously empty subitems)
	if (text1 != '') {
		return;
	}

	let subitem = $model.getSubitem(item, path);

	////////////////////////////////////////////////////////////////////
	// test for comma separated value file
	if (subitem.tags.split(' ').includes('@csv') == false) {
		let textified = $format.toText(text2);
		if ($parseCsv.isCsv(textified)) {
			let newTags = (subitem.tags.trim() + ' @csv').trim();
			$model.updateSubTag(item, path, newTags);
			return;
		}
	}

	////////////////////////////////////////////////////////////////////
	// test for json file
	if (subitem.tags.split(' ').includes('@json') == false) {
		let textified = $format.toText(text2);
		if ($parseJson.isJson(textified)) {
			let newTags = (subitem.tags.trim() + ' @json').trim();
			$model.updateSubTag(item, path, newTags);
			return;
		}
	}

	////////////////////////////////////////////////////////////////////
	// test for code file
	if (subitem.tags.split(' ').includes('@monospace') == false) {
		if (text2.startsWith('```') && text2.endsWith('```')) {
			text2 = text2.replace('```', '').replace('```', '');
			$model.updateSubitemData(item, path, text2);
			let newTags = (subitem.tags.trim() + ' @monospace').trim();
			$model.updateSubTag(item, path, newTags);
			return;
		}
	}

	////////////////////////////////////////////////////////////////////
	// test for meta
	if (subitem.tags.split(' ').includes('@implies') == false) {
		let textified = $format.toText(text2);
		//cheap rules for now, limit to two tags
		if (textified.split(' ').length == 3 && (textified.includes(' = ') || textified.includes(' => '))) {
			if ($parseMetaTagging.parse(textified) != null) {
				let newTags = (subitem.tags.trim() + ' @implies').trim();
				$model.updateSubTag(item, path, newTags);
				return;
			}
		}
	}
	////////////////////////////////////////////////////////////////////

	//TODO+

	////////////////////////////////////////////////////////////////////
	// test for markdown
	//TODO: still a little buggy
	/*
	if (subitem.tags.split(' ').includes('@markdown') == false) {
        let rawText = $format.toTextWithoutPreservedNewlines(text2);
        
        // showdown.setFlavor('github');
        // let converter = new showdown.Converter();
        // let formattedMarkdown = converter.makeHtml(rawText);

        var md = window.markdownit();
		let formattedMarkdown = md.render(rawText);
		//let formattedMarkdown = md.renderInline(rawText);

        let rawMdToTxt = $format.toTextWithoutPreservedNewlines(formattedMarkdown);
        if (rawText != rawMdToTxt) {
        	console.log('Txt vs Markdown to txt:');
        	console.log('\t' + rawText);
        	console.log('\t' + rawMdToTxt);
        	console.log('Adding @markdown tag');
        	let newTags = (subitem.tags.trim() + ' @markdown').trim();
			$model.updateSubTag(item, path, newTags);
			return;
        }
	}
	*/
	////////////////////////////////////////////////////////////////////

	////////////////////////////////////////////////////////////////////
	/*
	// test for todo/done
	if (text2.startsWith('[x]') && subitem.tags.split(' ').includes('@done') == false) {
		text2 = text2.replace('[x]', '');
		$model.updateSubitemData(item, path, text2);
		let new_tags = (subitem.tags.trim() + ' @done').trim();
		$model.updateSubTag(item, path, new_tags);
		return;
	}

	if (text2.startsWith('[ ]') && subitem.tags.split(' ').includes('@todo') == false) {
		text2 = text2.replace('[ ]', '');
		$model.updateSubitemData(item, path, text2);
		let new_tags = (subitem.tags.trim() + ' @todo').trim();
		$model.updateSubTag(item, path, new_tags);
		return;
	}
	*/

	////////////////////////////////////////////////////////////////////
	//html
	//TODO: still a little buggy
	/*
	if (subitem.tags.split(' ').includes('@html') == false) {
		let textified = $format.toTextWithoutPreservedNewlines(text2);
		if (isHTML(textified)) {
			let new_tags = (subitem.tags.trim() + ' @html').trim();
			$model.updateSubTag(item, path, new_tags);
			return;
		}
	}
	*/
}