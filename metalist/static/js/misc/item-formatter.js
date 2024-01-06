"use strict";


import {
    parseMarkdown,
    parseJson
} from './parsing';

const numberedListChar = '.';  //TODO: make this configurable

export const itemFormatter = (item, selectedItemSubitemId, modeEditing) => {
    function applyFormatting(itemSubitemId, html, tags) {
        let formattedHtml = html;

        if (formattedHtml === '') {
            formattedHtml = '&nbsp;';  //so as to not have lines of zero height.
        }

        if (tags.includes('@markdown')) {
            formattedHtml = parseMarkdown(formattedHtml);
        }
        else if (tags.includes('@json')) {
            //TODO 2023.03.05: this isn't rendering properly
            formattedHtml =  parseJson(formattedHtml);
        }

        if (tags.includes('@password')) {
            formattedHtml = `<span class="tag-password copyable">${formattedHtml}</span>`;
        }

        //rewrite links to be clickable (if not already)
        if (formattedHtml.includes('http')) {
            formattedHtml = formattedHtml.replace(/(?<!href=['"])(?<!xmlns=['"])(https?:\/\/[^<\s]+)/gi, '<a href="$1" target="_blank">$1</a>');
        }

        return formattedHtml;
    }

    function applyClasses(tags) {
        //TODO: we may want to do this on the server instead
        let classes = [];
        if (tags.includes('@heading')) {
            classes.push('tag-heading');
        }
        if (tags.includes('@strikethrough')) {
            classes.push('tag-strikethrough');
        }
        if (tags.includes('@bold')) {
            classes.push('tag-bold');
        }
        if (tags.includes('@italic')) {
            classes.push('tag-italic');
        }
        if (tags.includes('@monospace')) {
            classes.push('tag-monospace');
        }
        if (tags.includes('@green')) {
            classes.push('tag-green');
        }
        if (tags.includes('@red')) {
            classes.push('tag-red');
        }
        if (tags.includes('@blue')) {
            classes.push('tag-blue');
        }
        if (tags.includes('@grey')) {
            classes.push('tag-grey');
        }
        return classes;
    }

    let content = `<div class="item" id="${item.id}">`;
    let gridRow = 1;
    let collapseMode = false;
    let collapseIndent = -1;
    let offsetPerIndent = 2;
    let downArrow = `<img src="../../img/caret-down-filled.svg" class="arrow" />`;
    let rightArrow = `<img src="../../img/caret-right-filled.svg" class="arrow" />`;
    let bullet = '&#x2022';
    let todo = `<img src="../../img/checkbox-unchecked.svg" class="todo" />`;
    let done = `<img src="../../img/checkbox-checked.svg" class="todo" />`;
    let subitemIndex = 0;

    for (let subitem of item['subitems']) {

        if (subitem['_tags'].includes('@list-bulleted')) {
            for (let index2 = subitemIndex +1; index2 < item['subitems'].length; index2++) {
                let subitemAfter = item['subitems'][index2];
                if (subitemAfter['indent'] <= subitem['indent']) {
                    break;
                }
                if (subitemAfter['indent'] > subitem['indent'] + 1) {
                    continue;
                }
                subitemAfter['_@list-bulleted'] = true;
            }
        }

        if (subitem['_tags'].includes('@list-numbered')) {
            let rank = 1;
            for (let index2 = subitemIndex +1; index2 < item['subitems'].length; index2++) {
                let subitemAfter = item['subitems'][index2];
                if (subitemAfter['indent'] <= subitem['indent']) {
                    break;
                }
                if (subitemAfter['indent'] > subitem['indent'] + 1) {
                    continue;
                }
                subitemAfter['_@list-numbered'] = rank;
                rank += 1;
            }
        }

        if (collapseMode) {

            if (subitem.indent <= collapseIndent) {
                collapseMode = false;
                collapseIndent = -1;
            } else {
                subitemIndex += 1;
                continue;
            }
        }

        if (subitem.collapse !== undefined) {
            if (subitem.collapse) {
                collapseMode = true;
                collapseIndent = subitem.indent;
            } else {
                collapseMode = false;
                collapseIndent = -1;
            }
        }

        let itemSubitemId = `${item.id}:${subitemIndex}`;
        let tags = subitem['_tags']
        let classes = applyClasses(tags);
        if (subitemIndex === 0) {
            classes.push('subitem-first');
        }
        if (subitem['_match'] === undefined) {
            classes.push('redacted');
        }

        let formattedData = '';
        if (itemSubitemId === selectedItemSubitemId) {
            //we don't want to do formatting/parsing when in selected/editing mode
            formattedData = subitem.data;
        }
        else {
            formattedData = applyFormatting(itemSubitemId, subitem.data, tags);
        }

        let column_start = subitem.indent * offsetPerIndent + 1;  // 1 based and give room for the bullet and expand arrow

        if (subitem['_match'] === undefined) {
            column_start += 1;
            content += `<div data-id="${itemSubitemId}" class="subitem subitem-redacted" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">&nbsp;</div>`;
        } else {
            //optionally render the expand/collapse arrow
            if (subitemIndex < item.subitems.length - 1 &&
                item.subitems[subitemIndex + 1].indent > subitem.indent) {
                if (collapseMode) {
                    content += `<div data-id="${itemSubitemId}" class="subitem-outline-slot collapse" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${rightArrow}</div>`;
                } else {
                    content += `<div data-id="${itemSubitemId}" class="subitem-outline-slot expand" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${downArrow}</div>`;
                }
                column_start += 1
            } else {
                content += `<div data-id="${itemSubitemId}" class="subitem-outline-slot" style="grid-row: ${gridRow}; grid-column-start: ${column_start};"> </div>`;
                column_start += 1
            }

            //optionally render the todo/done icons
            if (tags.includes('@todo')) {
                content += `<div data-id="${itemSubitemId}" class="subitem-todo-or-done-slot tag-todo" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${todo}</div>`;
                column_start += 1
            } else if (tags.includes('@done')) {
                content += `<div data-id="${itemSubitemId}" class="subitem-todo-or-done-slot tag-done" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${done}</div>`;
                column_start += 1
            }

            //optionally handle list rendering
            if (subitem['_@list-bulleted'] !== undefined) {
                content += `<div data-id="${itemSubitemId}" class="subitem-list-bulleted-slot" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${bullet}</div>`;
                column_start += 1
            } else if (subitem['_@list-numbered'] !== undefined) {
                let rank = subitem['_@list-numbered']
                content += `<div data-id="${itemSubitemId}" class="subitem-list-numbered-slot" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${rank}${numberedListChar}</div>`;
                column_start += 1
            }

            //render the formatted subitem data
            content += `<div data-id="${itemSubitemId}" class="subitem ${classes.join(' ')}" style="grid-row: ${gridRow}; grid-column-start: ${column_start};" spellcheck="false">${formattedData}</div>`;
        }
        gridRow++;
        subitemIndex++;
    }
    content += '</div>';
    return content;
}

async function convertImagesToDataUrl(element) {
    const images = element.querySelectorAll('img');
    for (const img of images) {
        const src = img.getAttribute('src');
        const response = await fetch(src);
        const blob = await response.blob();
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
        img.setAttribute('src', dataUrl);
    }
}

async function getAllCssRules() {
    let cssText = '';
    for (const stylesheet of document.styleSheets) {
        try {
            for (const rule of stylesheet.cssRules) {
                cssText += rule.cssText + '\n';
            }
        } catch (e) {
            console.warn('Skipping stylesheet due to security restrictions: ', stylesheet.href);
        }
    }
    return cssText;
}

async function removeAttributes(element) {
    const elementsWithDataId = element.querySelectorAll('[data-id]');
    for (const elem of elementsWithDataId) {
        elem.removeAttribute('data-id');
    }
    const elementsWithId = element.querySelectorAll('[id]');
    for (const elem of elementsWithId) {
        elem.removeAttribute('id');
    }
}

export const copyHtmlToClipboard = async (html, plainText) => {
    // Fetch all CSS rules from the stylesheets
    const css = await getAllCssRules();

    // Create an HTML string with the provided HTML and CSS
    const completeHtml = `
        <style>
            ${css}
        </style>
        ${html}
    `;

    // Create a temporary DOM node and set its innerHTML
    const tempNode = document.createElement('div');
    tempNode.innerHTML = completeHtml;

    // Convert all images to Data URLs
    await convertImagesToDataUrl(tempNode);

    // Remove data-id attributes
    await removeAttributes(tempNode);

    // Serialize the node to an HTML string
    const htmlString = tempNode.innerHTML;

    // Create a Blob object containing the HTML string
    const htmlBlob = new Blob([htmlString], { type: 'text/html' });

    // Create a Blob object containing the plain text
    const textBlob = new Blob([plainText], { type: 'text/plain' });

    // Create a ClipboardItem object with both HTML and plain text
    const clipboardItem = new ClipboardItem({
        'text/html': htmlBlob,
        'text/plain': textBlob
    });

    // Write the ClipboardItem to the clipboard
    try {
        await navigator.clipboard.write([clipboardItem]);
        console.log('HTML with embedded images and CSS copied to clipboard');
    } catch (err) {
        console.error('Failed to copy HTML: ', err);
    }
}

