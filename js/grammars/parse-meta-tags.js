"use strict";

//TODO asdf meta
let $parseMetaTagging = (function() {

	//TODO+ this does not yet support numeric tags or attributes

	let meta_tagging_grammar = `
	MetaTaggingGrammar {
		Line = Term Continuation*          -- expression
		Continuation = op tag+
		Term = tag+ op tag+
		op = imp                           -- implication
		   | eq                            -- equality
		eq = "==" | "=" | "<=>" | "<->"
		imp = "=>" | "->"
		tag = tag_start tag_middle*
		tag_middle = alnum | "-" | "_" | "." | "/" | ":" | "#" | "@" | "!" | "+" | "'" | "&"
		tag_start = alnum | "_" | "#" | "@"
	}`;

	let g = ohm.grammar(meta_tagging_grammar);

	let s = g.createSemantics().addOperation('eval', {
		Line_expression: function(term, continuations) {
			let result = [];
			for (let part of term.eval()) {
				result.push(part);
			}
			for (let continuation of continuations.eval()) {
				for (let part of continuation) {
					result.push(part);
				}
			}
			return result;
		},
		Continuation: function(op, tags_right) {
			let result = [];
			result.push(op.eval());
			for (let tag of tags_right.eval()) {
				result.push(tag);
			}
			return result;
		},
		Term: function(tags_left, op, tags_right) {
			let result = [];
			for (let tag of tags_left.eval()) {
				result.push(tag);
			}
			result.push(op.eval());
			for (let tag of tags_right.eval()) {
				result.push(tag);
			}
			return result;
		},
		op_implication: function(operator) {
			let text = this.sourceString;
			let obj = {
				type: 'implication',
				text: text
			};
			return obj;
		},
		op_equality: function(operator) {
			let text = this.sourceString;
			let obj = {
				type: 'equality',
				text: text
			};
			return obj;
		},
		tag: function(tag_start, tag_middle) {
			let text = this.sourceString;
			let obj = {
				type: 'tag',
				text: text
			};
			return obj;
		}
	});

	function parse(content) {
		let m = g.match(content);
		if (m.succeeded()) {
			let n = s(m);
			let results = n.eval();
			return results;
		}
		else {
			console.warn('WARNING: failed to parse: ' + content);
			return null;
		}
	}

	function getImplications(content) {

		//TODO asdf meta  - need to completely rewrite this method

		let results = parse(content);

		if (results === null) {
			return {};
		}

		if (results[0].type === 'comment') {
			return results;
		}

		let implications = {};

		//forward implication chaining
		for (let i = 0; i < results.length; i++) {
			if (results[i].type === 'tag') {
				let mode_chain = false;
				for (let j = i+1; j < results.length; j++) {
					if (results[j].type === 'implication' || results[j].type === 'equality') {
						mode_chain = true;
					}
					else if (results[j].type === 'tag') {
						if (mode_chain === true) {
							//console.log('  ' + results[i].text + ' -> ' + results[j].text);
							if (implications[results[i].text] === undefined || implications[results[i].text] === null) {
								implications[results[i].text] = [];
							}
							if (implications[results[i].text].includes(results[j].text) === false) {
								implications[results[i].text].push(results[j].text);
							}
						}
					}
				}
			}
		}
		//backward equality chaining
		for (let i = results.length-1; i >= 0; i--) {
			if (results[i].type === 'tag') {
				let mode_equality_chain = false;
				for (let j = i-1; j >= 0; j--) {
					if (results[j].type === 'implication') {
						break;
					}
					else if (results[j].type === 'equality') {
						mode_equality_chain = true;
					}
					else if (results[j].type === 'tag') {
						if (mode_equality_chain === true) {
							//console.log('  ' + results[j].text + ' <- ' + results[i].text);
							if (implications[results[i].text] === undefined || implications[results[i].text] === null) {
								implications[results[i].text] = [];
							}
							if (implications[results[i].text].includes(results[j].text) === false) {
								implications[results[i].text].push(results[j].text);
							}
						}
					}
				}
			}
		}
		return implications;
	}

	let _cached_format = {};

	function getFormat(text) {
		if (_cached_format[text] !== undefined) {
			return _cached_format[text];
		}
		
		let format_lines = [];
		for (let line of text.split('\n')) {
			if (line === '') {
				continue;
			}
			let m = g.match(line);
			if (m.succeeded()) {

				let parts = line.split(' ');
				let format_parts = [];
				for (let part of parts) {
					if (part === '=>') {
						format_parts.push('<small><span class="glyphicon glyphicon-arrow-right"></span></small>');
					}
					else if (part === '=') {
						format_parts.push('<span style="font-weight:bold;">=</span>');
					}
					else {
						format_parts.push('<span class="badge badge-light meta-tag">'+part+'</span>'); //badge-secondary
					}
				}
				format_lines.push('<div style="height:25px;">'+format_parts.join(' ')+'</div>');

			}
			else {
				console.warn('FAILED PARSE: "'+line+'"');
				format_lines.push('<div style="height:25px; background-color:#ee8888;">'+line+'</div>');
			}
		}

		let result = '<div class="meta" style="display:inline-block">' + format_lines.join('') + '</div>';
		_cached_format[text] = result;
		return result;
	}

	function isValidMetaEntry(textified) {

		//TODO asdf meta  - rewrite this function

		if (parse(textified) === null) {
			return false;
		}
		return true;
	}

	return {
		getImplications: getImplications,
		getFormat: getFormat,
		isValidMetaEntry: isValidMetaEntry
	};

})();