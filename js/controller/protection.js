"use strict";

let $protection = (function(){

	let password = null;

	function getModeProtected() {
		if (password === null || password === '') {
			return false;
		}
		return true;
	}

	function setPassword(newPassword) {
		password = newPassword;
	}

	function getPassword() {
		return password;
	}

	function lockSession() {
		//TODO remove?
	}

	return {
		getModeProtected: getModeProtected,
		setPassword: setPassword,
		getPassword: getPassword,
		lockSession: lockSession
	}
})();