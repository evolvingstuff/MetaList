'use strict';


import {callOpenAI, generatePrompt, parseChatResponse} from '../misc/LLMs';
import { promptInjectionPoint } from '../config';
import {EVT_ADD_CITATIONS} from '../pub-sub-events';

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
                    <div class="button-container">
                        <button id="sendMessage">Send</button>
                        <button id="resetMessage">Reset</button>
                    </div>
                </div>
            </div>`;
        this.innerHTML = html;
    }

    attachEventHandlers() {

        let openBtn = document.getElementById('my-chat-icon');
        let modal = document.getElementById("chatModal");
        let modalContent = document.getElementsByClassName("modal-content")[0];
        let sendMessage = document.getElementById('sendMessage');
        let resetMessage = document.getElementById('resetMessage');
        let eventsToContain = ['mousedown', 'keypress'];

        for (let eventName of eventsToContain) {
            modalContent.addEventListener(eventName, (evt) => {
                evt.stopPropagation();
            });
        }

        function showModal() {
            modal.style.display = 'block'; // Make the modal block to start showing it
            requestAnimationFrame(() => {
                modal.classList.add('show');
                // modal.style.display = "block";
                openBtn.style.display = "none";
            });
        }

        function hideModal() {
            modal.classList.remove('show');
            modal.addEventListener('transitionend', function() {
                modal.style.display = 'none';
                openBtn.style.display = "flex";
                document.body.style.cursor = 'default';
            }, { once: true });
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
                console.log('click modal (exit)');
                // modal.style.display = "none";
                // openBtn.style.display = "flex";
                // document.body.style.cursor = 'default';
                hideModal();
            }
        });

        openBtn.addEventListener('mousedown', (evt) => {
            evt.stopPropagation();
            evt.preventDefault();
            const apiKey = this.actionGetApiKey();
            if (apiKey === null) {
                return;
            }
            // modal.style.display = "block";
            // openBtn.style.display = "none";
            showModal();
        });

        sendMessage.addEventListener('click', (evt) => {
            this.actionSendMessage();
        });

        resetMessage.addEventListener('click', (evt) => {
            this.actionReset();
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

    actionReset() {
        console.log('actionReset');
        this.messagesHistory = [];
        this.actionRenderMessages(this.messagesHistory);
        //TODO: remove citations from items list
    }

    async actionSendMessage() {
        const token = this.actionGetApiKey();
        if (token === null) {
            alert('This requires an API key');
            return;
        }
        let chatInput = document.getElementById('chatInput');
        let prompt = chatInput.value;
        try {
            document.body.style.cursor = 'wait';
            const userMessage = {role: 'user', content: prompt};
            this.messagesHistory.push(userMessage);
            this.actionRenderMessages(this.messagesHistory);
            const staticPrompt = generatePrompt(); //TODO: we could cache this into the state for efficiency...
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
            const responseMessage = await callOpenAI(token, augmentedMessages);
            document.body.style.cursor = 'default';
            this.messagesHistory.push(responseMessage);
            this.actionRenderMessages(this.messagesHistory);
        } catch (error) {
            document.body.style.cursor = 'default';
            console.error('Error:', error);
            alert(`Error: ${error['message']}`);
        }
    }

    actionRenderMessages(messages) {
        console.log('actionRenderMessages()');
        const chatInput = document.getElementById('chatInput');
        chatInput.value = '';
        const chatMessages = document.getElementById('chatMessages');
        let history = '';
        let allCitations = [];
        for (let message of messages) {
            let formattedContent = message.content.replace(/\n/g, '<br>');
            if (message.role === 'user') {
                history += `
                    <div class="message user-message">
                        <span>${formattedContent}</span>
                    </div>`;
            }
            else {
                let { reformattedContent, ids } = parseChatResponse(formattedContent);
                debugger;
                if (ids.length > 0) {
                    allCitations.push(...ids);
                }
                history += `
                    <div class="message assistant-message">
                        <span>${reformattedContent}</span>
                    </div>`;
            }
        }
        chatMessages.innerHTML = history;
        if (allCitations.length > 0) {
            PubSub.publishSync(EVT_ADD_CITATIONS, allCitations);
        }
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