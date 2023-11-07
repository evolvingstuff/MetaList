function removeFromDOM(id) {
    console.log(`\tVDOM: remove item ${id}`);
    let element = document.getElementById(id);
    if (element && element.parentNode) {
        element.parentNode.removeChild(element);
    }
}

function addToDOM(item, container, formatter, addEvents) {
    console.log(`\tVDOM: add item ${item.id}`);
    let html = formatter(item);
    container.insertAdjacentHTML('beforeend', html);
    let element = document.getElementById(item.id);
    addEvents(element);
}

function updateInDOM(item, formatter, addEvents) {
    console.log(`\tVDOM: update item ${item.id}`);
    let element = document.getElementById(item.id);
    element.outerHTML = formatter(item);
    let newElement = document.getElementById(item.id); // Re-target the new element
    addEvents(newElement); // Now add events to the new element
}

function moveInDOM(id, newIndex, container) {
    let element = document.getElementById(id); // Replace with your element's ID
    let parent = element.parentNode;
    let children = Array.from(parent.children); // Convert HTMLCollection to Array
    let index = children.indexOf(element);
    if (index === newIndex) {
        return;
    }
    console.log(`\tVDOM: move item ${id} to index ${newIndex}`);
    let beforeElement = container.children[newIndex];
    container.insertBefore(element, beforeElement);
}


export function vdomUpdate(listOld, listNew, formatter, addEvents, container) {
    console.log('vdomUpdate()');

    const oldIndexMap = new Map(listOld.map((item, index) => [item.id, { ...item, index }]));
    const newIndexMap = new Map(listNew.map((item, index) => [item.id, index]));

    // Remove items
    listOld.forEach(item => {
        if (!newIndexMap.has(item.id)) {
            removeFromDOM(item.id);
        }
    });

    // Add/update items
    listNew.forEach(item => {
        if (!oldIndexMap.has(item.id)) {
            addToDOM(item, container, formatter, addEvents);
            moveInDOM(item.id, newIndexMap.get(item.id), container);
        }
        else {
            const oldItem = oldIndexMap.get(item.id);
            if (oldItem._version !== item._version) {
                updateInDOM(item, formatter, addEvents);
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

    console.log('/vdomUpdate()');
}

