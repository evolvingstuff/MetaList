"use strict";

/* Uses publish/subscribe model */

let $radiotower = (function() {

	// create a function to subscribe to topics
	var mySubscriber = function (msg, data) {
	    console.log('---> ' + msg + ' ' + JSON.stringify(data));
	};

	// add the function to the list of subscribers for a particular topic
	// we're keeping the returned token, in order to be able to unsubscribe
	// from the topic later on
	var token = PubSub.subscribe('$model', mySubscriber);

	// publish a topic asynchronously
	//PubSub.publish('$model.hello', 'hello world!');
	
	function helloOutThere(message) {
		console.log('Hello: ' + message);
	}

	return {
		helloOutThere: helloOutThere
	}

})();