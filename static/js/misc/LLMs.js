import { openAiModel } from '../config';
import { state2 } from '../app-state';


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

    debugger;

    const prompt = `
    You are a large language model, assisting a user about information in a 
    personal knowledge management / note taking app, called MetaList.
    The user's questions will tend to revolve around the content of a set of 
    selected notes (which are called "items" in MetaList), so if possible, you 
    should refer back to those rather than giving broader answers, unless the 
    user instructs you to do so.
    Also, it would be really great if, in your answer, you can reference the id 
    numbers of the items/subitems you used. Items consist of subitems, so an id of
    12345:6 would be item 12345, and the 7th subitem (subitems are zero-indexed).
    Here is the item data:
    [ITEMS]
    ${content}
    [/ITEMS]
    `;
    return prompt;
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
    console.log(result);
    const message = result.choices && result.choices[0] ? result.choices[0].message : null;
    return message;
}