"use strict";

import {
    state
} from "../app-state.js";

import {
    findTopmostVisibleDataId
} from './scrolling.js';

const fifo = {};
const recent = {};
let locked = false;

const RequestBusyMode = Object.freeze({
  NOOP: Symbol("noop"),
  FIFO: Symbol("fifo"),
  RECENT: Symbol("recent")
});

const endpointBusyModes = {
    '/undo': RequestBusyMode.NOOP,
    '/redo': RequestBusyMode.NOOP,
    '/indent': RequestBusyMode.NOOP,
    '/outdent': RequestBusyMode.NOOP,
    '/add-item-sibling': RequestBusyMode.NOOP,
    '/add-subitem-sibling': RequestBusyMode.NOOP,
    '/add-subitem-child': RequestBusyMode.NOOP,
    '/add-item-top': RequestBusyMode.NOOP,
    '/paste-sibling': RequestBusyMode.NOOP,
    '/todo': RequestBusyMode.NOOP,
    '/done': RequestBusyMode.NOOP,
    '/expand': RequestBusyMode.NOOP,
    '/collapse': RequestBusyMode.NOOP,
    '/delete-subitem': RequestBusyMode.NOOP,
    '/move-item-up': RequestBusyMode.NOOP,
    '/move-item-down': RequestBusyMode.NOOP,
    '/move-subitem-up': RequestBusyMode.NOOP,
    '/move-subitem-down': RequestBusyMode.NOOP,
    '/paste-child': RequestBusyMode.NOOP,
    '/search': RequestBusyMode.RECENT,
    '/update-subitem-content': RequestBusyMode.RECENT,
    '/pagination-update': RequestBusyMode.RECENT,
    '/update-tags': RequestBusyMode.RECENT,
    '/search-suggestions': RequestBusyMode.RECENT,
    '/tags-suggestions': RequestBusyMode.RECENT
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

export const genericRequestV3 = async function(evt, endpoint, callback){
    try {
        if (evt) {
            evt.preventDefault();
            evt.stopPropagation();
        }

        [state.topmostVisibleItemSubitemId, state.topmostPixelOffset] = findTopmostVisibleDataId();
        if (state.topmostVisibleItemSubitemId) {
            localStorage.setItem('topmostVisibleItemSubitemId', state.topmostVisibleItemSubitemId);
            localStorage.setItem('topmostPixelOffset', state.topmostPixelOffset);
        }
        else {
            localStorage.removeItem('topmostVisibleItemSubitemId');
            localStorage.removeItem('topmostPixelOffset');
        }
        //TODO maybe store all of app-state in localStorage?

        if (locked) {
            console.log(`server is locked (endpoint: ${endpoint})`);
            if (endpointBusyModes[endpoint] === RequestBusyMode.NOOP) {
                console.log('NOOP');
                console.log('RETURN');
                return;
            }
            else if (endpointBusyModes[endpoint] === RequestBusyMode.FIFO) {
                console.log('pushing state to fifo queue');
                console.log('RETURN');
                fifo[endpoint].push(JSON.parse(JSON.stringify(state)));
                return;
            }
            else if (endpointBusyModes[endpoint] === RequestBusyMode.RECENT) {
                console.log('updating state to recent');
                console.log(state);
                console.log('RETURN');
                recent[endpoint] = JSON.parse(JSON.stringify(state));
                return;
            }
            else {
                throw new Error('Unknown endpoint/mode ' + endpointBusyModes[endpoint] + ' for ' + endpoint);
            }
        }

        let request = {
            appState: state,
        }

        console.log(`>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> ${endpoint}`);
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
        let result = await response.json();
        let t2 = Date.now();
        locked = false;
        console.log(`   <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< ${endpoint} (${(t2-t1)} ms)`);

        if (callback) {
            callback(result);
        }

        // handle backlog
        if (endpointBusyModes[endpoint] === RequestBusyMode.NOOP) {
            //
        }
        else if (endpointBusyModes[endpoint] === RequestBusyMode.FIFO) {
            if (fifo[endpoint].length > 0) {
                throw new Error('requesting next state to fifo queue NOT IMPLEMENTED');
            }
        }
        else if (endpointBusyModes[endpoint] === RequestBusyMode.RECENT) {
            while (recent[endpoint] !== null) {
                const contextState = recent[endpoint];
                recent[endpoint] = null;
                await backlog(contextState, endpoint, callback);
                console.log('done with backlog?');
            }
        }
        else {
            throw new Error('Unknown mode ' + endpointBusyModes[endpoint]);
        }

    } catch (error) {
        console.error(error);
        debugger;
    }
}

const backlog = async function(contextState, endpoint, callback){
    try {
        if (locked) {
            throw new Error("Backlog, but server is locked");
        }

        let request = {
            appState: contextState,
        }
        console.log('Backlog state:');
        console.log(contextState);
        console.log(`>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> ${endpoint} (backlog)`);
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
        let result = await response.json();
        let t2 = Date.now();
        locked = false;
        console.log(`   <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< ${endpoint} (backlog) (${(t2-t1)} ms)`);
        if (callback) {
            console.log('+++++ callback (backlog)');
            callback(result);
        }
    } catch (error) {
        console.error(error);
        debugger;
    }
}
