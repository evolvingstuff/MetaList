let $spacedRep = (function() {

	let FACTOR = 1.1;
	let SESSION_FACTOR = 2; //This is a session-dependent discount factor
	let counter = 0;
	let DO_PERSIST = false; //Not doing it for now while still developing

	let values = {};
	if (DO_PERSIST) {
		if (localStorage.getItem('spacedRep') != undefined && localStorage.getItem('spacedRep') != null) {
			values = JSON.parse(localStorage.getItem('spacedRep'));
			console.log('loaded spaced rep data');
		}
		else {
			console.log('initializing spaced rep data');
			localStorage.setItem('spacedRep', JSON.stringify(values));
		}
	}
	else {
		console.log("not currently persisting spaced repetition data");
	}

	let session_values = {};

	function getRandomInt(max) {
	  return Math.floor(Math.random() * Math.floor(max));
	}

	function next(items) {
		counter++;
		let filtered_items = [];
		for (let item of items) {
			if (item._include == 1) {
				if (values[item.id] == undefined) {
					values[item.id] = 1.0;
				}
				if (session_values[item.id] == undefined) {
					session_values[item.id] = 1.0;
				}
				filtered_items.push(item);
			}
		}

		filtered_items.sort(function(a, b) {
			if (values[b.id]*session_values[b.id] == values[a.id]*session_values[a.id]) {
				return a.priority - b.priority;
			}
			return values[b.id]*session_values[b.id] - values[a.id]*session_values[a.id];
		});
		console.log('pick highest rating of ' + (values[filtered_items[0].id]*session_values[filtered_items[0].id]));
		let item = filtered_items[0];
		session_values[item.id] /= SESSION_FACTOR;
		return item;
	}

	function rate(item, rating) {
		if (rating < 0) {
			values[item.id] /= FACTOR;
		}
		else if (rating > 0) {
			values[item.id] *= FACTOR;
		}
		console.log('rate item: ' + item.id + ' -> ' + values[item.id]);
		if (DO_PERSIST) {
			localStorage.setItem('spacedRep', JSON.stringify(values));
		}
	}

	return {
		next: next,
		rate: rate
	}
})();