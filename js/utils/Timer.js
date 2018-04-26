'use strict';

class Timer {
	constructor(name='Timer') {
		this._name = name;
		this._start = Date.now();
	}

	end() {
		this._end = Date.now();
	}

	display() {
		console.log(this._name + ': ' + (this._end-this._start) + 'ms');
	}
}