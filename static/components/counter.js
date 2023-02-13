class MyCounter extends HTMLElement {

  constructor() {
    super();
    this.count = 0;
  }

  render() {
    this.innerHTML = `
      <style>
        my-counter {
          font-size: 200%;
        }

        my-counter span {
          width: 4rem;
          display: inline-block;
          text-align: center;
        }

        my-counter button {
          width: 64px;
          height: 64px;
          border: none;
          border-radius: 10px;
          background-color: seagreen;
          color: white;
        }
      </style>

      <button id="dec">-</button>
      <span>${this.count}</span>
      <button id="inc">+</button>

    `;
    this.querySelector('#inc').addEventListener('click', () => this.inc());
    this.querySelector('#dec').addEventListener('click', () => this.dec());
  }

  inc() {
    this.count++;
    this.render();
  }

  dec() {
    this.count--;
    this.render();
  }

  connectedCallback() {
    this.render()
  }

}

customElements.define('my-counter', MyCounter);
