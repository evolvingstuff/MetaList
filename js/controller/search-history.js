"use strict";

let $searchHistory = (function() {

	let activated = false;
	let previous = '';

	const DECAY = 0.98;
	let weightedHistoryFull = null;
	const REQUIRE_ROOT_MATCH = true;

	function init() {
		load();
	}

	function load() {
		let search_history = localStorage.getItem('search-history');
        if (search_history != null && search_history != 'null') {
            weightedHistoryFull = JSON.parse(search_history);
        }
        else {
        	console.log('initializing blank search history');
        	weightedHistoryFull = {};
        }
	}

	function save() {
		localStorage.setItem('search-history', JSON.stringify(weightedHistoryFull));
	}

	function _getValidTags(parse_results) {
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
		return tags;
	}

	function addActivatedSearch(parse_results) {

		if (activated == false) { //Hack to avoid initial render
			activated = true;
			return;
		}

		let tags = _getValidTags(parse_results);
		
		if (tags.length == 0) {
			return;
		}
		let valid_string = tags.join(' ');
		if (valid_string != previous) {
			
			if (previous != '') {
				let partsOld = previous.split(' ');
				let lastOld = v.lowerCase(partsOld[partsOld.length-1]);
				let partsNew = valid_string.split(' ');
				let lastNew = v.lowerCase(partsNew[partsNew.length-1]);
				if (lastNew.startsWith(lastOld)) {
					weightedHistoryFull[previous] -= 1;
				}
			}

			for (const [tag, value] of Object.entries(weightedHistoryFull)) {
				let decayed = value * DECAY;
				weightedHistoryFull[tag] = decayed;
			}

			if (weightedHistoryFull[valid_string] == undefined) {
				weightedHistoryFull[valid_string] = 1;
			}
			else {
				weightedHistoryFull[valid_string] += 1;
			}

			previous = valid_string;
		}
		save();
	}

	function getWeightedHistoryFull(parse_results) {

		let firstTag = null;
		if (parse_results.length > 0 && 
			parse_results[0].type == 'tag' && 
			parse_results[0]['negated'] == undefined &&
			parse_results[0].valid_exact_tag_matches.length > 0) {
			firstTag = parse_results[0].valid_exact_tag_matches[0];
		}

		let seedTags = _getValidTags(parse_results);

		//need to break into levels
		let levels = {};
		let level_ints = [];
		for (const item of Object.entries(weightedHistoryFull)) {
			if (item[1] <= 0) {
				continue;
			}
			let tags = item[0].split(' ');

			if (tags.length == 0) {
				continue;
			}

			if (REQUIRE_ROOT_MATCH && firstTag != null) {
				if (firstTag != tags[0]) {
					//Does not match at root tag, so ignore
					continue;
				}
			}

			//console.log('Match: ' + item[0]);

			let match = 0;
			for (let seedTag of seedTags) {
				if (tags.includes(seedTag)) {
					match += 1;
				}
			}
			if (levels[match] == undefined) {
				levels[match] = [];
			}
			levels[match].push(item);
			if (level_ints.includes(match) == false) {
				level_ints.push(match);
			}
		}

		sortArrayOfNumbersInPlace(level_ints)
		level_ints.reverse();

		let results = [];
		let resultsTags = [];

		for (let level of level_ints) {
			let values = levels[level];
			values.sort(function(a, b){
				return b[1] - a[1];
			});
			for (let item of values) {
				let tags = item[0].split(' ');
				for (let tag of tags) {
					if (seedTags.includes(tag)) {
						continue;
					} 
					if (resultsTags.includes(tag)) {
						continue;
					}
					resultsTags.push(tag);
					results.push([tag, level+1]);
				}
			}
		}
		//console.log(JSON.stringify(results));
		return results;
	}

	init();

	return {
		addActivatedSearch: addActivatedSearch,
		getWeightedHistoryFull: getWeightedHistoryFull
	}

})();