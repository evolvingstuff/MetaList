'use strict';


import {
    callOpenAI,
    generatePrompt, parseCharts,
    parseChatResponse,
} from '../misc/LLMs';
import {
    devChatMessage,
    ephemeralChat,
    promptInjectionPoint,
} from '../config';
import { EVT_SELECT_CITATION } from '../pub-sub-events';
import {state} from '../app-state';


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

        const showModal = () => {
            this.actionRenderMessages(this.messagesHistory);
            modal.style.display = 'block'; // Make the modal block to start showing it
            requestAnimationFrame(() => {
                modal.classList.add('show');
                openBtn.style.display = "none";
                state.modeMetaChat = true;
            });
        }

        let hideModal = () => {
            modal.classList.remove('show');
            openBtn.style.display = "flex";
            modal.addEventListener('transitionend', function() {
                document.body.style.cursor = 'default';
                state.modeMetaChat = false;
                modal.style.display = 'none';
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
            if (ephemeralChat) {
                this.messagesHistory = [];
                this.actionRenderMessages(this.messagesHistory);
            }
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
            apiKey = prompt("Please enter your OpenAI API key:");
            if (apiKey) {
                localStorage.setItem("API_KEY", apiKey);
            } else {
                console.warn("OpenAI API key is required.");
            }
        }
        return apiKey;
    }

    actionReset() {
        this.messagesHistory = [];
        this.actionRenderMessages(this.messagesHistory);
    }

    //TODO: refactor
    async actionSendMessage() {
        const token = this.actionGetApiKey();
        if (token === null) {
            alert('This requires an OpenAI API key');
            return;
        }
        let chatInput = document.getElementById('chatInput');
        let prompt = chatInput.value;
        try {
            document.body.style.cursor = 'wait';
            const userMessage = {role: 'user', content: prompt};
            this.messagesHistory.push(userMessage);

            //TODO: links?

            this.actionRenderMessages(this.messagesHistory);

            //scroll to bottom after adding a new query
            let messagesDiv = document.getElementById("chatMessages");
            messagesDiv.scrollTop = messagesDiv.scrollHeight;

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
            let responseMessage = null;
            if (devChatMessage) {
                responseMessage = devChatMessage;
            }
            else {
                responseMessage = await callOpenAI(token, augmentedMessages);
            }
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
        const chatInput = document.getElementById('chatInput');
        chatInput.value = '';
        const chatMessages = document.getElementById('chatMessages');
        let history = '';
        let allCitations = [];
        let allChartIds = [];
        let allChartConfigs = [];
        let messageNumber = 0;
        for (let message of messages) {
            messageNumber += 1;
            let formattedContent = message.content.replace(/\n/g, '<br>');
            if (message.role === 'user') {
                history += `
                    <div class="message user-message">
                        <span>${formattedContent}</span>
                    </div>`;
            }
            else {
                let { message, ids } = parseChatResponse(formattedContent);
                if (ids.length > 0) {
                    allCitations.push(...ids);
                }
                let { messageWithCharts, chartIds, chartConfigs } = parseCharts(message, messageNumber);
                if (chartIds.length > 0) {
                    allChartIds.push(...chartIds);
                    allChartConfigs.push(...chartConfigs);
                }
                history += `
                    <div class="message assistant-message">
                        <span>${messageWithCharts}</span>
                    </div>`;
            }
        }
        chatMessages.innerHTML = history;

        if (allChartIds.length > 0) {
            console.log(allChartIds);
            console.log(allChartConfigs);
            allChartIds.forEach((chartId, index) => {
                const chartConfig = allChartConfigs[index];
                const ctx = document.getElementById(chartId).getContext('2d');
                new Chart(ctx, chartConfig);
            });
        }

        document.querySelectorAll('.in-message.citation').forEach(element => {
            element.addEventListener('mouseover', function() {
                const subitem = document.querySelector(`.subitem[data-id="${this.dataset.id}"]`);
                if (subitem) {
                    subitem.classList.add('highlight');
                }

                const inlines = document.querySelectorAll(`.in-message[data-id="${this.dataset.id}"]`);
                inlines.forEach((inline) => {
                    inline.classList.add('highlight');
                });
            });

            element.addEventListener('mouseout', function() {
                const subitem = document.querySelector(`.subitem[data-id="${this.dataset.id}"]`);
                if (subitem) {
                    subitem.classList.remove('highlight');
                }

                const inlines = document.querySelectorAll(`.in-message[data-id="${this.dataset.id}"]`);
                inlines.forEach((inline) => {
                    inline.classList.remove('highlight');
                });
            });

            element.addEventListener('mousedown', (evt) => {
                if (evt.target.classList.contains('in-message') && evt.target.classList.contains('citation')) {
                    const itemSubitemId = evt.target.dataset.id;
                    PubSub.publishSync(EVT_SELECT_CITATION, itemSubitemId);
                }
            });
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