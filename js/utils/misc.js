function copyJSON(obj) {
	//TODO: look for this pattern elsewhere
	return JSON.parse(JSON.stringify(obj));
}

function getWords(text) {
	text = text.replace('/',' ').replace('(',' ').replace(')',' ').replace('-',' ').replace('_',' ');
	return text.replace(/\b[-.,()&$#!\[\]{}"':]+\B|\B[-.,()&$#!\[\]{}"':]+\b/g, "").split(' ');
}