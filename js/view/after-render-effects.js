"use strict";

/* This allows us to make modifications to the DOM after the initial render,
which means that this can all be separate from the main cache and render logic,
and allows for stuff like highlighted text, animations, etc... */

let $effects = (function() {

    const DARKEN_UNSELECTED_ITEMS = false;
    const APPLY_CLIPBOARD_SUBSTITUTIONS_INTO_EXEC = true; //TODO: speed this up at some point?

	let highlight_item_ids = [];
	let shadow_item_ids = [];
    let emphasis_subitem_paths = [];

    let updatesCache = {};

	function temporary_highlight(id) {
        if (highlight_item_ids.includes(id) === false) {
		  highlight_item_ids.push(id);
        }
	}

	function temporary_shadow(id) {
        if (shadow_item_ids.includes(id) === false) {
		  shadow_item_ids.push(id);
        }
	}

    function emphasizeSubitem(path) {
        emphasis_subitem_paths.push(path);
    }

    function emphasizeSubitemAndChildren(item, path) {
        emphasis_subitem_paths.push(path);
        let subitem_index = parseInt(path.split(':')[1]);
        for (let i = subitem_index + 1; i < item.subitems.length; i++) {
            if (item.subitems[i].indent <= item.subitems[subitem_index].indent) {
                break;
            }
            emphasis_subitem_paths.push(item.id+':'+i);
        }
    }

    function emphasisSubitemHighlights() {
        for (let path of emphasis_subitem_paths) {
            let $el = $("div").find(`[data-subitem-path='${path}']`);
            $el.removeClass('temporary-highlight-at-instant');
            $el.removeClass('temporary-highlight-after');
            $el.addClass('temporary-highlight-at-instant');
            window.setTimeout(function() {
                $el.addClass('temporary-highlight-after');
            }, 1);
        }
    }

    function priorityHighlights(highlight_item_ids, shadow_item_ids) {
        for (let id of highlight_item_ids) {
            let $el = $("div").find(`[data-item-id='${id}']`);
            $el.removeClass('temporary-highlight-at-instant');
            $el.removeClass('temporary-highlight-after');
            $el.addClass('temporary-highlight-at-instant');
            window.setTimeout(function() {
                $el.addClass('temporary-highlight-after');
            }, 1);
        }

        for (let id of shadow_item_ids) {
            let $el = $("div").find(`[data-item-id='${id}']`);

            $el.removeClass('temporary-highlight-at-instant');
            $el.removeClass('temporary-highlight-after');

            $el.addClass('temporary-shadow-at-instant');
            window.setTimeout(function() {
                $el.addClass('temporary-shadow-after');
            }, 1);
        }
    }

    function clipboard_substitutions(selectedItem) {
        let clipboard_text = $main_controller.getClipboardText();
        if (clipboard_text !== undefined && clipboard_text !== null && clipboard_text !== '') {
            clipboard_text = escapeHtmlWithSpaces(clipboard_text);
            let matches = 0;
            const items = $model.getUnsortedItems();
            for (let item of items) {
                if (item.subitems[0]._include !== 1) {
                    continue;
                }
                if (selectedItem !== null && item.id === selectedItem.id) {
                    console.warn('Do not attempt to render items in edit mode.');
                    continue;
                }
                for (let i = 0; i < item.subitems.length; i++) {
                    let subitem = item.subitems[i];
                    if (subitem._include === -1) {
                        continue;
                    }
                    if (item.collapse !== undefined && item.collapse === 1 && i > 0) {
                        break;
                    }
                    if (subitem._direct_tags.includes(META_SHELL) && 
                        subitem.data.includes(CLIPBOARD_ESCAPE_SEQUENCE)) {
                        matches += 1;
                        let path = item.id + ':'+i;
                        let query = "[data-subitem-path='"+path+"']";
                        let $el1 = $(query)[0];
                        let $el2 = $($el1).find('code');
                        let html = $($el2).html();
                        if (html === undefined) {
                            console.error('html is undefined');
                        }
                        html = html.replace(CLIPBOARD_ESCAPE_SEQUENCE, clipboard_text);
                        //TODO: make this more efficient
                        $el2.html(html);
                    }
                }
            }
        }
    }

    function set_link_targets() {
        $("a").attr("target","_blank");
    }

    function loadImages(selectedItem) {
        const items = $model.getUnsortedItems();
        for (let item of items) {
            if (item.subitems[0]._include === -1) {
                continue;
            }
            if (selectedItem !== null && selectedItem.id === item.id) {
                continue;
            }

            for (let i = 0; i < item.subitems.length; i++) {
                let subitem = item.subitems[i];
                if (subitem._include === -1) {
                    continue;
                }
                if (subitem._direct_tags.includes(META_IMAGE) ||
                    subitem._direct_tags.includes(META_IMAGE_LARGE) ||
                    subitem._direct_tags.includes(META_IMAGE_MEDIUM) ||
                    subitem._direct_tags.includes(META_IMAGE_SMALL)) {
                    //TODO: check for valid file format
                    //asdf
                    let path = item.id + ':'+i;
                    let query = "[data-subitem-path='"+path+"']";
                    let $el = $(query).eq(0);
                    let html = $($el).html();
                    // Example
                    // http://localhost:3000/image?path=/home/thomas/Desktop/random-forest.png
                    let width = 'width="300"';
                    if (subitem._direct_tags.includes(META_IMAGE_LARGE)) {
                        width = 'width="750"';
                    }
                    else if (subitem._direct_tags.includes(META_IMAGE_MEDIUM)) {
                        width = 'width="500"';
                    }
                    else if (subitem._direct_tags.includes(META_IMAGE_SMALL)) {
                        width = 'width="300"';
                    }
                    let uri = encodeURI(subitem.data.trim());
                    let img = '<a href="/image?path='+uri+'" target="_blank"><img src="/image?path='+uri+'" '+width+'></a>';
                    html = html.replace(subitem.data, img);
                    $el.html(html);
                }
            }
        }
    }

    function highlightsFromTextSearch(selectedItem) {
        let t1 = Date.now();
        let search = $auto_complete_search.getSearchString();
        let parse = $parseSearch.parse(search);
        let highlights = [];
        for (let part of parse) {
            if (part.type !== 'substring') {
                continue;
            }
            if (part.negated !== undefined) {
                continue
            }
            if (part.text === undefined) {
                console.warn('part.text undefined in parse result');
                continue;
            }
            highlights.push(part.text);
        }
        if (highlights.length === 0) {
            return;
        }
        const items = $model.getUnsortedItems();
        for (let item of items) {
            if (item.subitems[0]._include === -1) {
                continue;
            }
            if (selectedItem !== null && selectedItem.id === item.id) {
                continue;
            }
            for (let i = 0; i < item.subitems.length; i++) {
                let subitem = item.subitems[i];
                if (subitem._include === -1) {
                    continue;
                }
                for (let highlight of highlights) {
                    if (highlight === undefined) {
                        console.warn('highlight is undefined?');
                        continue;
                    }
                    if (highlight.length < 2) {
                        continue;
                    }
                    if (v.lowerCase(subitem.data).includes(v.lowerCase(highlight)) === false) {
                        continue;
                    }
                    let path = item.id+':'+i;
                    maybeMatchAndEnhance(subitem, path, highlight, '<span class="highlight-substring-from-search">$1</span>');
                }
            }
        }
        let t2 = Date.now();
    }

    function maybeMatchAndEnhance(subitem, path, pattern, replacement) {
        let data = subitem.data;
        if (updatesCache[path] !== undefined) {
            data = updatesCache[path];
        }
        if (v.lowerCase(data).includes(v.lowerCase(pattern))) {
            let escapedRegex = v.escapeRegExp(pattern);
            let rgxp = new RegExp('('+escapedRegex+')', 'gi');
            let repl = replacement;
            let updated = data.replace(rgxp, repl);
            if (updated !== data) {
                updatesCache[path] = updated;
            }
        }
    }

    function darkenUnselected(selectedItem) {
        if (selectedItem === null) {
            return;
        }
        $('div.item').addClass('darken-unselected-item');
        let div = $view.getItemElementById(selectedItem.id);
        $(div).removeClass('darken-unselected-item');
    }

	function apply_post_render_effects(selectedItem) {

        //TODO: we should never be throwing this error
        try {

            updatesCache = {};

            priorityHighlights(highlight_item_ids, shadow_item_ids)

            if (APPLY_CLIPBOARD_SUBSTITUTIONS_INTO_EXEC) {
                clipboard_substitutions(selectedItem);
            }

            loadImages(selectedItem);

            emphasisSubitemHighlights(emphasis_subitem_paths);

            highlightsFromTextSearch(selectedItem);

            if (DARKEN_UNSELECTED_ITEMS) {
                darkenUnselected(selectedItem);
            }

            Prism.highlightAll();

            for (let key of Object.keys(updatesCache)) {
                let el = $view.getSubitemElementByPath(key);
                $(el).html(updatesCache[key]);
            }

            ///////////////////////////////////////////////////////

            set_link_targets();
            
        }
        catch (e) {
            console.error(e);
        }

        //reset stuff
        highlight_item_ids = [];
        shadow_item_ids = [];
        emphasis_subitem_paths = [];
	}

	return {
		temporary_highlight: temporary_highlight,
		temporary_shadow: temporary_shadow,
		apply_post_render_effects: apply_post_render_effects,
        emphasizeSubitem: emphasizeSubitem,
        emphasizeSubitemAndChildren: emphasizeSubitemAndChildren
	}

})();