"use strict";

//TODO this should all live in a component

const refreshInterval = 1000; // 1 second
let previousSearch = '';

window.onload = function(event) {
    setInterval(search, refreshInterval);
};

async function search() {
    //TDOO: do not hardcode the id
    let search = document.getElementById('search.1').value;
    if (search !== previousSearch) {
        previousSearch = search;
        console.log(`searching for: "${search}"`);
        try {
            let request = {
                query: search
            }
            let response = await fetch("/search", {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(request)
            });
            let data = await response.json();
            console.log(data);
        } catch (error) {
            console.log(error);
        }
    }
}

