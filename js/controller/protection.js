let $protection = (function(){

	let password = null;

	function getModeProtected() {
		if (password == null || password == '') {
			return false;
		}
		return true;
	}

	function setPassword(newPassword) {
		if (password == null) {
			if (newPassword == null || newPassword == '') {
				//do nothing?
			}
			else {
				//alert('added new password -> ' + newPassword);
			}
		}
		else {
			if (newPassword == null || newPassword == '') {
				//alert('removed password');
			}
			else {
				//alert('updated password '+password+' -> ' + newPassword);
			}
			
		}
		password = newPassword;
		$todo.onUpdateProtection();
	}

	function getPassword() {
		return password;
	}

	function lockSession() {

	}

	return {
		getModeProtected: getModeProtected,
		setPassword: setPassword,
		getPassword: getPassword,
		lockSession: lockSession
	}
})();