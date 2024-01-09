"use strict";


import { state } from "../app-state";


const fifo = {};
const recent = {};
let locked = false;

const RequestBusyMode = Object.freeze({
  NOOP: Symbol("noop"),
  FIFO: Symbol("fifo"),
  RECENT: Symbol("recent")
});

const endpointBusyModes = {
    '/undo': RequestBusyMode.RECENT,
    '/redo': RequestBusyMode.RECENT,
    '/indent': RequestBusyMode.RECENT,
    '/outdent': RequestBusyMode.RECENT,
    '/add-item-sibling': RequestBusyMode.RECENT,
    '/add-subitem-sibling': RequestBusyMode.RECENT,
    '/add-subitem-child': RequestBusyMode.RECENT,
    '/add-item-top': RequestBusyMode.RECENT,
    '/paste-sibling': RequestBusyMode.RECENT,
    '/todo': RequestBusyMode.RECENT,
    '/done': RequestBusyMode.RECENT,
    '/expand': RequestBusyMode.RECENT,
    '/collapse': RequestBusyMode.RECENT,
    '/delete-subitem': RequestBusyMode.RECENT,
    '/move-item-up': RequestBusyMode.RECENT,
    '/move-item-down': RequestBusyMode.RECENT,
    '/move-subitem-up': RequestBusyMode.RECENT,
    '/move-subitem-down': RequestBusyMode.RECENT,
    '/paste-child': RequestBusyMode.RECENT,
    '/open-to': RequestBusyMode.RECENT,

    '/chat-open': RequestBusyMode.RECENT,
    '/chat-close': RequestBusyMode.RECENT,
    '/chat-select-reference': RequestBusyMode.RECENT,
    '/chat-send-message': RequestBusyMode.RECENT,

    '/search': RequestBusyMode.RECENT,
    '/update-subitem-content': RequestBusyMode.RECENT,
    '/pagination-update': RequestBusyMode.RECENT,
    '/update-tags': RequestBusyMode.RECENT,
    '/search-suggestions': RequestBusyMode.RECENT,
    '/tags-suggestions': RequestBusyMode.RECENT,
    '/change-selection': RequestBusyMode.RECENT
}


window.onload = function(evt) {

    for (const [key, value] of Object.entries(endpointBusyModes)) {
        if (value === RequestBusyMode.NOOP) {
            //pass
        }
        else if (value === RequestBusyMode.FIFO) {
            fifo[key] = [];
        }
        else if (value === RequestBusyMode.RECENT) {
            recent[key] = null;
        }
        else {
            throw new Error('Unknown value ' + value);
        }
    }
}

export const genericRequest = async function(evt, endpoint, stateRef, callbackRef){
    try {
        if (evt) {
            evt.preventDefault();
            evt.stopPropagation();
        }

        if (locked) {
            console.log(`server is locked (endpoint: ${endpoint})`);
            if (endpointBusyModes[endpoint] === RequestBusyMode.NOOP) {
                console.log('NOOP');
            }
            else if (endpointBusyModes[endpoint] === RequestBusyMode.FIFO) {
                console.log('pushing state/callback to fifo queue');
                fifo[endpoint].push(JSON.parse(JSON.stringify(stateRef)));
            }
            else if (endpointBusyModes[endpoint] === RequestBusyMode.RECENT) {
                console.log('updating state/callback to recent');
                console.log(stateRef);
                const stateCopy = JSON.parse(JSON.stringify(stateRef));
                recent[endpoint] = {
                    'stateRef': stateCopy,
                    'callbackRef': callbackRef
                }
            }
            else {
                throw new Error('Unknown endpoint/mode ' + endpointBusyModes[endpoint] + ' for ' + endpoint);
            }
            return;
        }

        let request = {
            appState: stateRef,
        }

        console.log(`>>>>> ${endpoint} request`);
        locked = true;
        let t1 = Date.now();
        let response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        });
        let responseJson = await response.json();
        let t2 = Date.now();
        locked = false;
        console.log(`<<<<< ${endpoint} response (${(t2-t1)} ms)`);

        if (callbackRef) {
            callbackRef(responseJson);
        }

        // handle backlog, if exists
        for (let endpoint in endpointBusyModes) {

            if (endpointBusyModes[endpoint] === RequestBusyMode.NOOP) {
                // do nothing
            } else if (endpointBusyModes[endpoint] === RequestBusyMode.FIFO) {
                if (fifo[endpoint].length > 0) {
                    throw new Error(
                        'requesting next stateRef to fifo queue NOT IMPLEMENTED');
                }
            } else if (endpointBusyModes[endpoint] === RequestBusyMode.RECENT) {
                if (recent[endpoint]) {
                    const stateRefFromBacklog = recent[endpoint].stateRef;
                    const callbackRefFromBacklog = recent[endpoint].callbackRef;
                    console.log(`% unwinding backlog ${endpoint}`);
                    console.log(stateRefFromBacklog);
                    recent[endpoint] = null;
                    await genericRequest(evt, endpoint, stateRefFromBacklog,
                        callbackRefFromBacklog)
                }
            } else {
                throw new Error('Unknown mode ' + endpointBusyModes[endpoint] +
                    ' (Hint, you may have forgotten to register this endpoint in endpointBusyModes)');
            }
        }

    } catch (error) {
        console.error(error);
        debugger;
    }
}
