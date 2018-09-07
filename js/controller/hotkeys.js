let $hotkeys = (function() {

	//TODO: persist to local storage
	//TODO: save this when backing up data?

	let storage = {};

	function setHotKey(key, val) {
		storage[key] = val;
	}

	function getHotKey(key) {
		return storage[key];
	}


	return {
		setHotKey: setHotKey,
		getHotKey: getHotKey
	}

})();