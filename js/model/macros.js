let $macros = (function() {
	
	let macros = {};

	function loadMacros(items) {
		console.log('Loading macros...');
		let new_macros = {};
		for (let item of items) {
			if (item.deleted != undefined) {
				continue;
			}
			for (let subitem of item.subitems) {
				if (subitem._tags.includes('@macro')) {
					let text = $format.toText(subitem.data);
					let parts = text.split(/\:(.+)/)
					let tag = parts[0].trim();
					let rule = parts[1].trim();
					new_macros[tag] = rule;
				}
			}
		}
		let updated = false;
		if (JSON.stringify(new_macros) != JSON.stringify(macros)) {
			updated = true;
		}
		macros = new_macros;
		//console.log(JSON.stringify(macros));
		return updated;
	}

	function transform(subitem_data, enriched_tags) {
		//TODO numeric tags too?
		for (let t of enriched_tags) {
			if (macros[t] == undefined) {
				continue;
			}
			let new_text = macros[t];
			let text = $format.toText(subitem_data);
			let lines = text.split('\n');
			for (let i = 0; i < lines.length; i++) {
				new_text = new_text.replace('$'+(i+1), lines[i]);
			}
			new_text = $format.toEscaped(new_text);
			return new_text;
		}
		return subitem_data;
	}

	return {
		loadMacros: loadMacros,
		transform: transform
	}

})();