let $searchHistory = (function() {
	let _queue = [];
	function addActivatedSearch() {
		let search = $auto_complete.getSearchString().trim();
		/*
		if (search.includes('"')) {
			//do not include substring search in history
			return;
		}
		*/
		if (search == '') {
			return;
		}
		_queue.splice(0,0,search);
	}

	function getHistorySuggestions(max) {
		let search = $auto_complete.getSearchString().trim();
		let result = [];
		for (let q of _queue) {
			if (q == search || result.includes(q)) {
				continue;
			}
			result.push(q);
			if (result.length >= max) {
				break;
			}
		}
		return result;
	}

	return {
		addActivatedSearch: addActivatedSearch,
		getHistorySuggestions: getHistorySuggestions
	}

})();