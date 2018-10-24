function copyJSON(obj) {
	//TODO: look for this pattern elsewhere
	return JSON.parse(JSON.stringify(obj));
}