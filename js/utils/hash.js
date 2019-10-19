"use strict";

let hashCode = function(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        hash = ((hash<<5)-hash)+c;
        hash = hash & hash;
    }
    return hash;
}