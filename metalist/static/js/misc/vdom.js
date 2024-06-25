"use strict";


const hash_identifier = '_hash';


function removeFromDOM(id) {
    let element = document.getElementById(id);
    if (element && element.parentNode) {
        element.parentNode.removeChild(element);
    }
}

function addToDOM(item, container, newHtml) {
    container.insertAdjacentHTML('beforeend', newHtml);
}

// function updateInDOM(item, formatter) {
//     let element = document.getElementById(item.id);
//     if (element) {
//         element.outerHTML = formatter(item);
//         return true;
//     }
//     return false;
// }

function updateInDOM(item, newHtml) {
    let element = document.getElementById(item.id);
    if (element) {
        element.outerHTML = newHtml;
        return true;
    }
    return false;
}

function moveInDOM(id, newIndex, container) {
    let element = document.getElementById(id); // Replace with your element's ID
    let parent = element.parentNode;
    let children = Array.from(parent.children); // Convert HTMLCollection to Array
    let index = children.indexOf(element);
    if (index === newIndex) {
        return;
    }
    let beforeElement = container.children[newIndex];
    container.insertBefore(element, beforeElement);
}


export function vdomUpdate(listOld, listNew, formatter, container) {

    try {

        const oldIndexMap = new Map(
            listOld.map((item, index) => [item.id, {...item, index}]));
        const newIndexMap = new Map(
            listNew.map((item, index) => [item.id, index]));

        // Remove items
        listOld.forEach(item => {
            if (!newIndexMap.has(item.id)) {
                removeFromDOM(item.id);
            }
        });

        // Add/update items
        listNew.forEach(item => {
            let newHtml = formatter(item);
            if (!oldIndexMap.has(item.id)) {
                addToDOM(item, container, newHtml);
                moveInDOM(item.id, newIndexMap.get(item.id), container);
            } else {
                const oldItem = oldIndexMap.get(item.id);
                //TODO: we should do caching here, this is a performance bottleneck.
                // Why are we doing this?
                // ----------------------
                // The reason we are doing this is because the _hash calculated on the server
                // does not account for _match, because it wants to remain agnostic to changes
                // in the view based on the search filters. So we instead igore the _hash here
                // and use the generated html to compare the two items. This avoids subtle bugs
                // involving state.

                let oldHtml = formatter(oldItem);
                if (newHtml !== oldHtml) {
                    let updated = updateInDOM(item, newHtml);
                    if (updated === false) {  //TODO: revisit this case...
                        addToDOM(item, container, newHtml);
                        moveInDOM(item.id, newIndexMap.get(item.id), container);
                    }
                }
            }
        });

        // TODO: implement Longest Increasing Subsequence optimization for moving items
        // Move items
        listNew.forEach(item => {
            if (!oldIndexMap.has(item.id)) {
                return;
            }
            const oldItem = oldIndexMap.get(item.id);
            if (oldItem.index !== newIndexMap.get(item.id)) {
                moveInDOM(item.id, newIndexMap.get(item.id), container);
            }
        });
    }
    catch (e) {
        console.log(e);
        debugger;
    }
}

