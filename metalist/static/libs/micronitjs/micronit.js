const categoryContainer = {
  name: "",
  units: "",
  addUnit(class_, value) {
    categoryContainer.units += `<div class=${class_}>${value}</div>`;
  },
  addToPage() {
    micronit.innerHTML += `<div class=units>
                            <h2 class=category>${categoryContainer.name}</h2>
                            ${categoryContainer.units}
                           </div>`;

    // Needed for correct generation of the next category
    categoryContainer.units = "";
  },
};

const unit = {
  test(tests) {
    document.addEventListener("DOMContentLoaded", () => {
      document.head.innerHTML += `
      <style>
        #micronit {
          color: #111;
        }
        
        h2 {
          margin-bottom: 0;
        }
        
        .unit-passed:before {
          content: "✔ ";
          color: #2ECC40;
        }
        
        .unit-failed:before {
          content: "✖ ";
          color: #FF4136;
        }
        
        .unit-error,
        .unit-error-stack {
          margin-left: 3ch;
          /* Needed to preserve error stack newlines */
          white-space: pre-line;
        }
      </style>`;
      for (const category in tests) {
        categoryContainer.name = category;
        for (let unit in tests[category]) {
          let unitName = unit;
          let unitFunction = tests[category][unit];
          try {
            unitFunction();/*✔*/
            categoryContainer.addUnit(`unit-passed`, unitName);
          }
          catch (error) {
            categoryContainer.addUnit(`unit-failed`, unitName);
            categoryContainer.addUnit("unit-error", error);
            categoryContainer.addUnit("unit-error-stack", error.stack);
            /*✖*/
          }
        }
        categoryContainer.addToPage();
      }
    });
  },

  assert: (expression, message) => {
    if (!expression) unit.fail(message);
  },

  assertEqual: (expected, actual) => {
    if (expected != actual) unit.fail(`${expected} !== ${actual}`)
  },

  assertNotEqual: (expected, actual) => {
    if (expected == actual) unit.fail(`${expected} === ${actual}`)
  },

  assertStrictEqual: (expected, actual) => {
    if (expected !== actual) unit.fail(`${expected} !== ${actual}`)
  },

  assertNotStrictEqual: (expected, actual) => {
    if (expected === actual) unit.fail(`${expected} === ${actual}`)
  },

  assertTrue: object => {
    if (object !== true) unit.fail(`${object} !== true`)
  },

  assertFalse: object => {
    if (object !== false) unit.fail(`${object} !== false`)
  },

  fail: message => {
    throw new Error(message);
  },

};
