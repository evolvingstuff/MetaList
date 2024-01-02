"use strict";


const hash_identifier = '_hash';


function removeFromDOM(id) {
    let element = document.getElementById(id);
    if (element && element.parentNode) {
        element.parentNode.removeChild(element);
    }
}

function addToDOM(item, container, formatter) {
    let html = formatter(item);
    container.insertAdjacentHTML('beforeend', html);
}

function updateInDOM(item, formatter) {
    let element = document.getElementById(item.id);
    if (element) {
        element.outerHTML = formatter(item);
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
            if (!oldIndexMap.has(item.id)) {
                addToDOM(item, container, formatter);
                moveInDOM(item.id, newIndexMap.get(item.id), container);
            } else {
                const oldItem = oldIndexMap.get(item.id);
                if (oldItem[hash_identifier] !== item[hash_identifier]) {
                    let updated = updateInDOM(item, formatter);
                    if (updated === false) {  //TODO: revisit this case...
                        addToDOM(item, container, formatter);
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

