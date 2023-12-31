"use strict";


function isElementInViewport(el) {
    var rect = el.getBoundingClientRect();
    return (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
}

export function findTopmostVisibleDataId() {
    let divs = document.querySelectorAll('.subitem');
    let topmostDiv = null;
    let minTop = Infinity;
    divs.forEach(div => {
        if (isElementInViewport(div)) {
            let rect = div.getBoundingClientRect();
            if (rect.top < minTop) {
                minTop = rect.top;
                topmostDiv = div;
            }
        }
    });
    if (topmostDiv) {
        return [topmostDiv.getAttribute('data-id'), minTop];
    }
    else {
        return [null, 0];
    }
}