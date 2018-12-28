function copyJSON(obj) {
	//TODO: look for this pattern elsewhere
	return JSON.parse(JSON.stringify(obj));
}

function getWords(text) {
	text = text.replace('/',' ').replace('(',' ').replace(')',' ').replace('-',' ').replace('_',' ');
	return text.replace(/\b[-.,()&$#!\[\]{}"':]+\B|\B[-.,()&$#!\[\]{}"':]+\b/g, "").split(' ');
}

function replaceAll(str, a, b) {
	re = new RegExp(a, "g");
	return str.replace(a, b)
}

//TODO: perhaps move this to NLP folder?
function getNumberlikeElements(text) {
	text = $format.toText(text);
	let result = [];
	text = text.replace(',','').
		replace('/',' ').
		replace('(',' ').
		replace(')',' ').
		replace('_',' ').
		replace('$',' ');
	words = text.split(' ');
	for (let word of words) {
		if (word == '' || isNaN(word)) {
			continue;
		}
		console.log('\t word = "'+word+'"')
		if (word.includes('.')) {
			result.push(parseFloat(word));
		}
		else {
			result.push(parseInt(word));
		}
	}
	if (result.length > 0) {
		console.log('Numberlike results:');
		console.log(result);
	}
	return result;
}