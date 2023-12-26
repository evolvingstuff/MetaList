'use strict';

class ChatUi extends HTMLElement {

    constructor() {
        super();
        this.myId = null;
    }

    render() {
        let html = `
            <img id="my-chat-icon" class="chat-icon" src="../../img/chat-left-svgrepo-com.svg"/>
            <div id="chatModal" class="modal">
                <div class="modal-content">
                    <span class="close">&times;</span>
                    <div id="chatMessages" class="chat-messages"></div>
                    <textarea id="chatInput" placeholder="Type a message..."></textarea>
                    <hr>
                    <button id="sendMessage">Send</button>
                </div>
            </div>`;
        this.innerHTML = html;
    }

    attachEventHandlers() {

        let openBtn = document.getElementById('my-chat-icon');
        let modal = document.getElementById("chatModal");
        let modalContent = document.getElementsByClassName("modal-content")[0];
        let closeBtn = document.getElementsByClassName("close")[0];
        //let chatInput = document.getElementById('chatInput');
        let sendMessage = document.getElementById('sendMessage');

        let eventsToContain = ['mousedown', 'keypress'];

        for (let eventName of eventsToContain) {
            modalContent.addEventListener(eventName, (evt) => {
                evt.stopPropagation();
            });
        }

        modalContent.addEventListener('wheel', (evt) => {
            // evt.preventDefault(); // Prevent scrolling the background
            // evt.stopPropagation(); // Stop the event from bubbling up
            if (evt.target.id !== 'chatInput') { // Check if the target is not the textarea
                evt.preventDefault(); // Prevent scrolling the background
                evt.stopPropagation(); // Stop the event from bubbling up
            }
        }, { passive: false });

        closeBtn.addEventListener('mousedown', (evt) => {
            modal.style.display = "none";
            openBtn.style.display = "flex";
            console.log('debug: close...');
        });

        window.addEventListener('click', (evt) => {
            if (evt.target == modal) {
                modal.style.display = "none";
                openBtn.style.display = "flex";
            }
        });

        openBtn.addEventListener('mousedown', (evt) => {
            evt.stopPropagation();
            evt.preventDefault();
            modal.style.display = "block";
            openBtn.style.display = "none";
        });

        sendMessage.addEventListener('click', (evt) => {
            alert('Send message!');
        });

        ///////////////////////////

        const focusableElements = modalContent.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        const firstFocusableElement = focusableElements[0];
        const lastFocusableElement = focusableElements[focusableElements.length - 1];

        console.log('First focusable element:', firstFocusableElement);
        console.log('Last focusable element:', lastFocusableElement);


        modalContent.addEventListener('keydown', (evt) => {
            evt.stopPropagation();
            if (evt.key === 'Tab') {
                if (evt.shiftKey) {
                    if (document.activeElement === firstFocusableElement) {
                        lastFocusableElement.focus();
                        evt.preventDefault();
                    }
                } else {
                    if (document.activeElement === lastFocusableElement) {
                        firstFocusableElement.focus();
                        evt.preventDefault();
                    }
                }
            }
        });
    }

    connectedCallback() {
        this.myId = this.getAttribute('id');
        this.render();
        this.attachEventHandlers();
    }

    disconnectedCallback() {
        //TODO remove event listeners
    }
}

customElements.define('chat-ui', ChatUi);