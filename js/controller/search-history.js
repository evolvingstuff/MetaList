"use strict";

let $searchHistory = (function() {

	let activated = false;
	let previous = '';

	const MIXIN_BY_FREQ = false;

	const DECAY = 0.98;
	let weightedHistory = {};

	let weightedHistoryFull = {};

	function getValidTags(parse_results) {
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

		//TODO: how to deal with `me` -> `MetaList` problem?

		let t1 = Date.now();

		if (activated == false) { //Hack to avoid initial render
			activated = true;
			return;
		}

		let tags = getValidTags(parse_results);
		
		if (tags.length == 0) {
			console.log(' ');
			return;
		}
		let valid_string = tags.join(' ');
		if (valid_string != previous) {
			console.log('-------------------------------');
			console.log('+: ' + valid_string);

			if (previous != '') {
				let partsOld = previous.split(' ');
				let lastOld = v.lowerCase(partsOld[partsOld.length-1]);
				let partsNew = valid_string.split(' ');
				let lastNew = v.lowerCase(partsNew[partsNew.length-1]);
				if (lastNew.startsWith(lastOld)) {
					//console.log('\t~Invalidate ' + lastOld);
					weightedHistory[partsOld[partsOld.length-1]] -= 1;
					console.log('\t~Invalidate ' + previous);
					//console.log('\t' + previous + ' ' + weightedHistoryFull[previous] + '');
					weightedHistoryFull[previous] -= 1;
					//console.log('\t' + previous + ' ' + weightedHistoryFull[previous] + '');
				}
			}

			for (const [tag, value] of Object.entries(weightedHistoryFull)) {
				let decayed = value * DECAY;
				weightedHistoryFull[tag] = decayed;
			}
			if (weightedHistoryFull[valid_string] == undefined) {
				weightedHistoryFull[valid_string] = 1;
				//console.log('\t=1');
			}
			else {
				weightedHistoryFull[valid_string] += 1;
				//console.log('\t+=1');
			}

			//console.log('\t' + valid_string + ' ' + weightedHistoryFull[valid_string] + '');

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

			/*
			for (const [tag, value] of Object.entries(weightedHistory)) {
				if (value > 0) {
					console.log('\t' + tag + ' -> ' + value);
				}
			}
			*/

			for (const [tag, value] of Object.entries(weightedHistoryFull)) {
				if (value > 0) {
					console.log('\t' + tag + ' -> ' + value);
				}
			}
		}

		let t2 = Date.now();

		console.log((t2-t1) + 'ms');
	}

	function getWeightedHistoryFull(parse_results) {

		let seedTags = getValidTags(parse_results);

		//need to break into levels
		let levels = {};

		let levels2 = {};

		let level_ints = [];
		for (const item of Object.entries(weightedHistoryFull)) {
			if (item[1] <= 0) {
				continue;
			}
			let tags = item[0].split(' ');
			let match = 0;
			for (let seedTag of seedTags) {
				if (tags.includes(seedTag)) {
					match += 1;
				}
			}
			if (levels[match] == undefined) {
				levels[match] = [];
			}
			if (levels2[match] == undefined) {
				levels2[match] = {};
			}
			levels[match].push(item);
			if (level_ints.includes(match) == false) {
				level_ints.push(match);
			}
		}

		if (MIXIN_BY_FREQ) {
			let items = $model.getUnsortedItems();
			for (let item of items) {
				if (item.subitems[0]._include == -1) {
					continue;
				}
				let match = 0;
				let unmatched = [];
				for (let subitem of item.subitems) {
					if (subitem._include == -1) {
						continue;
					}
					for (let tag of subitem._tags) {
						if (seedTags.includes(tag)) {
							match += 1;
						}
						else {
							unmatched.push(tag);
						}
					}
					if (match < 1) {
						continue;
					}
					if (level_ints.includes(match) == false) {
						level_ints.push(match);
					}
					if (levels2[match] == undefined) {
						levels2[match] = {};
					}
					if (levels[match] == undefined) {
						levels[match] = [];
					}
					for (let tag of unmatched) {
						if (levels2[match][tag] == undefined) {
							levels2[match][tag] = 1;
						}
						else {
							levels2[match][tag] += 1;
						}
					}
				}
			}

		}

		sortArrayOfNumbersInPlace(level_ints)
		level_ints.reverse();
		// console.log('');
		// console.log('LEVELS');
		// console.log(JSON.stringify(level_ints));

		let results = [];
		let resultsTags = [];

		for (let level of level_ints) {
			//console.log('LEVEL ' + level);
			let values = levels[level];
			values.sort(function(a, b){
				return b[1] - a[1];
			});
			for (let item of values) {
				console.log('\t1@' + JSON.stringify(item))
				let tags = item[0].split(' ');
				for (let tag of tags) {
					if (seedTags.includes(tag)) {
						continue;
					} 
					if (resultsTags.includes(tag)) {
						continue;
					}
					resultsTags.push(tag);
					console.log('\t\t>> ' + tag);
					results.push([tag, level+1]);
				}
			}

			if (MIXIN_BY_FREQ) {
				let values2 = sortDict(levels2[level]);
				//console.log(values2);
				//debugger;
				for (let item of values2) {
					console.log('\t2@ ' + JSON.stringify(item))
					let tag = item[0];
					if (seedTags.includes(tag)) {
						continue;
					} 
					if (resultsTags.includes(tag)) {
						continue;
					}
					resultsTags.push(tag);
					//console.log('\t\t>> ' + tag);
					results.push([tag, level+1]);
				}
			}
		}
		//console.log(JSON.stringify(results));
		return results;
	}

	return {
		addActivatedSearch: addActivatedSearch,
		getWeightedHistoryFull: getWeightedHistoryFull
	}

})();