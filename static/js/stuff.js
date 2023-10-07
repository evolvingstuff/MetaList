//TODO yuck

function selectFirstItem() {
    const firstSubitem = document.querySelector('.subitem');
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
    if (firstSubitem) {
      simulateClick(firstSubitem);
      simulateMousedown(firstSubitem);

        // Focus the div
        //firstSubitem.focus();

        setTimeout(() => {
            firstSubitem.setAttribute('contentEditable', 'true');
  firstSubitem.focus();
  console.log("Element focused:", document.activeElement === firstSubitem);
}, 0);

    }
}
