"use strict";

function parseLinks(rawHtml) {
    return rawHtml.replace(
        /(?<!href=['"])(?<!xmlns=['"])(https?:\/\/[^<\s]+)/gi,
        '<a href="$1" target="_blank">$1</a>');
}

function parseMarkdown(rawHtml) {
    let text = $unifiedText.htmlToText(rawHtml);
    let md = window.markdownit();
    let formattedHtml = '';
    formattedHtml = md.render(text);
    formattedHtml = parseLatex(formattedHtml);
    formattedHtml = parseLinks(formattedHtml);
    console.log(formattedHtml);
    return formattedHtml;
}

function parseLatex(raw_html) {
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