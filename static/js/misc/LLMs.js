import { openAiModel } from '../config';
import { state2 } from '../app-state';
import {parseMarkdown} from './formats';


export function generatePrompt() {
    let content = '';
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
            let id = `${item['id']}:${i}`;
            content += id + ' ';
            let indent = ' '.repeat(subitem['indent']*4);
            content += indent;
            content += subitem['_searchable_text'];
            content += '\n\n';
        }
    }

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

Please don't try to put equations in brackets. If you are going to format some
LaTex, please do it like this:

$ \sqrt {2 + 2} = 2 $

In other words, please surround the LaTeX equations with dollar signs. Or, if 
they are standalone equations, and not inline, use double dollar signs.

Here is the item data:
[ITEMS]
${content}
[/ITEMS]
    `;
    return prompt;
}

export function parseChatResponse(message) {
    const regex = /\[([^\|]+)\|(\d+:\d+)\]/g;

    //parse markdown before adding styles
    message = parseMarkdown(message);

    let ids = [];
    let newText = message.replace(regex, (match, descriptor, id) => {
        ids.push(id);
        return `<span data-id="${id}" class="citation in-message">${descriptor}</span>`;
    });

    return { newText, ids };
}

export async function callOpenAI(token, messages) {
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