let $hotkeys = (function() {

	//TODO: persist to local storage
	//TODO: save this when backing up data?

	let storage = {};

	function setHotKey(key, val) {
		storage[key] = val;
		localStorage.setItem('hotkeys', JSON.stringify(storage));
	}

	function getHotKey(key) {
		return storage[key];
	}

	if (localStorage.getItem('hotkeys')) {
		console.log('loading hotkeys');
		storage = JSON.parse(localStorage.getItem('hotkeys'));
	}
	else {
		console.log('no hotkeys in localStorage');
	}


	return {
		setHotKey: setHotKey,
		getHotKey: getHotKey
	}

})();