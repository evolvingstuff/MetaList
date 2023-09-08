"use strict";


import {parseMarkdown, parseJson} from '../js/formats.js';

const numberedListChar = '.';  //TODO: make this configurable

export const itemFormatter = (item, selectedItemSubitemId) => {
    function applyFormatting(itemSubitemId, html, tags) {
        let formattedHtml = html;

        //TODO: if subitem is selected, do not do parsing!

        if (tags.includes('@markdown')) {
            //TODO 2023.03.05: this isn't rendering properly
            //console.log('debug: parseMarkdown...')
            formattedHtml = parseMarkdown(formattedHtml);
        }
        else if (tags.includes('@json')) {
            //TODO 2023.03.05: this isn't rendering properly
            formattedHtml =  parseJson(formattedHtml);
        }
        //TODO 2023.03.05: LaTeX isn't rendering properly

        //TODO 2023.03.05:
        // 1. link rewriting
        // 2.

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
        if (tags.includes('@password')) {
            classes.push('tag-password');
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
    let offsetPerIndent = 2;  // 2
    let downArrow = `<img src="../img/caret-down-filled.svg" class="arrow" />`;
    let rightArrow = `<img src="../img/caret-right-filled.svg" class="arrow" />`;
    let bullet = '&#x2022';
    let todo = `<img src="../img/checkbox-unchecked.svg" class="todo" />`;
    let done = `<img src="../img/checkbox-checked.svg" class="todo" />`;

    //TODO: list_parents should be defined here
    let atLeastOneParentIsAList = false;

    let subitemIndex = 0;
    for (let subitem of item.subitems) {

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

        if (tags.includes('@list-bulleted') ||
            tags.includes('@list-numbered')) {
            atLeastOneParentIsAList = true;
        }

        let formattedData = '';
        if (itemSubitemId === selectedItemSubitemId) {
            //we don't want to do formatting/parsing when in an editing mode
            formattedData = subitem.data;
        }
        else {
            formattedData = applyFormatting(itemSubitemId, subitem.data, tags);
        }

        let column_start = subitem.indent * offsetPerIndent + 1;  // 1 based and give room for the bullet and expand arrow

        if (subitem._match === undefined) {
            //TODO this may eventually depend on redaction mode
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
            content += `<div data-id="${itemSubitemId}" class="subitem ${classes.join(' ')}" style="grid-row: ${gridRow}; grid-column-start: ${column_start};">${formattedData}</div>`;
        }
        gridRow++;
        subitemIndex++;
    }
    content += '</div>';
    return content;
}

