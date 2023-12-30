"use strict";


const originalSubscribe = PubSub.subscribe;
const originalPublish = PubSub.publish;
const originalPublishSync = PubSub.publishSync;

PubSub.subscribe = function(topic, func) {
    //console.log(`Subscribing to topic: ${topic}`);
    let wrappedFunc = function() {
        //console.log(`    <<< Subscriber called for topic ${topic}`)
        return func.apply(this, arguments);
    }
    return originalSubscribe.call(this, topic, wrappedFunc);
};

PubSub.publish = function(topic, data) {
    //console.log(`  >>> Publishing (async) to topic: ${topic}`);
    return originalPublish.apply(this, arguments);
};

PubSub.publishSync = function(topic, data) {
    //console.log(`  >>> Publishing (sync) to topic: ${topic}`);
    return originalPublishSync.apply(this, arguments);
};