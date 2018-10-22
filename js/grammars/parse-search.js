'use strict';

let $parseSearch = (function() {

	let search_grammar = `
	SearchGrammar {
		Valid_search = term* partial?
		partial = dblquote searchtext 	  -- pos_quote_text
				| dblquote            	  -- pos_quote
				| neg dblquote searchtext -- neg_quote_text
				| neg dblquote            -- neg_quote
				| neg                     -- neg
		term = neg_term | pos_term
		pos_term = pos_tag | pos_substring
		neg_term = neg_tag | neg_substring
		pos_tag = tag
		neg_tag = neg tag
		pos_substring = substring
		neg_substring = neg substring
		tag = numtag     --numeric
		    | puretag    --pure
		numtag = puretag relation "-"? digit+ "." digit+  --decimal
		       | puretag relation "-"? digit+             --integer
		puretag = tag_start tag_middle*
		tag_middle = alnum | "-" | "_" | "." | "/" | ":" | "#" | "@" | "!" | "+" | "'" | "&"
		tag_start = alnum | "_" | "#" | "@"
		relation = ">=" | "<=" | "=" | ">" | "<"
		substring = dblquote searchtext dblquote
		searchtext = (~dblquote any)+
		dblquote = "\\""
		neg = "-"
	}
	`;

	let g = ohm.grammar(search_grammar);

	let s = g.createSemantics().addOperation('eval', {
		Valid_search: function(a, b) {
			let result = a.eval();
			let partial = b.eval();
			if (partial.length > 0) {
				result.push(partial[0]);
			}
			return result;
		},
		partial: function(a) {
			let obj = a.eval();
			obj['src'] = this.sourceString;
			return obj;
		},
		partial_pos_quote_text: function(a,b) {
			let text = b.eval();
			let obj = {
				type: 'substring',
				text: text,
				partial: true
			};
			return obj;
		},
		partial_pos_quote: function(a) {
			let obj = {
				type: 'substring',
				partial: true
			};
			return obj;
		},
		partial_neg_quote_text: function(a,b,c) {
			let text = c.eval();
			let obj = {
				type: 'substring',
				text: text,
				partial: true,
				negated: true
			};
			return obj;
		},
		partial_neg_quote: function(a,b) {
			let obj = {
				type: 'substring',
				partial: true,
				negated: true
			};
			return obj;
		},
		partial_neg: function(a) {
			let obj = {
				type: 'unknown',
				partial: true,
				negated: true
			};
			return obj;
		},
		neg_substring: function(a, b) {
			let obj = b.eval();
			obj.negated = true;
			return obj;
		},
		pos_substring: function(a) {
			let obj = a.eval();
			return obj;
		},
		term: function(a) {
			let obj = a.eval();
			obj['src'] = this.sourceString;
			return obj;
		},
		pos_term: function(a) {
			let obj = a.eval();
			return obj;
		},
		neg_term: function(a) {
			let obj = a.eval();
			obj['negated'] = true;
			return obj;
		},
		neg_tag: function(a, b) {
			let text = b.eval().text;
			let obj = {
				type: 'tag',
				text: text,
				negated: true
			};
			return obj;
		},
		tag: function(e) {
			return e.eval();
		},
		tag_numeric: function(e) {
			return e.eval();
		},
		tag_pure: function(e) {
			return e.eval();
		},
		numtag_decimal: function(t, eq, minus, d, dot, ds) {
			let text = t.eval().text;
			let relation = eq.eval();
			let value = parseFloat(this.sourceString.split('=')[1]);
			let obj = {
				type: 'tag',
				text: text,
				value: value,
				relation: relation
			};
			return obj;
		},
		numtag_integer: function(t, eq, minus, d) {
			let text = t.eval().text;
			let relation = eq.eval();
			let value = parseInt(this.sourceString.split('=')[1]);
			let obj = {
				type: 'tag',
				text: text,
				value: value,
				relation: relation
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
		},
		substring: function(a, b, c) {
			let text = b.eval();
			let obj = {
				type: 'substring',
				text: text
			};
			return obj;
		},
		relation: function(a) {
			return this.sourceString;
		},
		searchtext: function(a) {
			return this.sourceString;
		}
	});

	////////////////////////////////////////////////////////////////////

	function _getValidTags(items) {
		let set_tags = new Set();
		for (let item of items) {
			let s_tags = $model.getItemTags(item);
			for (let tag of s_tags.split(' ')) {
				set_tags.add(tag);
			}
		}
		let implications = $ontology.getImplications()
		for (let key in implications) {
			set_tags.add(key);
			for (let imp of implications[key]) {
				set_tags.add(imp);
			}
		}
		let tags = Array.from(set_tags);
		return tags;
	}

	////////////////////////////////////////////////////////////////////

	let _cached = {};
	let USE_CACHE = false;

	return function(items, content) {
		let timer = new Timer('Parse Timer');
		let m = null;
		if (USE_CACHE && _cached[content] != undefined) {
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

				let valid_tags = _getValidTags(items);

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

						let reverse_full_match_implication_set = new Set();
						for (let tag of result.valid_exact_tag_matches) {
							let reversed = $ontology.getReverseEnrichedTags(tag);
							if (tag == 'altered-state') {
								console.log('reversed = ' + reversed);
							}
							for (let rtag of reversed) {
								reverse_full_match_implication_set.add(rtag);
							}
						}
						result.valid_exact_tag_reverse_implications = Array.from(reverse_full_match_implication_set);

						let reverse_prefix_match_implication_set = new Set();
						for (let tag of result.valid_prefix_tag_matches) {
							let reversed = $ontology.getReverseEnrichedTags(tag);
							for (let rtag of reversed) {
								reverse_prefix_match_implication_set.add(rtag);
							}
						}
						result.valid_prefix_tag_reverse_implications = Array.from(reverse_prefix_match_implication_set);
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