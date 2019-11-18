"use strict";

let $parseTagging = (function() {

	//TODO+ deal with general attributes

	let tagging_grammar = `
	TaggingGrammar {
		Valid_tags = tag*
		tag = atttag     --attribute
		    | puretag    --pure
		atttag = puretag "=" "-"? puretag
		puretag = tag_start tag_middle*
		tag_middle = alnum | "-" | "_" | "." | "/" | ":" | "#" | "@" | "!" | "+" | "'" | "&"
		tag_start = alnum | "_" | "#" | "@"
	}`;

	let g = ohm.grammar(tagging_grammar);

	let s = g.createSemantics().addOperation('eval', {
		Valid_tags: function(a) {
			let result = a.eval();
			return result;
		},
		tag: function(e) {
			return e.eval();
		},
		tag_attribute: function(e) {
			return e.eval();
		},
		tag_pure: function(e) {
			return e.eval();
		},
		atttag: function(lhs, eq, minus, rhs) {
			let text = lhs.eval().text;
			let value = this.sourceString.split('=')[1];
			let obj = {
				type: 'tag',
				text: text,
				value: value
			};
			return obj;
		},
		puretag: function(a, b) {
			let text = this.sourceString;
			let obj = {
				type: 'tag',
				text: text
			};
			return obj;
		}
	});

	////////////////////////////////////////////////////////////////////

	let _cached = {};

	return function(content) {
		const items = $model.getUnsortedItems();
		let timer = new Timer('Tag Parse Timer');
		let m = null;
		if (_cached[content] != undefined) {
			console.log('*Use cached parse results');
			m = _cached[content];
		}
		else {
			m = g.match(content);
			_cached[content] = m;
		}
		if (m.succeeded()) {
			let n = s(m);
			let results = n.eval();
			
			if (results.length > 0) {

				let last = results[results.length-1];

				//TODO: This is a hack, but simpler than mucking with the grammar
				if (last.type == 'tag' && content.endsWith(' ') == false) {
					last.partial = true;
				}

				let valid_tags = $model.getAllTags();

				for (let result of results) {
					if (result.type == 'tag') {
						result.valid_exact_tag_matches = [];
						result.valid_prefix_tag_matches = [];
						for (let tag of valid_tags) {
							if (tag.toLowerCase().startsWith(result.text.toLowerCase())) {
								if (tag.toLowerCase() == result.text.toLowerCase()) {
									result.valid_exact_tag_matches.push(tag);
									if (result.partial == true) {
										result.valid_prefix_tag_matches.push(tag);
									}
								}
								else {
									if (result.partial == true) {
										result.valid_prefix_tag_matches.push(tag);
									}
								}
							}
						}
					}
				}
				return results;

			}
			timer.end();
			timer.display();
			return [];
		}
		else {
			timer.end();
			timer.display();
			return null;
		}
	}
})();