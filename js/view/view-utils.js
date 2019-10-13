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

	return {
		getItemElementById: getItemElementById,
		getSubitemElementByPath: getSubitemElementByPath
	};

})();