function copyJSON(obj) {
	//TODO: look for this pattern elsewhere
	return JSON.parse(JSON.stringify(obj));
}

function getWords(text) {
	return text.replace('/',' ',).replace(/\b[-.,()&$#!\[\]{}"':]+\B|\B[-.,()&$#!\[\]{}"':]+\b/g, "").split(' ');
}