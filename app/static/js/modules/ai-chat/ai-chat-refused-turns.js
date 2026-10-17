// A Send that MetaList refused before the AI started exists only in this page:
// the server keeps no record of it. Each refused turn is kept with the id of
// the server message it followed, and put back in place whenever the chat is
// reloaded from the server, so the user's message and its reason stay.

// The id a refused turn records when no server message came before it.
export const AT_CHAT_START = '';
// Messages shown before the server has them (a Send in progress, a refused one).
export const LOCAL_MESSAGE_ID_PREFIX = 'local-';

function requireMessages(messages, caller) {
    if (!Array.isArray(messages)) {
        throw new Error(`${caller} requires a message list`);
    }
    for (const message of messages) {
        if (!message || typeof message.id !== 'string' || message.id === '') {
            throw new Error(`${caller} requires messages with ids`);
        }
    }
}

// The id of the last message the server has, or AT_CHAT_START when there is none.
export function lastServerMessageId(messages) {
    requireMessages(messages, 'lastServerMessageId');
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (!messages[index].id.startsWith(LOCAL_MESSAGE_ID_PREFIX)) {
            return messages[index].id;
        }
    }
    return AT_CHAT_START;
}

// The server's messages with the refused turns back in place, and the turns
// still kept: a turn whose earlier message the server trimmed goes with it.
export function placeRefusedTurns(serverMessages, refusedTurns) {
    requireMessages(serverMessages, 'placeRefusedTurns');
    if (!Array.isArray(refusedTurns)) {
        throw new Error('placeRefusedTurns requires a refused turn list');
    }
    const turnsByAnchor = new Map();
    for (const turn of refusedTurns) {
        if (!turn || typeof turn.afterMessageId !== 'string') {
            throw new Error('A refused turn requires the id of the message it followed');
        }
        requireMessages(turn.messages, 'placeRefusedTurns');
        if (!turnsByAnchor.has(turn.afterMessageId)) turnsByAnchor.set(turn.afterMessageId, []);
        turnsByAnchor.get(turn.afterMessageId).push(turn);
    }
    const messages = [];
    const keptTurns = [];
    const placeTurnsAfter = (anchorId) => {
        if (!turnsByAnchor.has(anchorId)) return;
        for (const turn of turnsByAnchor.get(anchorId)) {
            messages.push(...turn.messages);
            keptTurns.push(turn);
        }
    };
    placeTurnsAfter(AT_CHAT_START);
    for (const message of serverMessages) {
        messages.push(message);
        placeTurnsAfter(message.id);
    }
    return { messages, keptTurns };
}
