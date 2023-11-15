"use strict";


import {
    EVT_SEARCH_UPDATED,
    EVT_SEARCH_RETURN
} from '../components/search-bar.js';

export const state = {
    pendingQuery: null,
    mostRecentQuery: null,
    serverIsBusy: false,
    modeLocked: false
}

const debugShowLocked = false;
const hideImpliesTagByDefault = true;


window.onload = function(evt) {

    PubSub.subscribe(EVT_SEARCH_UPDATED, (msg, searchFilter) => {
        state.mostRecentQuery = searchFilter;
        if (state.serverIsBusy) {
            console.log('server is busy, saving pending query');
            state.pendingQuery = searchFilter;
        }
        else {
            state.pendingQuery = null;
            state.serverIsBusy = true;
            genericRequestV2(evt, null, '/search', EVT_SEARCH_RETURN);
        }
    });

    PubSub.subscribe(EVT_SEARCH_RETURN, (msg, items) => {
        state.serverIsBusy = false;
        if (state.pendingQuery !== null) {
            console.log('server is no longer busy, sending pending query');
            state.mostRecentQuery = state.pendingQuery;
            state.pendingQuery = null;
            state.serverIsBusy = true;
            genericRequestV2(evt, null, '/search', EVT_SEARCH_RETURN);
        }
    });
}

export const genericRequestV2 = async function(evt, itemsListState, endpoint, returnEvent){
    try {
        if (evt) {
            evt.preventDefault();
            evt.stopPropagation();
        }
        if (state.modeLocked) {
            console.log('mode locked, ignoring request');
            return;
        }
        state.modeLocked = true;
        if (debugShowLocked) {
            document.body.style['background-color'] = 'red';
        }
        let filter = JSON.parse(JSON.stringify(state.mostRecentQuery));
        if (hideImpliesTagByDefault) {
            if (!filter.negated_tags.includes('@implies') &&
                !filter.tags.includes('@implies') &&
                filter.partial_tag !== '@implies') {
                console.log('adding @implies to negated tags');
                filter.negated_tags.push('@implies');
            }
        }
        let request = {
            itemsListState: itemsListState,
            searchFilter: filter
        }
        let response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        });
        let result = await response.json();
        state.modeLocked = false;
        if (debugShowLocked) {
            document.body.style['background-color'] = 'white';
        }
        if (returnEvent) {
            PubSub.publish(returnEvent, result);
        }
        else {
            return result;
        }
    } catch (error) {
        console.log(error);
        //TODO publish the error
    }
}
