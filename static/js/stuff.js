//TODO yuck

function selectItemSubitemIntoEditMode(itemSubitemId) {
    const subitem = document.querySelector(`.subitem[data-id="${itemSubitemId}"]`);
    // Function to simulate a click event
    const simulateClick = (element) => {
        console.log('simulateClick');
        const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window
      });
      element.dispatchEvent(event);
    };

    const simulateMousedown = (element) => {
        console.log('simulateMousedown');
        const event = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        view: window
      });
      element.dispatchEvent(event);
    };

    // Trigger the click event twice
    if (subitem) {
        simulateClick(subitem);
        simulateMousedown(subitem); //TODO: experiment to see if this is still needed
        setTimeout(() => {
            subitem.setAttribute('contentEditable', 'true');
            subitem.focus();
            console.log("Element focused:", document.activeElement === subitem);
        }, 0);
    }
}
