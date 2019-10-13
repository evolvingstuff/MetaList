let $viewUtils = (function () {
	
	function getItemElementById(id) {
		let query = '[data-item-id="'+id+'"]';
		let el = $(query)[0];
		return el;
	}

	function getSubitemElementByPath(path) {
		let query = '[data-subitem-path="'+path+'"]';
		let el = $(query)[0];
		return el;
	}

	function getItemTagSuggestionsElementById(id) {
		let div = getItemElementById(id);
        let sugg = $(div).find('.tag-suggestions')[0];
        return sugg;
	}

	function getItemTagElementById(id) {
		let div = getItemElementById(id);
        let sugg = $(div).find('.tag')[0];
        return sugg;
	}

	return {
		getItemElementById: getItemElementById,
		getSubitemElementByPath: getSubitemElementByPath,
		getItemTagSuggestionsElementById: getItemTagSuggestionsElementById,
		getItemTagElementById: getItemTagElementById
	};

})();