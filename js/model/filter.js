'use strict';

let $search2 = (function() {

	let SHOW_ALL_IF_NO_SEARCH_SELECTED = true;

	let total_included = 0;
	let total_excluded = 0;
	let total_undecided = 0;
	let total_headless = 0;
	let total_headless_post = 0;

	function filterItemsWithParse(parse_results, allow_prefix_matches) {

		let items = $model.getItems();

		_decorateTags(items);
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

		//asdf
	}

	//TODO: this should be cached!
	function getIncludedTagCounts() {
		let items = $model.getItems();
		let implications = $ontology.getImplications();
		_decorateTags(items); //just in case
		let all_tags = {};
        for (let item of items) {
        	if (item._include == -1) {
        		continue;
        	}
            let flat = $model.enumerate(item);
            for (let sub of flat) {
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
        var list = [];
        for (var key in all_tags) {
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
    	decorateItemTags(item);
        let flat = $model.enumerate(item);
        if (item._tags.length == 0) {
            for (let sub of flat) {
                sub._include = 1;
            }
        }
    }


    function _filterItemWithNoParseResults(item) {

		let flat = $model.enumerate(item);

		if (SHOW_ALL_IF_NO_SEARCH_SELECTED) {
			for (let sub of flat) {
				sub._include = 1;
				total_included++;
			}
		}
		else {
			if (item._tags.length == 0) {
				for (let sub of flat) {
					sub._include = 1;
					total_included++;
				}
			}
			else {
				for (let sub of flat) {
					sub._include = -1;
					total_excluded++;
				}
			}
		}

		
	}

	function _filterItemWithParseResults(item, parse_results, allow_prefix_matches) {

		let flat = $model.enumerate(item);
		
		for (let pr of parse_results) {
			
			if (pr.negated) {
				if (pr.type == 'tag') {
					for (let sub of flat) {
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
					for (let sub of flat) {
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
					for (let sub of flat) {
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
					for (let sub of flat) {
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

		for (let sub of flat) {
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
		if (flat[0]._include == -1) {
			for (let i = 1; i < flat.length; i++) {
				if (flat[i]._include == 1) {
					headless = true;
					break;
				}
			}
		}
		if (headless) {
			total_headless++;
		}

		function _bubble(item) {
			if (item._include == -1) {
				for (let sub of item.subitems) {
					if (_bubble(sub) == 1) {
						item._include = 1;
						break;
					}
				}
			}
			return item._include;
		}

		_bubble(item);

		headless = false;
		if (flat[0]._include == -1) {
			for (let i = 1; i < flat.length; i++) {
				if (flat[i]._include == 1) {
					headless = true;
					break;
				}
			}
		}
		if (headless) {
			total_headless_post++;
		}
	}

	function _resetIncludes() {
		for (let item of $model.getItems()) {
			_resetItemIncludes(item);
		}
	}

	function _resetItemIncludes(item) {
        item._include = 0;
        for (let subitem of item.subitems) {
            _resetItemIncludes(subitem);
        }
    }

    function _decorateTags(items) {
    	for (let item of items) {
    		if (item._dirty_tags == false) {
    			continue;
    		}
    		decorateItemTags(item);
    		item._dirty_tags = false;
    	}
    }

    let _cache_is_valid = {};
    let re = new RegExp("^([a-z0-9A-Z_#@][a-z0-9A-Z-_./:#@!+'&]*)$");

    //TODO: move into parser code?
    function isAValidTag(content) {
    	if (_cache_is_valid[content] != undefined) {
    		return _cache_is_valid[content];
    	}

		if (re.test(content)) {
			_cache_is_valid[content] = true;
			return true;
		}
		else {
			//console.log('WARNING: "'+content+'" is not a valid tag');
			_cache_is_valid[content] = false;
			return false;
		}
    }

    function decorateItemTags(item, parent_tags = []) {
    	item._tags = [];
    	if (item.tags != undefined) {
	    	let tags = item.tags.trim().split(' ');
	    	for (let tag of tags) {
	    		if (tag.trim() != '') {
	    			let content = tag.trim();
	    			if (isAValidTag(content) && item._tags.includes(content) == false) {
	    				item._tags.push(content);
	    			}
	    		}
	    	}
    	}

    	for (let tag of parent_tags) {
    		if (item._tags.includes(tag) == false) {
    			item._tags.push(tag);
    		}
    	}

    	//If contains @meta, then we want to add all valid tags within the item.data itself
    	if (item._tags.includes('@meta')) {
    		let text = $format.toText(item.data);
    		for (let line of text.split('\n')) {
	    		for (let part of line.split(' ')) {
	    			let content = part.trim();
	    			if (isAValidTag(content) && item._tags.includes(content) == false) {
	    				item._tags.push(content);
	    			}
	    		}
	    	}
    	}

    	for (let subitem of item.subitems) {
    		decorateItemTags(subitem, item._tags);
    	}
    }

    function alwaysShowSelectedItemInFull(selectedItemId) {
    	if (selectedItemId == null) {
    		return;
    	}
    	let item = $model.getItemById(selectedItemId);
    	let flat = $model.enumerate(item);
    	for (let sub of flat) {
    		sub._include = 1;
    	}
    }

	return {
		filterItemsWithParse: filterItemsWithParse,
		getIncludedTagCounts: getIncludedTagCounts,
		alwaysShowSelectedItemInFull: alwaysShowSelectedItemInFull,
		decorateItemTags: decorateItemTags,
		fullyIncludeItem: fullyIncludeItem
	}

})();