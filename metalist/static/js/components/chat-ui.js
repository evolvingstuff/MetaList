'use strict';


import { ephemeralChat } from '../config';
import { EVT_SELECT_CITATION } from '../pub-sub-events';
import { state } from '../app-state';
import { genericRequest } from '../misc/server-proxy';
import {
    parseChatAssistantMessage,
    parseChatUserMessage
} from '../misc/parsing';


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

        const actionChatOpen = () => {
            genericRequest(null, "/chat-open", state, reactionChatOpen);
        }

        const reactionChatOpen = () => {
            this.actionRenderMessages(this.messagesHistory);
            modal.style.display = 'block'; // Make the modal block to start showing it
            requestAnimationFrame(() => {
                modal.classList.add('show');
                openBtn.style.display = "none";
                state.modeMetaChat = true;
            });
        }

        const actionChatClose = () => {
            genericRequest(null, "/chat-close", state, reactionChatClose);
        }

        let reactionChatClose = () => {
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
                actionChatClose();
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
            actionChatOpen();
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
        state.openAiApiKey = apiKey;
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
        let message = chatInput.value;
        state.chatUserMessage = message;

        document.body.style.cursor = 'wait';
        const userMessage = {role: 'user', content: message};
        this.messagesHistory.push(userMessage);
        this.actionRenderMessages(this.messagesHistory);

        //scroll to bottom after adding a new query
        let messagesDiv = document.getElementById("chatMessages");
        messagesDiv.scrollTop = messagesDiv.scrollHeight;

        genericRequest(null, "/chat-send-message", state, this.reactionSendMessage);
    }

    reactionSendMessage = (data) => {
        document.body.style.cursor = 'default';
        this.messagesHistory = data['chatHistory'];
        console.log(this.messagesHistory);
        this.actionRenderMessages(this.messagesHistory);
    }

    addCitationEvents() {
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
                    genericRequest(null, "/chat-select-reference", state, null);
                }
            });
        });
    }

    renderCharts(allChartIds, allChartConfigs) {
        if (allChartIds.length > 0) {
            allChartIds.forEach((chartId, index) => {
                const chartConfig = allChartConfigs[index];
                const ctx = document.getElementById(chartId).getContext('2d');
                //TODO catch errors here
                new Chart(ctx, chartConfig);
            });
        }
    }

    actionRenderMessages(messages) {
        const chatInput = document.getElementById('chatInput');
        chatInput.value = '';
        const chatMessages = document.getElementById('chatMessages');
        let combinedHtml = '';
        let allChartIds = [], allChartConfigs = [];
        let messageNumber = 0;
        for (let message of messages) {
            messageNumber += 1;
            let content = message.content.replace(/\n/g, '<br>');
            if (message.role === 'user') {
                let html = parseChatUserMessage(content, messageNumber);
                combinedHtml += html;
            }
            else if (message.role === 'assistant') {
                let [html, chartIds, chartConfigs] = parseChatAssistantMessage(content, messageNumber);
                combinedHtml += html;
                allChartIds.push(...chartIds);
                allChartConfigs.push(...chartConfigs);
            }
        }
        chatMessages.innerHTML = combinedHtml;

        this.addCitationEvents();
        this.renderCharts(allChartIds, allChartConfigs);
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