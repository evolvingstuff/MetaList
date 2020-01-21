"use strict";

function autoformat(item, path, text1, text2) {

	//TODO: these are both still a little buggy
	const APPLY_TO_MARKDOWN = false;
	const APPLY_TO_HTML = false;

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
	if (subitem.tags.split(' ').includes(META_CSV) == false &&
		subitem.tags.split(' ').includes(META_MATRIX) == false) {
		let textified = $format.toText(text2);
		if ($parseCsv.isCsv(textified)) {
			let newTags = (subitem.tags.trim() + ' ' + META_CSV).trim();
			$model.updateSubTag(item, path, newTags);
			return;
		}
	}

	////////////////////////////////////////////////////////////////////
	// test for json file
	if (subitem.tags.split(' ').includes(META_JSON) == false) {
		let textified = $format.toText(text2);
		if ($parseJson.isJson(textified)) {
			let newTags = (subitem.tags.trim() + ' ' + META_JSON).trim();
			$model.updateSubTag(item, path, newTags);
			return;
		}
	}

	////////////////////////////////////////////////////////////////////
	// test for code file
	if (subitem.tags.split(' ').includes(META_MONOSPACE) == false) {
		if (text2.startsWith('```') && text2.endsWith('```')) {
			text2 = text2.replace('```', '').replace('```', '');
			$model.updateSubitemData(item, path, text2);
			let newTags = (subitem.tags.trim() + ' ' + META_MONOSPACE).trim();
			$model.updateSubTag(item, path, newTags);
			return;
		}
	}

	////////////////////////////////////////////////////////////////////
	// test for meta
	if (subitem.tags.split(' ').includes(META_IMPLIES) == false) {
		let textified = $format.toText(text2);
		//cheap rules for now, limit to two tags
		if (textified.split(' ').length == 3 && (textified.includes(' = ') || textified.includes(' => '))) {
			if ($parseMetaTagging.parse(textified) != null) {
				let newTags = (subitem.tags.trim() + ' ' + META_IMPLIES).trim();
				$model.updateSubTag(item, path, newTags);
				return;
			}
		}
	}

	////////////////////////////////////////////////////////////////////
	//test for html
	if (APPLY_TO_HTML &&
		subitem.tags.split(' ').includes(META_HTML) == false) {
		let textified = v.unescapeHtml(text2);
		if (isHTML(textified)) {
			console.log('Txt vs HTML to txt:');
        	console.log('\t' + rawText);
        	console.log('\t' + textified);
        	console.log('Adding @html tag');
			let new_tags = (subitem.tags.trim() + ' ' + META_HTML).trim();
			$model.updateSubTag(item, path, new_tags);
			return;
		}
	}

	////////////////////////////////////////////////////////////////////
	// test for markdown
	if (APPLY_TO_MARKDOWN &&
		subitem.tags.split(' ').includes(META_MARKDOWN) == false) {
		let formattedMarkdown = $parseMarkdown.getFormat(text2);
        let rawMdToTxt = $format.toTextWithoutPreservedNewlines(formattedMarkdown);
        let rawText = $format.toTextWithoutPreservedNewlines(text2);
        if (rawText != rawMdToTxt) {
        	console.log('Txt vs Markdown to txt:');
        	console.log('\t' + rawText);
        	console.log('\t' + rawMdToTxt);
        	console.log('Adding @markdown tag');
        	let newTags = (subitem.tags.trim() + ' ' + META_MARKDOWN).trim();
			$model.updateSubTag(item, path, newTags);
			return;
        }
	}

	////////////////////////////////////////////////////////////////////
	/*
	// test for todo/done
	if (text2.startsWith('[x]') && subitem.tags.split(' ').includes(META_DONE) == false) {
		text2 = text2.replace('[x]', '');
		$model.updateSubitemData(item, path, text2);
		let new_tags = (subitem.tags.trim() + ' ' + META_DONE).trim();
		$model.updateSubTag(item, path, new_tags);
		return;
	}

	if (text2.startsWith('[ ]') && subitem.tags.split(' ').includes(META_TODO) == false) {
		text2 = text2.replace('[ ]', '');
		$model.updateSubitemData(item, path, text2);
		let new_tags = (subitem.tags.trim() + ' ' + META_TODO).trim();
		$model.updateSubTag(item, path, new_tags);
		return;
	}
	*/
}