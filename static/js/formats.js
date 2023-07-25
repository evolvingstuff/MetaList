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
    //console.log(formattedHtml);
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

// TODO 2023.01.18: can this be done by voca?
//html-like -> text-like
function escapeHtmlEntities(html) {
    let escaped = v.escapeHtml(html);
    return escaped;
 }

//TODO maybe rename htmlToTextToHtml()
function removeHtmlFormatting(html) {
    let text = htmlToText(html);
    return textToHtml(text);
}

export function textToHtml(text) {
    let textyHtml = text;
    textyHtml = textyHtml.replace(/&/g, '&amp;');
    textyHtml = textyHtml.replace(/'/g, '&apos;');
    textyHtml = textyHtml.replace(/"/g, '&quot;');
    textyHtml = textyHtml.replace(/</g, '&lt;');
    textyHtml = textyHtml.replace(/>/g, '&gt;');
    textyHtml = textyHtml.replace(/  /g, ' &nbsp;'); //allow for single spaces
    textyHtml = textyHtml.replace(/\n/g, '<br>');
    textyHtml = textyHtml.replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
    return textyHtml;
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

///////////////////////////////////////////////////////////////////////
function sanitizeFilename(str) {
    //TODO 2023.01.19 unit test this
    let regex = /[\\\\/:*?\"<>|]/ig;
    let invalidCharRemoved = str.replaceAll(regex, "_");
    return invalidCharRemoved;
}
