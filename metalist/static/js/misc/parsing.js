"use strict";

export function parseLinks(rawHtml) {
    return rawHtml.replace(
        /(?<!href=['"])(?<!xmlns=['"])(https?:\/\/[^<\s]+)/gi,
        '<a href="$1" target="_blank">$1</a>');
}

export function parseMarkdown(rawHtml) {
    let text = htmlToText(rawHtml);
    let md = window.markdownit();
    let formattedHtml = '';
    formattedHtml = md.render(text);
    formattedHtml = parseLatex(formattedHtml);
    formattedHtml = parseLinks(formattedHtml);
    if (rawHtml === formattedHtml) {
        console.warn('markdown made no changes to render');
    }
    return formattedHtml;
}

export function parseLatex(raw_html) {
    // Create a DOMParser instance
    var parser = new DOMParser();
    var doc = parser.parseFromString(raw_html, 'text/html');

    // Function to process text nodes
    function processNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            // Regular expression for matching LaTeX enclosed with $...$ or $$...$$
            var regex = /\$\$([\s\S]*?)\$\$|\$([\s\S]*?)\$/g;
            var match;
            var lastIndex = 0;
            var fragment = document.createDocumentFragment();

            // Iterate over matches in the text node's value
            while ((match = regex.exec(node.nodeValue)) !== null) {
                var displayMath = match[1];
                var inlineMath = match[2];
                var math = displayMath || inlineMath;
                var displayMode = !!displayMath;
                var textBeforeMath = node.nodeValue.slice(lastIndex, match.index);

                // Append text before the LaTeX
                fragment.appendChild(document.createTextNode(textBeforeMath));
                // Render LaTeX and append to fragment
                var span = document.createElement("span");
                katex.render(math, span, { throwOnError: false, displayMode: displayMode });
                fragment.appendChild(span);

                lastIndex = regex.lastIndex;
            }

            // Append text after the last LaTeX
            fragment.appendChild(document.createTextNode(node.nodeValue.slice(lastIndex)));

            // Replace text node with fragment
            node.parentNode.replaceChild(fragment, node);
        } else {
            // Recursively process child nodes
            for (var i = 0; i < node.childNodes.length; i++) {
                processNode(node.childNodes[i]);
            }
        }
    }

    // Process all nodes in the document
    processNode(doc.body);

    // Create an XMLSerializer to convert the Document back to a string
    var serializer = new XMLSerializer();
    var output = serializer.serializeToString(doc.body);

    // Remove the namespace declaration and the extra body tags
    return output.replace(' xmlns="http://www.w3.org/1999/xhtml"', '').slice(6, output.length - 7);
}

/////////////////////////////////////////////////////
//html-like -> text-like
//this converts divs and paragraphs to /n/n's
//I think this could be rewritten MUCH better
export function htmlToText(html) {
    let element = document.createElement('div');
    let newLineChar = '\n';
    let newLinesChar = '\n\n';
    let str = html;
    //TODO 2023.01.18 not sure why I am retaining the HTML in here...
    str = str.replace(/<div/, newLineChar+'<div'); //only first
    str = str.replace(/<\/div>/gmi, '<\/div>'+newLineChar);
    str = str.replace(/<\/p>/gmi, '<\/p>'+newLinesChar);
    str = str.replace(/<br.*?>/gmi, '<br>'+newLineChar);
    str = str.replace(/<tr.*?>/gmi, '<tr>'+newLineChar);
    str = str.replace(/<li.*?>/gmi, '<li>'+newLineChar);
    str = str.replace(/<ol.*?>/gmi, '<ol>'+newLineChar);
    str = str.replace(/<ul.*?>/gmi, '<ul>'+newLineChar);
    str = str.replace(/<p.*?>/gmi, '<p>'+newLineChar);
    str = str.replace(/&nbsp;/gmi, ' ');
    str = str.replace(/<img[^>]*>/gmi, ' '); //[IMAGE]
    str = str.replace(/<script[^>]*>([\S\s]*?)<\/script>/gmi, '');
    str = str.replace(/<\/?\w(?:[^"'>]|"[^"]*"|'[^']*')*>/gmi, '');
    str = str.replace(/[\r\n\t]+$/, '');
    element.innerHTML = str;
    str = element.textContent;
    element.textContent = '';
    let text = v.stripTags(str);
    text = text.trim();
    while (text.includes('\n\n\n')) {
        text = text.replace('\n\n\n', '\n\n'); //TODO: regex here
    }
    return text;
}

export const parseJson = function(html) {

	function isJson(text) {
		if (text.trim().startsWith('{') === false ||
			text.trim().endsWith('}') === false) {
			return false;
		}
		try {
        	JSON.parse(text);
	    } catch (e) {
	        return false;
	    }
	    return true;
	}

    let text = htmlToText(html);

    if (isJson(text) === false) {
        return '<span style="color:red; font-weight:bold;">Invalid JSON</span>';
    }

    let json = JSON.stringify(JSON.parse(text), null, 4);

    //https://stackoverflow.com/questions/4810841/how-can-i-pretty-print-json-using-javascript
    //http://jsfiddle.net/KJQ9K/554/
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    json = json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
        let cls = 'metalist-json-number';
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = 'metalist-json-key';
            } else {
                cls = 'metalist-json-string';
            }
        } else if (/true|false/.test(match)) {
            cls = 'metalist-json-boolean';
        } else if (/null/.test(match)) {
            cls = 'metalist-json-null';
        }
        return '<span class="' + cls + '">' + match + '</span>';
    });
    return '<span class="copyable"><pre class="metalist-json">'+json+'</pre></span>'
}

export function escapeTextForHtml(string) {
    if (typeof string !== 'string') {
        return string;
    }
    return string.replace(/&/g, '&amp;')
                 .replace(/</g, '&lt;')
                 .replace(/>/g, '&gt;')
                 .replace(/"/g, '&quot;')
                 .replace(/'/g, '&#039;');
}

export function parseChatUserMessage(content, messageNumber) {
    return `
            <div id="messageNumber${messageNumber}" class="message user-message">
                <span>${content}</span>
            </div>`;
}

export function parseChatAssistantMessage(content, messageNumber) {
    //parse markdown *before* adding other features
    content = parseMarkdown(content);

    content = parseChatCitations(content);

    content = parseChatTables(content);

    let chartIds = [], chartConfigs = [];
    [content, chartIds, chartConfigs] = parseChatCharts(content, messageNumber);

    let html = `
        <div id="messageNumber${messageNumber}" class="message assistant-message">
            <span>${content}</span>
        </div>`;

    return [html, chartIds, chartConfigs];
}


function parseChatCitations(content) {
    //TODO: confirm that the ids being pulled out are valid

    const regex = /\[([^\|]+)\|(\d+:\d+)\]/g;
    const regex2ndPass = /\[(\d+:\d+)\]/g;

    content = content.replace(regex, (match, descriptor, id) => {
        return `<span data-id="${id}" class="citation in-message">${descriptor}</span>`;
    });

    //2nd pass to correct for occasional mistakes by LLM
    content = content.replace(regex2ndPass, (match, id) => {
        return `[<span data-id="${id}" class="citation in-message">ref</span>]`;
    });

    return content;
}


function parseChatCharts(content, messageNumber) {

    const regex = /\[\[CHART\]\]\s*({(.|\s)*?})\s*\[\[\/CHART\]\]/;

    const matches = content.match(regex);
    let chartConfigs = [];
    let chartIds = [];

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
            content = content.replace(regex, `<canvas id="${chartId}" width="500"></canvas>`);
            chartIds.push(chartId);
            chartConfigs.push(chartConfig);
        }
    }

    return [content, chartIds, chartConfigs];
}

function parseChatTables(content, messageNumber) {
    const regex = /\[\[TABLE\]\]\n([\s\S]*?)\n\[\[\/TABLE\]\]/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
        const csvData = match[1];
        const htmlTable = parseCsvToHtmlTable(csvData);
        content = content.replace(match[0], htmlTable);
    }
    return content;
}

function parseCsvToHtmlTable(csvData) {
    const lines = csvData.split('\n');
    let html = '<table class="chat-table">';
    const headers = lines[0].split(',');
    html += '<tr>';
    headers.forEach(header => {
        html += `<th>${header.trim()}</th>`;
    });
    html += '</tr>';
    for (let i = 1; i < lines.length; i++) {
        if(lines[i].trim() === "") continue; // Skip empty lines
        const row = lines[i].match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g);
        if(!row) continue;
        html += '<tr>';
        row.forEach(cell => {
            const cellValue = cell.replace(/^"|"$/g, '').trim();
            html += `<td>${cellValue}</td>`;
        });
        html += '</tr>';
    }
    html += '</table>';
    return html;
}

