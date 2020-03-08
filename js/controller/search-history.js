"use strict";

let $searchHistory = (function() {

	let activated = false;
	let previous = '';

	const DECAY = 0.95;
	let weightedHistory = {};

	function addActivatedSearch(parse_results) {

		//TODO: how to deal with `me` -> `MetaList` problem?

		let t1 = Date.now();

		if (activated == false) { //Hack to avoid initial render
			activated = true;
			return;
		}

		let tags = [];
		for (let result of parse_results) {
			if (result.type != 'tag') {
				continue;
			}
			if (result.valid_exact_tag_matches.length < 1) {
				continue;
			}
			if (result['negated'] != undefined) {
				continue;
			}
			tags.push(result.valid_exact_tag_matches[0]);
		}
		if (tags.length == 0) {
			return;
		}
		let valid_string = tags.join(' ');
		if (valid_string != previous) {
			console.log('+: ' + valid_string);

			if (previous != '') {
				let partsOld = previous.split(' ');
				let lastOld = v.lowerCase(partsOld[partsOld.length-1]);
				let partsNew = valid_string.split(' ');
				let lastNew = v.lowerCase(partsNew[partsNew.length-1]);
				if (lastNew.startsWith(lastOld)) {
					console.log('\tInvalidate ' + lastOld)
					weightedHistory[partsOld[partsOld.length-1]] -= 1;
				}
			}

			previous = valid_string;

			for (const [tag, value] of Object.entries(weightedHistory)) {
				let decayed = value * DECAY;
				weightedHistory[tag] = decayed;
			}
			for (let tag of valid_string.split(' ')) {
				if (weightedHistory[tag] == undefined) {
					weightedHistory[tag] = 1;
				}
				else {
					weightedHistory[tag] += 1;
				}
			}

			for (const [tag, value] of Object.entries(weightedHistory)) {
				if (value > 0) {
					console.log('\t' + tag + ' -> ' + value);
				}
			}
		}

		let t2 = Date.now();

		console.log((t2-t1) + 'ms');
	}

	function getWeightedHistory() {
		let results = sortDict(weightedHistory);
		return results;
	}

	return {
		addActivatedSearch: addActivatedSearch,
		getWeightedHistory: getWeightedHistory
	}

})();