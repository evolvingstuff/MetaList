function autoformat(items, item, path, text1, text2) {
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
			let new_tags = (subitem.tags.trim() + ' @csv').trim();
			$model.updateSubTag(item, path, new_tags);
			return;
		}
	}

	////////////////////////////////////////////////////////////////////
	// test for code separated value file
	if (subitem.tags.split(' ').includes('@code') == false) {
		if (text2.startsWith('```') && text2.endsWith('```')) {
			text2 = text2.replace('```', '').replace('```', '');
			$model.updateSubitemData(item, path, text2);
			let new_tags = (subitem.tags.trim() + ' @code').trim();
			$model.updateSubTag(item, path, new_tags);
			return;
		}
	}

	////////////////////////////////////////////////////////////////////
	// test for meta
	if (subitem.tags.split(' ').includes('@meta') == false) {
		let textified = $format.toText(text2);
		//cheap rules for now, limit to two tags
		if (textified.split(' ').length == 3 && (textified.includes(' = ') || textified.includes(' => '))) {
			if ($parseMetaTagging.parse(textified) != null) {
				let new_tags = (subitem.tags.trim() + ' @meta').trim();
				$model.updateSubTag(item, path, new_tags);
				return;
			}
		}
	}
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

	//TODO: needs more testing
	/*
	////////////////////////////////////////////////////////////////////
	//html
	if (subitem.tags.split(' ').includes('@html') == false) {
		let textified = $format.toText(text2);
		if (isHTML(textified)) {
			let new_tags = (subitem.tags.trim() + ' @html').trim();
			$model.updateSubTag(item, path, new_tags);
			return;
		}
	}
	*/

	//TODO: markdown!!
}