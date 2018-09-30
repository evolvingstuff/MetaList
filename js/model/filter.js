'use strict';

let $filter = (function() {

	let SHOW_ALL_IF_NO_SEARCH_SELECTED = true;

	let total_included = 0;
	let total_excluded = 0;
	let total_undecided = 0;
	let total_headless = 0;
	let total_headless_post = 0;

	function filterItemsWithParse(items, parse_results, allow_prefix_matches) {

		_resetIncludes(items);

		total_included = 0;
		total_excluded = 0;
		total_undecided = 0;
		total_headless = 0;
		total_headless_post = 0;

		if (parse_results.length == 0) {
			for (let item of items) {
				_filterItemWithNoParseResults(item);
			}
		}
		else {
			for (let item of items) {
				_filterItemWithParseResults(item, parse_results, allow_prefix_matches);
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

    function _filterItemWithNoParseResults(item) {

		if (SHOW_ALL_IF_NO_SEARCH_SELECTED) {
			for (let sub of item.subitems) {
				sub._include = 1;
				total_included++;
			}
		}
		else {
			if (item._tags.length == 0) {
				for (let sub of item.subitems) {
					sub._include = 1;
					total_included++;
				}
			}
			else {
				for (let sub of item.subitems) {
					sub._include = -1;
					total_excluded++;
				}
			}
		}
	}

	function _filterItemWithParseResults(item, parse_results, allow_prefix_matches) {
		
		for (let pr of parse_results) {
			
			if (pr.negated) {
				if (pr.type == 'tag') {
					for (let sub of item.subitems) {
						if (sub._include == -1) {
							continue;
						}
						for (let tag of pr.valid_exact_tag_reverse_implications) {
							if (sub._tags.includes(tag)) {
								sub._include = -1;
								break;
							}
						}
					}
				}
				else if (pr.type == 'substring') {
					//TODO: should we negate partially entered strings?
					for (let sub of item.subitems) {
						if (sub._include == -1) {
							continue;
						}
						if (sub.data.indexOf(pr.text) != -1) {
							sub._include = -1;
						}
					}
				}
			}
			else {
				if (pr.type == 'tag') {
					for (let sub of item.subitems) {
						if (sub._include == -1) {
							continue;
						}
						let match_at_least_one = false;
						for (let tag of pr.valid_exact_tag_reverse_implications) {
							if (sub._tags.includes(tag)) {
								match_at_least_one = true;
								break;
							}
						}
						//Comment: okay to match on valid tag prefixes or implications
						if (allow_prefix_matches) {
							for (let tag of pr.valid_prefix_tag_reverse_implications) {
								if (sub._tags.includes(tag)) {
									match_at_least_one = true;
									break;
								}
							}
						}
						else {
							for (let tag of pr.valid_exact_tag_reverse_implications) {
								if (sub._tags.includes(tag)) {
									match_at_least_one = true;
									break;
								}
							}
						}
						
						if (match_at_least_one == true) {
							sub._include = 1;
						}
						else {
							sub._include = -1;
						}
					}
				}
				else if (pr.type == 'substring') {
					for (let sub of item.subitems) {
						if (sub._include == -1) {
							continue;
						}
						if (sub.data.indexOf(pr.text) == -1) {
							sub._include = -1;
						}
						else {
							sub._include = 1;
						}
					}
				}
			}
		}

		for (let sub of item.subitems) {
			if (sub._include == 1){
				total_included++;
			}
			else if (sub._include == -1) {
				total_excluded++;
			}
			else if (sub._include == 0) {
				total_undecided++;
			}
		}

		//Now need to do item bubbling, because there may be some subitems selected for without the parent item
		//Included nodes bubble inclusion to the top
		let headless = false;
		if (item.subitems[0]._include == -1) {
			for (let i = 1; i < item.subitems.length; i++) {
				if (item.subitems[i]._include == 1) {
					headless = true;
					break;
				}
			}
		}
		if (headless) {
			total_headless++;
		}



		for (let i = item.subitems.length-1; i >= 0; i--) {
			if (item.subitems[i]._include == 1) {
				for (let j = i-1; j >= 0; j--) {
					if (item.subitems[j].indent < item.subitems[i].indent) {
						item.subitems[j]._include = 1;
					}
				}
			}
		}

		headless = false;
		if (item.subitems[0]._include == -1) {
			for (let i = 1; i < item.subitems.length; i++) {
				if (item.subitems[i]._include == 1) {
					headless = true;
					break;
				}
			}
		}
		if (headless) {
			total_headless_post++;
		}
	}

	function _resetIncludes(items) {
		for (let item of items) {
			for (let sub of item.subitems) {
				sub._include = 0;
			}
		}
	}

	return {
		filterItemsWithParse: filterItemsWithParse,
		getIncludedTagCounts: getIncludedTagCounts,
		fullyIncludeItem: fullyIncludeItem
	}

})();