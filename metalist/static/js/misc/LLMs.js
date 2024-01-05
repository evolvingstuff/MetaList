"use strict";

import { parseMarkdown } from './formats';


export function parseChatResponse(message) {
    //TODO: confirm that the ids being pulled out are valid

    const regex = /\[([^\|]+)\|(\d+:\d+)\]/g;
    const regex2ndPass = /\[(\d+:\d+)\]/g;

    //parse markdown before adding styles
    message = parseMarkdown(message);

    let ids = [];
    message = message.replace(regex, (match, descriptor, id) => {
        ids.push(id);
        return `<span data-id="${id}" class="citation in-message">${descriptor}</span>`;
    });

    //2nd pass to correct for occassional mistakes by LLM
    message = message.replace(regex2ndPass, (match, id) => {
        ids.push(id);
        return `[<span data-id="${id}" class="citation in-message">ref</span>]`;
    });

    return { message, ids};
}


export function parseCharts(message, messageNumber) {

    console.log(`debug: parseCharts()`);
    console.log(message);

    const regex = /\[\[CHART\]\]\s*({(.|\s)*?})\s*\[\[\/CHART\]\]/;

    const matches = message.match(regex);
    let chartConfigs = [];
    let chartIds = [];
    let messageWithCharts = message;

    //TODO: more than 1 match?
    if (matches && matches[1]) {
        let chartConfigString = matches[1];

        let chartConfig;
        try {
            chartConfig = JSON.parse(chartConfigString);
        } catch (e) {
            console.error('Error parsing chart configuration:', e);
        }

        if (chartConfig) {
            const chartId = `myChart-${messageNumber}`;
            messageWithCharts = messageWithCharts.replace(regex, `<canvas id="${chartId}" width="500"></canvas>`);
            chartIds.push(chartId);
            chartConfigs.push(chartConfig);
        }
    }

    return { messageWithCharts, chartIds, chartConfigs };
}
