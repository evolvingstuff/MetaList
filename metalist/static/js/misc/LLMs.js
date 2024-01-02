"use strict";


import { openAiModel } from '../config';
import { state, state2 } from '../app-state';
import { parseMarkdown } from './formats';


export function generatePrompt() {
    let content = '';
    //TODO: we do not need to do this every time...
    for (let item of state2.recentItems) {
        for (let i = 0; i < item['subitems'].length; i++) {
            const subitem = item['subitems'][i];
            if (subitem.hasOwnProperty('_match') === false) {
                if (i === 0) {
                    break;
                }
                else {
                    continue;
                }
            }
            //TODO: what other tags might we want to skip?
            if (subitem['_tags'].includes('@implies')) {
                continue;
            }
            let id = `${item['id']}:${i}`;
            content += id + ' ';
            let indent = '\t'.repeat(subitem['indent']);
            content += indent;
            content += subitem['_searchable_text'];
            content += '\n\n';
        }
    }

    let maybeSelected = '';
    if (state.selectedItemSubitemId !== null) {
        maybeSelected = `
The user currently has ${state.selectedItemSubitemId} selected, so keep in mind 
that they may refer to this subitem specifically in their queries.
        `;
    }
    else {
        maybeSelected = `
        `;
    }

    let searchContext = `
The current search context is: ${state.searchText}
The search context determines which items do or do not show up, and is often a 
good indication of the user's intent.
    `; //TODO: empty search string?

    const prompt = `
You are a large language model, assisting a user about information in a 
personal knowledge management / note taking app, called MetaList.
The user's questions will tend to revolve around the content of a set of 
selected notes (which are called "items" in MetaList), so if possible, you 
should refer back to those rather than giving broader answers, unless the 
user instructs you to do so. One exception is that if the user asks for 
recommendations, they are probably not referring to the existing items, and 
will want you to reference a broader context.

Also, it would be really great if, in your answer, you can reference the id 
numbers of the items/subitems you used. Items consist of subitems, so an id of
12345:6 would be item 12345, and the 7th subitem (subitems are zero-indexed).

The syntax [descriptor|id:index] is used to represent a reference within a text. 
It consists of two main parts separated by a pipe | character:

1. descriptor: This is a descriptive or title text, providing the context or 
name of the item being referenced. It's placed before the pipe |.

2. id:Index: This follows the pipe and is a unique identifier for the item, 
typically in the format of id:index, where id and index are numerical values.

This syntax is used to embed item references seamlessly within the message, 
making them identifiable for parsing while maintaining readability.

For example, your output should look like:

The intense action sequences and martial arts choreography would seem fitting 
for a fan of impactful action films like [Mad Max: Fury Road|8944:17] and 
[13 Assassins|8944:6].

which, after parsing, becomes

The intense action sequences and martial arts choreography would seem fitting 
for a fan of impactful action films like Mad Max: Fury Road and 
13 Assassins.

Notice how the parsed version reads correctly, because no extra whitespace
or punctuation was initially added when including the reference.

If you are making a recommendation of something new (not specifically referred 
to in item data) please do not make a reference directly. E.g. if the user has 
never seen the movie "Primer" and it is not in their data, you could answer 

"Because you liked [Pi|12345:6] you might also like Primer."

This is fine, because in this hypothetical example, Pi is in the user item data.

Please don't try to put equations in brackets. If you are going to format some
LaTex, please do it like this:

$ \sqrt {2 + 2} = 2 $

In other words, please surround the LaTeX equations with single dollar signs. 
Or, if they are standalone equations, and not inline, use double dollar signs.

There may be times when the user asks you to "visualize" some data in the form 
of a graph or a chart. An example might be "Please show me a pie chart of my 
favorite movies, grouped by genre." Note that the user may or may not specify 
the type of chart/graph, and in that case you will need to use your best 
judgement; or you could ask some clarifying questions first.

Once you have figured out what type of chart to produce, you will need to 
indicate it in your response using the following pattern:

[[CHART]]
{
  "type": "pie",
  "data": {
    "labels": ["Category1", "Category2", "Category3"],
    "datasets": [{
      "label": "Dataset Label",
      "data": [30, 50, 20],
      "backgroundColor": ["red", "green", "blue"]
    }]
  },
  "options": {
    "responsive": true,
    "plugins": {
      "legend": {
        "position": "top"
      },
      "title": {
        "display": true,
        "text": "Chart.js Pie Chart"
      }
    }
  }
}
[[/CHART]]

We are using Chart.js as the library to do rendering, so the JSON will need to 
conform to their syntax. Note that, although the examples for Chart.js use 
object literals, your output needs to be a *valid* JSON string (as depicted 
above so that your response can be reliably parsed. The data should be 
inlined directly; you cannot create or refer to other functions or variables in 
this configuration.

The regular flow of conversation can occur before and after the 
[[CHART]]...[[/CHART]] block. There may even be times when it makes sense 
to create more than one chart.

These charts will be pretty small (about 500 pixels wide) so take that into 
account.

Here is the user's item data:
[[ITEMS]]
${content}
[[/ITEMS]]

${maybeSelected}

${searchContext}
    `;
    return prompt;
}

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
    const regex = /\[\[chart\.js\]\]\s*({(.|\s)*?})\s*\[\[\/chart\.js\]\]/;

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



export async function callOpenAI(token, messages) {
    let characters = 0;
    for (let message of messages) {
        characters += message['content'].length;
    }
    const tokens = Math.floor(characters/4);
    console.log(`Approx ${tokens} tokens`);
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: openAiModel,
            messages: messages
        })
    });
    const result = await response.json();
    console.log('OpenAI response:');
    console.log(result);
    const message = result.choices && result.choices[0] ? result.choices[0].message : null;
    return message;
}