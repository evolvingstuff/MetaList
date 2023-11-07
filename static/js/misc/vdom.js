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
    container.insertAdjacentHTML('afterbegin', html);
    let element = document.getElementById(item.id);
    addEvents(element);
}

function updateInDOM(item, formatter, addEvents) {
    console.log(`\tVDOM: update item ${item.id}`);
    let updatedHtml = formatter(item);
    let element = document.getElementById(item.id);
    element.outerHTML = updatedHtml;
    addEvents(element);
}

function moveInDOM(id, newIndex) {
    console.log(`\tVDOM: move item ${id} to index ${newIndex}`);
    let element = document.getElementById(id);
    let container = document.getElementById('container'); // Assuming you have a container element with id 'container'
    if (element && container) {
        container.removeChild(element); // Remove the element from its current position
        let beforeElement = container.children[newIndex]; // Get the element that will be just after the new position
        container.insertBefore(element, beforeElement); // Insert the element at the new position
    }
}

export function vdomUpdate(listOld, listNew, formatter, addEvents, container) {
  const oldIndexMap = new Map(listOld.map((item, index) => [item.id, { ...item, index }]));
  const newIndexMap = new Map(listNew.map((item, index) => [item.id, index]));

  // Remove items
  listOld.forEach(item => {
    if (!newIndexMap.has(item.id)) {
      removeFromDOM(item.id);
    }
  });

  //TODO: implement Longest Increasing Subsequence optimization for moving items

  // Add/Update items
  listNew.forEach(item => {
    const oldItem = oldIndexMap.get(item.id);
    if (oldItem) {
      // If the item exists but the version is different, update it
      if (oldItem._version !== item._version) {
        updateInDOM(item, formatter, addEvents);
      }
      // Keep track of items that have moved
      if (oldItem.index !== newIndexMap.get(item.id)) {
        moveInDOM(item.id, newIndexMap.get(item.id));
      }
    } else {
      // If the item is new, add it
      addToDOM(item, container, formatter, addEvents);
    }
  });
}

