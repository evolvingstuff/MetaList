///////////////////////////////////////////////////////
// Store the original subscribe function in a variable
const originalSubscribe = PubSub.subscribe;

// Replace the original function with a new function that includes logging
PubSub.subscribe = function(topic, func) {
    console.log(`Subscribing to topic: ${topic}`);

    // Wrap the function being passed with additional logging
    let wrappedFunc = function() {
        //console.log(`Function called with arguments: ${JSON.stringify(arguments)}`);
        console.log(`    <<< Subscriber called for topic ${topic}`)
        return func.apply(this, arguments);
    }

    // Call the original function with the wrapped function
    return originalSubscribe.call(this, topic, wrappedFunc);
};

// Store the original publish function in a variable
const originalPublish = PubSub.publish;

// Replace the original function with a new function that includes logging
PubSub.publish = function(topic, data) {
    console.log(`  >>> Publishing to topic: ${topic}`); // with data: ${JSON.stringify(data)}`);

    // Call the original function
    return originalPublish.apply(this, arguments);
};