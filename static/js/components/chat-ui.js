'use strict';


import {callOpenAI, generatePrompt} from '../misc/LLMs.js';
import { promptInjectionPoint } from '../config.js';

class ChatUi extends HTMLElement {

    constructor() {
        super();
        this.myId = null;
        this.messagesHistory = [];
    }

    render() {
        let html = `
            <img id="my-chat-icon" class="chat-icon" src="../../img/chat-left-svgrepo-com.svg"/>
            <div id="chatModal" class="modal">
                <div class="modal-content">
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
        let sendMessage = document.getElementById('sendMessage');

        let eventsToContain = ['mousedown', 'keypress'];

        for (let eventName of eventsToContain) {
            modalContent.addEventListener(eventName, (evt) => {
                evt.stopPropagation();
            });
        }

        //TODO: escape to exit

        modalContent.addEventListener('wheel', (evt) => {
            if (evt.target.id !== 'chatInput' && evt.target.id !== 'chatMessages') {
                evt.preventDefault();
                evt.stopPropagation();
            }
        }, { passive: false });

        window.addEventListener('click', (evt) => {
            if (evt.target == modal) {
                modal.style.display = "none";
                openBtn.style.display = "flex";
                document.body.style.cursor = 'default';
                this.messagesHistory = [];
                document.getElementById('chatMessages').innerHTML = '';
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
            this.messagesHistory = [];
            document.getElementById('chatMessages').innerHTML = '';
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
            const userMessage = {role: 'user', content: prompt};
            this.messagesHistory.push(userMessage);
            this.actionRenderMessages(this.messagesHistory);
            const staticPrompt = generatePrompt(); //TODO: we could cache this into the state for efficiency...
            console.log('staticPrompt:');
            console.log(staticPrompt);
            const staticPromptMessage = {role: 'system', content: staticPrompt};
            const augmentedMessages = JSON.parse(JSON.stringify(this.messagesHistory))
            if (staticPromptMessage) {
                if (promptInjectionPoint === 'start') {
                    augmentedMessages.unshift(staticPromptMessage);
                }
                else if (promptInjectionPoint === 'end') {
                    augmentedMessages.push(staticPromptMessage);
                }
                else {
                    throw new Error(`unknown promptInjectionPoint: ${promptInjectionPoint}`);
                }
            }
            console.log('augmentedMessages:');
            console.log(augmentedMessages);
            const responseMessage = await callOpenAI(token, augmentedMessages);
            document.body.style.cursor = 'default';
            console.log(responseMessage);
            this.messagesHistory.push(responseMessage);
            this.actionRenderMessages(this.messagesHistory);
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