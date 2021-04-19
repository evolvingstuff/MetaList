"use strict";

function transitionRouter(nextState) {
    if (state.state_machine == nextState) {
        return;
    }

    //TODO: maybe move that function into here?
    //TODO: what if we are transitioning out of a paused state? I think this needs to live in actions, not here
    if ($main_controller.canTakeAction('transitionRouter()') === false) {
        return;
    }

    let key = `${state.state_machine}->${nextState}`

    state.state_history.push(nextState);

    //specific exit events
    if (exitRoutes[state.state_machine] !== undefined) {
        exitRoutes[state.state_machine]();
    }

    //implied exit events
    //TODO: need to make sure next state does not imply same
    if (STATE_IMPLICATIONS[state.state_machine] !== undefined) {
        for (let implied_key of STATE_IMPLICATIONS[state.state_machine]) {
            if (exitRoutes[implied_key] !== undefined) {
                exitRoutes[implied_key]();
            }
        }
    }

    let possible_keys = [key];
    //TODO: double check this code
    if (STATE_IMPLICATIONS[state.state_machine] !== undefined) {
        for (let lhs of STATE_IMPLICATIONS[state.state_machine]) {
            possible_keys.push(`${lhs}->${nextState}`);
            if (STATE_IMPLICATIONS[nextState] !== undefined) {
                for (let rhs of STATE_IMPLICATIONS[nextState]) {
                    possible_keys.push(`${lhs}->${rhs}`);
                }
            }
        }
        if (STATE_IMPLICATIONS[nextState] !== undefined) {
            for (let rhs of STATE_IMPLICATIONS[nextState]) {
                possible_keys.push(`${state.state_machine}->${rhs}`);
            }
        }
    }
    else {
        if (STATE_IMPLICATIONS[nextState] !== undefined) {
            for (let rhs of STATE_IMPLICATIONS[nextState]) {
                possible_keys.push(`${state.state_machine}->${rhs}`);
            }
        }
    }
    //console.log(possible_keys);

    for (let possible_key of possible_keys) {
        if (transitionRoutes[possible_key] !== undefined) {
            console.log(possible_key);
            transitionRoutes[possible_key]();
        }
    }

    //update state
    state.state_machine = nextState;  //TODO: before or after? Should not matter much

    //implied entry events
    //TODO: need to make sure prior state does not imply same
    if (STATE_IMPLICATIONS[nextState] !== undefined) {
        for (let implied_key of STATE_IMPLICATIONS[nextState]) {
            if (entryRoutes[implied_key] !== undefined) {
                entryRoutes[implied_key]();
            }
        }
    }

    //specific entry events
    if (entryRoutes[nextState] !== undefined) {
        entryRoutes[nextState]();
    }
}

function pushState(nextState) {
    state.state_stack = state.state_machine;
    transitionRouter(nextState);
}

function popState() {
    transitionRouter(state.state_stack);
    state.state_stack = null;
}