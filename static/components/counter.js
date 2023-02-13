class MyCounter extends HTMLElement {

  constructor() {
    super();
    this.count = 0;
    // this.my_id = this.getAttribute('id');
    // console.log(`my id is ${this.my_id}`);

    PubSub.subscribe('counter.reset', (msg, data) => {
      if (data.id === this.my_id) {
        this.reset();
      }
    });
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

  reset() {
    //console.log(`resetting ${this.my_id}`);
    this.count = 0;
    this.render();
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
    this.my_id = this.getAttribute('id');
    this.render()
  }

}

customElements.define('my-counter', MyCounter);
