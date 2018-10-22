'use strict';

let $filter = (function() {

	let total_included = 0;
	let total_excluded = 0;
	let total_undecided = 0;
	let total_headless = 0;
	let total_headless_post = 0;

	function filterItemsWithParse(items, parse_results, allow_prefix_matches) {
		total_included = 0;
		total_excluded = 0;
		total_undecided = 0;
		total_headless = 0;
		total_headless_post = 0;
		if (parse_results.length == 0) {
			for (let item of items) {
				for (let sub of item.subitems) {
					sub._include = 1;
					total_included++;
				}
			}
		}
		else {
			console.log(parse_results);
			let implications = $ontology.getImplications();
			for (let item of items) {
				_filterItemWithParseResults(item, parse_results, allow_prefix_matches, implications);
			}
		}

	}

	//TODO: this should be cached!
	function getIncludedTagCounts(items) {
		let implications = $ontology.getImplications();
		let all_tags = {};
        for (let item of items) {
            for (let sub of item.subitems) {
            	if (sub._include == -1) {
            		continue;
            	}
            	//TODO: might reconsider removing parent-inheritted tags
            	for (let tag of sub._tags) {
            		if (all_tags[tag] == undefined) {
            			all_tags[tag] = 1;
            		}
            		else {
            			all_tags[tag]++;
            		}
            		if (implications[tag] != undefined) {
	            		for (let imp of implications[tag]) {
	            			if (all_tags[imp] == undefined) {
		            			all_tags[imp] = 1;
		            		}
		            		else {
		            			all_tags[imp]++;
		            		}
	            		}
            		}
            	}
            }
        }
        let list = [];
        for (let key in all_tags) {
            list.push({ 'tag': key, 'count': all_tags[key]});
        }
        list.sort(function (a, b) {
            if (a.count < b.count) {
                return -1;
            }
            if (a.count > b.count) {
                return 1;
            }
            return b.tag.localeCompare(a.tag);
            ;
        });
        list.reverse();
        return list;
    }

    function fullyIncludeItem(item) {
    	if (item == null) {
    		return;
    	}
        for (let sub of item.subitems) {
            sub._include = 1;
        }
    }

    function _filterItemWithParseResults(item, parse_results, allow_prefix_matches, implications) {

		for (let sub of item.subitems) {
			sub._include = 0;
		}

		let debug_mode = false;

		//1) handle negated first
		for (let pr of parse_results) {
			if (pr.negated != undefined && pr.negated) {
				if (pr.type == 'tag') {

					/*
					if (pr.value != undefined) {
						console.log('TODO: handle negated numeric relations here.')
					}
					*/

					for (let i = 0; i < item.subitems.length; i++) {
						for (let tag of pr.valid_exact_tag_reverse_implications) {
							if (item.subitems[i]._tags.includes(tag)) {
								item.subitems[i]._include = -1;
								for (let j = i+1; j < item.subitems.length; j++) {
									if (item.subitems[j].indent <= item.subitems[i].indent) {
										break; //only apply to children
									}
									item.subitems[j]._include = -1;
								}
								break;
							}
						}
					}
				}
				else if (pr.type == 'substring') {
					for (let i = 0; i < item.subitems.length; i++) {
						if (item.subitems[i].data.indexOf(pr.text) != -1) {
							item.subitems[i]._include = -1;
							for (let j = i+1; j < item.subitems.length; j++) {
								if (item.subitems[j].indent <= item.subitems[i].indent) {
									break; //only apply to children
								}
								item.subitems[j]._include = -1;
							}
							break;
						}
					}
				}
			}
		}

		//2) handle inclusions second
		for (let i = 0; i < item.subitems.length; i++) {

			if (item.subitems[i]._include != 0) {
				continue;
			}

			let tags_and_implications = [];
			for (let t of item.subitems[i]._tags) {
				tags_and_implications.push(t);
				if (implications[t] != undefined) {
					for (let ti of implications[t]) {
						if (tags_and_implications.includes(ti) == false) {
							tags_and_implications.push(ti);
						}
					}
				}
			}

			let match_all = true;

			for (let pr of parse_results) {

				if (match_all == false) {
					break;
				}

				if (pr.negated != undefined && pr.negated) {
					continue;
				}

				if (pr.type == 'tag') {

					if (pr.value != undefined) { //Handle numeric relations
						if (item.subitems[i]._numeric_tags == undefined) {
							match_all = false;
							break;
						}
						else {
							let matched_one = false;
							for (let nt of item.subitems[i]._numeric_tags) {
								let parts = nt.split('=');

								//TODO: allow implications eventually
								if (parts[0] == pr.text) {
									console.log('-----------------------------');
									console.log("NUMERIC COMPARISON: "+pr.text+" "+pr.relation+" " + pr.value + " vs " + nt);
									console.log(item.subitems[i]);
									
									let val = parseFloat(parts[1]);
									if (pr.relation == '=') {
										if (val != pr.value) {
											match_all = false;
											break;
										}
									}
									else if (pr.relation == '>') {
										if (val <= pr.value) {
											match_all = false;
											break;
										}
									}
									else if (pr.relation == '<') {
										if (val >= pr.value) {
											match_all = false;
											break;
										}
									}
									else if (pr.relation == '>=') {
										if (val < pr.value) {
											match_all = false;
											break;
										}
									}
									else if (pr.relation == '<=') {
										if (val > pr.value) {
											match_all = false;
											break;
										}
									}
									else {
										console.log('WARNING: unrecognized relationship ' + pr.relation);
										match_all = false;
										break;
									}
									console.log("matched!");
									matched_one = true;

								}
							}
							if (matched_one == false) {
								match_all = false;
							}
						}
					}
					else {

						//possibly don't match partial tags
						if (allow_prefix_matches == false && pr.valid_exact_tag_matches.length == 0) {
							match_all = false;
							break;
						}

						let total_matches = 0;
						for (let tag of pr.valid_exact_tag_reverse_implications) {
							if (tags_and_implications.includes(tag)) {
								total_matches++;
							}
						}

						if (allow_prefix_matches) {
							for (let tag of pr.valid_prefix_tag_reverse_implications) {
								if (tags_and_implications.includes(tag)) {
									total_matches++;
								}
							}
						}

						if (total_matches == 0) {
							match_all = false;
						}
					}
				}
				else if (pr.type == 'substring') {
					if (item.subitems[i].data.indexOf(pr.text) == -1) {
						match_all = false;
						break;
					}
				}
			}

			if (match_all == true) {
				item.subitems[i]._include = 1;
				for (let j = i+1; j < item.subitems.length; j++) {
					if (item.subitems[j].indent <= item.subitems[i].indent) {
						break;
					}
					if (item.subitems[j]._include == 0) {
						item.subitems[j]._include = 1;
					}
				}
			}
		}
 		
		//3) propagate inclusions up from children
		for (let i = 0; i < item.subitems.length; i++) {
			if (item.subitems[i]._include != 0) {
				continue;
			}

			let positive_child = false;
			for (let j = i+1; j < item.subitems.length; j++) {
				if (item.subitems[j].indent <= item.subitems[i].indent) {
					break;
				}
				if (item.subitems[j]._include == 1) {
					positive_child = true;
					break;
				}
			}
			if (positive_child) {
				item.subitems[i]._include = 1;
			}
			else {
				item.subitems[i]._include = -1;
			}
		}
 	}

	return {
		filterItemsWithParse: filterItemsWithParse,
		getIncludedTagCounts: getIncludedTagCounts,
		fullyIncludeItem: fullyIncludeItem
	}

})();