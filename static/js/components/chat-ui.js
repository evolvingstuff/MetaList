'use strict';


import { openAiModel } from '../config.js';

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
        let sendMessage = document.getElementById('sendMessage');

        let eventsToContain = ['mousedown', 'keypress'];

        for (let eventName of eventsToContain) {
            modalContent.addEventListener(eventName, (evt) => {
                evt.stopPropagation();
            });
        }

        modalContent.addEventListener('wheel', (evt) => {
            if (evt.target.id !== 'chatInput') { // Check if the target is not the textarea
                evt.preventDefault(); // Prevent scrolling the background
                evt.stopPropagation(); // Stop the event from bubbling up
            }
        }, { passive: false });

        closeBtn.addEventListener('mousedown', (evt) => {
            modal.style.display = "none";
            openBtn.style.display = "flex";
            document.body.style.cursor = 'default';
        });

        window.addEventListener('click', (evt) => {
            if (evt.target == modal) {
                modal.style.display = "none";
                openBtn.style.display = "flex";
                document.body.style.cursor = 'default';
            }
        });

        openBtn.addEventListener('mousedown', (evt) => {
            evt.stopPropagation();
            evt.preventDefault();
            const apiKey = this.actionGetApiKey();
            if (apiKey === null) {
                return;
            }
            modal.style.display = "block";
            openBtn.style.display = "none";
        });

        sendMessage.addEventListener('click', (evt) => {
            this.actionSendMessage();
        });

        const focusableElements = modalContent.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        const firstFocusableElement = focusableElements[0];
        const lastFocusableElement = focusableElements[focusableElements.length - 1];

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


    /**
     * This will test to see if we already have an OpenAI key for the user.
     * TODO:
     *  This is NOT yet safe or secure, and will need to be rewritten, as it
     *  stores the key in localStorage of the browser. This is strictly for
     *  temporary development purposes.
     */
    actionGetApiKey() {
        let apiKey = localStorage.getItem("API_KEY");
        if (!apiKey) {
            apiKey = prompt("Please enter your API key:");
            if (apiKey) {
                localStorage.setItem("API_KEY", apiKey);
            } else {
                console.warn("API key is required.");
            }
        }
        return apiKey;
    }

    async actionSendMessage() {
        const token = this.actionGetApiKey();
        if (token === null) {
            alert('This requires an API key');
            return;
        }
        let chatInput = document.getElementById('chatInput');
        let prompt = chatInput.value;
        console.log('prompt:');
        console.log(prompt);
        try {
            document.body.style.cursor = 'wait';
            let messages = [{role: 'user', content: prompt}]; //TODO: extend conversation
            this.actionRenderMessages(messages);
            const responseMessage = await this.callOpenAI(token, messages);
            document.body.style.cursor = 'default';
            console.log(responseMessage);
            messages.push(responseMessage);
            this.actionRenderMessages(messages);
        } catch (error) {
            document.body.style.cursor = 'default';
            console.error('Error:', error);
            alert(`Error: ${error['message']}`);
        }
    }

    actionRenderMessages(messages) {
        const chatInput = document.getElementById('chatInput');
        chatInput.value = '';
        const chatMessages = document.getElementById('chatMessages');
        let history = '';
        for (let message of messages) {
            let formattedContent = message.content.replace(/\n/g, '<br>');
            if (message.role === 'user') {
                history += `
                    <div class="message user-message">
                        <!--<span class="avatar user-avatar"></span>-->
                        <span>${formattedContent}</span>
                    </div>`;
            }
            else {
                history += `
                    <div class="message assistant-message">
                        <!--<span class="avatar assistant-avatar"></span>-->
                        <span>${formattedContent}</span>
                    </div>`;
            }
        }
        chatMessages.innerHTML = history;
    }

    async callOpenAI(token, messages) {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: openAiModel,
                messages: messages
            })
        });
        const result = await response.json();
        console.log(result);
        const message = result.choices && result.choices[0] ? result.choices[0].message : null;
        return message;
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