'use strict';

let $simpleLock = (function() {

	const CHECK_EVERY_K_MS = 100;
	let token = null;
	let modeCheckValidate = false;

	function updateToken() {
		//http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript
 		token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
 		localStorage.setItem('token', token);
	}

	function validateToken() {
		if (modeCheckValidate === false) {
			return;
		}
		try {
			let storedToken = localStorage.getItem('token');
			// if (storedToken === null) {
			// 	throw "No stored token";
			// }
			// if (token === null) {
			// 	throw "No in-memory token";
			// }
			if (storedToken === null || token === null) {
				console.log(`pre:  storedToken = ${storedToken} / token = ${token}`);
				updateToken();
				console.log(`post: storedToken = ${storedToken} / token = ${token}`);
				return;
			}

			if (token !== storedToken) {
				throw "Mismatch between stored and in-memory token";
			}
		}
		catch (e) {
			console.log(e);
			getToken();
			$view.gotoErrorPageLocked();
		}
	}

	function getToken() {
		token = localStorage.getItem('token');
		if (token === null) {
			token = updateToken();
		}
		modeCheckValidate = true;
		return token;
	}

	setInterval(validateToken, CHECK_EVERY_K_MS);

	return {
		updateToken: updateToken,
		validateToken: validateToken,
		getToken: getToken
	}

})();