"use strict";
let $auto_complete_tags = (function () {

    let selected_tag_suggestion_id = 0;

    let IGNORE_LIST = ['a', 'an', 'the', 'there', 
        'their', 'these', 'those', 'we', 'they', 
        'them', 'I', 'me', 'she', 'he', 'and',
        'has','got','to'];

    let PRIORITY_RANK = false; //true doesn't work as well it seems
    let SUGGEST_ENRICHED_IMPLICATIONS = true;
    let LITERAL_SUGGESTIONS = true;
    let LITERAL_PHRASE_SUGGESTIONS = true;
    let GENERIC_SUGGESTIONS = true;
    let REMOVE_REDUNDANT_IMPLICATIONS = true;
    let ALWAYS_ADD_SPACE_TO_SUGGESTION = true;

    let MAX_SUGGESTIONS = 100; //100

    let _cache = {};

    let mode_hidden = true;

    function getModeHidden() {
        return mode_hidden;
    }

    function _updateDataList(item, phrases) {
        let $div = $('[data-item-id='+item.id+']')[0];
        let $sugg = $($div).find('.tag-suggestions')[0];
        applyPhrases($sugg, phrases);
    }

    function applyPhrases($div, phrases) {
        let suggestion_id = 1;
        let html = '';
        for (let i = 0; i < phrases.length; i++) {
            html += '<div data-tag-suggestion-id="'+suggestion_id+'" data-tag-suggestion="'+phrases[i]+'" class="tag-suggestion">'+phrases[i]+'</div>';
            suggestion_id++;
        }
        $div.innerHTML = html;
        if (phrases.length == 0) {
            hideOptions();
        }
        else {
            showOptions();
        }
    }

    function hideOptions() {
        $('.tag-suggestions').css('display', 'none');
        mode_hidden = true;
    }

    function showOptions() {
        $('.tag-suggestions').css('display', 'block');
        $('.tag-suggestions').css('z-index', '100');
        mode_hidden = false;
    }

    function getLiteralSuggestions(items, data, partial_tag) {

        //TODO: factor this out! Repeated in parse-tagging.js

        console.log('getLiteralSuggestions');

        let start = Date.now();

        function _getValidTags(items) {
            let map = {};

            //TODO: cache in here
            let set_tags = new Set();
            for (let item of items) {
                //TODO: flatten and use ._tags
                let s_tags = $model.getItemTags(item);
                for (let tag of s_tags.split(' ')) {
                    //set_tags.add(tag);

                    let lower_tag = tag.toLowerCase();

                    if (partial_tag != null && lower_tag.startsWith(partial_tag.toLowerCase()) == false) {
                        //console.log('skipping ' + tag);
                        continue;
                    }

                    map[lower_tag] = tag;
                }
            }
            return map;
        }
        
        let start1 = Date.now();
        let tags = _getValidTags(items);
        let end1 = Date.now();
        console.log((end1-start1) + 'ms getting valid tags');

        let temp = data;
        temp = temp.replace('&nbsp;', ' ');
        temp = temp.replace('&gt;', '>');
        temp = temp.replace('&lt;', '<');
        //TODO: more replacements here?

        let words = temp.replace(/\b[-.,()&$#!\[\]{}"':]+\B|\B[-.,()&$#!\[\]{}"':]+\b/g, "").split(' ');

        let result = [];

        for (let word of words) {
            let low_word = word.toLowerCase();

            if (IGNORE_LIST.includes(low_word)) {
                continue;
            }

            if (tags[low_word] != undefined) {
                console.log('Tag match on "'+word+'" -> ' + tags[low_word]);
                result.push(tags[low_word]);
            }

            let alterations = ["es", "s", "'s", "ed", "ing", "ly"];

            for (let alt of alterations) {
                let re = new RegExp('(.*?)'+alt+'$'); //TODO: precompile
                let low_word_alt_minus = low_word.replace(re, '$1');
                //console.log('\t'+low_word_alt_minus);
                if (tags[low_word_alt_minus] != undefined) {
                    console.log('Tag match on "'+low_word_alt_minus+'" -> ' + tags[low_word_alt_minus]);
                    result.push(tags[low_word_alt_minus]);
                    continue;
                }
                let low_word_alt_plus = low_word + alt;
                //console.log('\t'+low_word_alt_plus);
                if (tags[low_word_alt_plus] != undefined) {
                    console.log('Tag match on "'+low_word_alt_plus+'" -> ' + tags[low_word_alt_plus]);
                    result.push(tags[low_word_alt_plus]);
                    continue;
                }
            }
        }

        let end = Date.now();
        console.log('literal suggestions took ' + (end-start) + 'ms');
        return result;
    }

    function getLiteralPhraseSuggestions(items, data, partial_tag) {

        console.log('getLiteralPhraseSuggestions()');
        

        //TODO: factor this out! Repeated in parse-tagging.js

        console.log('getLiteralPhraseSuggestions');

        let start = Date.now();

        function _getValidTags(items) {

            let map = {};

            let imps = $ontology.getImplications(); //asdf

            //TODO: cache in here
            //TODO: need to add all meta-tags that were not attached to an item!
            let set_tags = new Set();
            for (let item of items) {
                //TODO: flatten and use ._tags
                let s_tags = $model.getItemTags(item);
                for (let tag of s_tags.split(' ')) {
                    if (tag.includes('-') || tag.includes('_')) { //TODO: more combiners?
                        let lower_tag = tag.toLowerCase();
                        if (partial_tag != null && lower_tag.startsWith(partial_tag.toLowerCase()) == false) {
                            //console.log('skipping ' + tag);
                            continue;
                        }
                        map[lower_tag] = tag;

                    }
                }
            }

            for (let imp in imps) {
                for (let tag of imps[imp]) {
                    if (tag.includes('-') || tag.includes('_')) { //TODO: more combiners?
                        let lower_tag = tag.toLowerCase();
                        if (partial_tag != null && lower_tag.startsWith(partial_tag.toLowerCase()) == false) {
                            //console.log('skipping ' + tag);
                            continue;
                        }
                        map[lower_tag] = tag;
                    }
                }       
            }
            return map;
        }
        
        let start1 = Date.now();
        let tags = _getValidTags(items);
        let end1 = Date.now();
        console.log((end1-start1) + 'ms getting valid tags');

        let temp = data;
        temp = temp.replace('&nbsp;', ' ');
        temp = temp.replace('&gt;', '>');
        temp = temp.replace('&lt;', '<');
        //TODO: more replacements here?

        let words = temp.replace(/\b[-.,()&$#!\[\]{}"':]+\B|\B[-.,()&$#!\[\]{}"':]+\b/g, "").split(' ');

        let result = [];

        for (let i = 0; i < words.length-1; i++) {
            let low_word1 = words[i].toLowerCase();
            let low_word2 = words[i+1].toLowerCase();

            let combiners = ['-','_'];

            for (let combiner of combiners) {
                let low_phrase = low_word1 + combiner + low_word2;
                //console.log('\ttrying phrase ' + low_phrase);
                if (tags[low_phrase] != undefined) {
                    console.log('Phrase match on "'+low_word1+' '+low_word2+'" -> ' + tags[low_phrase]);
                    result.push(tags[low_phrase]);
                }

                let low_phrase_reverse = low_word2 + combiner + low_word1;
                if (tags[low_phrase_reverse] != undefined) {
                    console.log('Phrase match on "'+low_word2+' '+low_word1+'" -> ' + tags[low_phrase_reverse]);
                    result.push(tags[low_phrase_reverse]);
                }
            }
        }

        let end = Date.now();
        console.log('literal phrase suggestions took ' + (end-start) + 'ms');
        return result;
    }

    function getSuggestions(items, item, subitem, parse_results) {

        let timer = new Timer("SUGGEST TIMER");
        let h = hashCode(JSON.stringify(subitem)+JSON.stringify(parse_results));
        //BUG: this is never called because items will have new _timestamp_update values
        if (_cache[h] != undefined) {
            console.log('*cached');
            timer.end();
            timer.display();
            return _cache[h];
        }

        let words = [];
        for (let parse_result of parse_results) {
            words.push(parse_result.text);
        }
        let words_text = words.join(' ');
        let prefix = '';
        if (parse_results.length > 0) {
            for (let i = 0; i < parse_results.length; i++) {
                if (parse_results[i].partial == true) {
                    //console.log('partial, skip');
                }
                else {
                    prefix += parse_results[i].text + ' ';
                }
            }
            let last = parse_results[parse_results.length-1];
            if (last.partial == true) {
                let phrases = [];
                let possible_phrases = _suggestNew(items, subitem, prefix, last.text);
                //Test if this is a valid completion of current word
                for (let possible_phrase of possible_phrases) {
                    //TODO also allow a match where last term has different capitalization
                    if (possible_phrase.startsWith(words_text) && possible_phrase != words_text) {
                        phrases.push(possible_phrase);
                    }
                }
                timer.end();
                timer.display();
                _cache[h] = phrases;
                return phrases;
            }
            else {
                let phrases = _suggestNew(items, subitem, prefix, null);
                timer.end();
                timer.display();
                _cache[h] = phrases;
                return phrases;
            }
        }
        else {
            console.log('No parse results, handle this!');
            let phrases = _suggestNew(items, subitem, prefix, null);
            timer.end();
            timer.display();
            _cache[h] = phrases;
            return phrases;
        }

        
    }

    function _suggestNew(items, subitem, prefix, partial_tag) {

        //console.log('_suggestNew() prefix = "'+prefix+'" partial = ' + partial_tag);

        let phrases = [];

        let literals = [];

        //prioritize phrase suggestions before single term ones
        if (LITERAL_PHRASE_SUGGESTIONS) {
            literals = getLiteralPhraseSuggestions(items, subitem.data, partial_tag);
            let prefix_words = prefix.split(' ');
            for (let tag of literals) {
                if (prefix_words.includes(tag)) {
                    continue;
                }
                let phrase = prefix+tag;
                if (phrases.includes(phrase) == false) {
                    phrases.push(phrase);
                }
            }
        }

        if (LITERAL_SUGGESTIONS) {
            literals = getLiteralSuggestions(items, subitem.data, partial_tag);
            let prefix_words = prefix.split(' ');
            for (let tag of literals) {
                if (prefix_words.includes(tag)) {
                    continue;
                }
                let phrase = prefix+tag;
                if (phrases.includes(phrase) == false) {
                    phrases.push(phrase);
                }
            }
        }

        

        let struct = {};
        for (let item of items) {
            let flat = $model.flatten(item);
            for (let sub of flat) {
                let match_tot = 0;
                let suggestions = [];

                if (SUGGEST_ENRICHED_IMPLICATIONS) {
                    let enriched = $ontology.getEnrichedTags(sub._tags);
                    for (let tag of enriched) {

                        let lower_tag = tag.toLowerCase();
                        
                        if (partial_tag != null && lower_tag.startsWith(partial_tag.toLowerCase()) == false) {
                            continue;
                        }
                        
                        if (subitem._tags.includes(tag)) {
                            match_tot += 1;
                        }
                        if (literals.includes(tag)) {
                            match_tot += 1;
                        }
                    }
                }

                //specific
                for (let tag of sub._tags) {

                    let lower_tag = tag.toLowerCase();
                    
                    if (partial_tag != null && lower_tag.startsWith(partial_tag.toLowerCase()) == false) {
                        continue;
                    }

                    if (subitem._tags.includes(tag) == false) {
                        //capture suggestions here
                        suggestions.push(tag);
                    }
                }

                if (match_tot > 0 && suggestions.length > 0) {
                    //console.log('tot = ' + tot);
                    if (struct[match_tot] == undefined) {
                        struct[match_tot] = {};
                    }
                    for (let sug of suggestions) {

                        if (PRIORITY_RANK) {
                            if (struct[match_tot][sug] == undefined) {
                                struct[match_tot][sug] = item.priority;
                            }
                            else {
                                struct[match_tot][sug] += Math.min(item.priority, struct[match_tot][sug]);
                            }
                        }
                        else {
                            if (struct[match_tot][sug] == undefined) {
                                struct[match_tot][sug] = 1;
                            }
                            else {
                                struct[match_tot][sug] += 1;
                            }
                        }
                    }
                }
            }
        }

        let levels = [];
        for (let level in struct) {
            levels.push(level);
        }
        levels.sort();

        levels.reverse();
        
        let MAX_LEVELS = 10;

        //get rid of implications but NOT reverse implications
        let implications = $ontology.getImplications();
        let ignore = new Set();
        for (let tag of subitem._tags) {
            if (implications[tag] != undefined) {
                for (let key of implications[tag]) {
                    ignore.add(key);
                }
            }
        }

        for (let tag of subitem._tags) {
            ignore.add(tag);
        }

        for (let i = 0; i < Math.min(levels.length, MAX_LEVELS); i++) {

            if (phrases.length >= MAX_SUGGESTIONS) {
                break;
            }

            let level = levels[i];
            let sortable = [];
            for (let tag in struct[level]) {
                sortable.push({name:tag, val: struct[level][tag]});
            }
            if (PRIORITY_RANK) {
                sortable.sort(function(a, b){
                    return a.val - b.val;
                });
            }
            else {
                sortable.sort(function(a, b){
                    return a.val - b.val;
                });
                sortable.reverse();
            }
            
            for (let tag of sortable) {
                if (ignore.has(tag.name)) {
                    //console.log('DEBUG: ignoring ' + tag.name);
                    continue;
                }
                if (phrases.includes(tag.name) == false) {
                    let phrase = prefix+tag.name;
                    if (phrases.includes(phrase) == false) {
                        phrases.push(prefix+tag.name);
                    }
                }
            }
        }

        if (GENERIC_SUGGESTIONS && phrases.length < MAX_SUGGESTIONS) {
            let list = $model.getEnrichedAndSortedTagList(items);

            for (let tag of list) {

                if (phrases.length >= MAX_SUGGESTIONS) {
                    break;
                }

                let lower_tag = tag.tag.toLowerCase();

                if (partial_tag != null && lower_tag.startsWith(partial_tag.toLowerCase()) == false) {
                    continue;
                }
                let phrase = prefix+tag.tag;
                if (phrases.includes(phrase) == false) {
                    phrases.push(phrase);
                }
                
            }
        }

        console.log('suggesting ' + phrases.length + ' phrases');

        //Get rid of redundant implications
        if (REMOVE_REDUNDANT_IMPLICATIONS) {
            let edited = [];
            for (let phrase of phrases) {
                let redundant = false;
                let parts = phrase.split(' ');
                for (let i = 0; i < parts.length-1; i++) {
                    let w1 = parts[i];
                    let w2 = parts[parts.length-1];
                    if (implications[w1] != undefined && implications[w1].includes(w2)) {
                        console.log('REDUNDANT: ' + w1 + ' ' + w2);
                        redundant = true;
                        break;
                    }
                    if (w1 == w2) {
                        redundant = true;
                        break;
                    }
                    //By not removing the implication this way, we always allow for suggesting simpler things
                    /*
                    if (implications[w2] != undefined && implications[w2].includes(w1)) {
                        console.log('REDUNDANT: ' + w2 + ' ' + w1);
                        redundant = true;
                        break;
                    }
                    */
                }
                if (redundant == false) {
                    edited.push(phrase);
                }
            }
            phrases = edited;
        }

        phrases = phrases.slice(0, MAX_SUGGESTIONS);

        return phrases;
    }

    function selectSuggestion(items, item, selectedSubitemPath) {
        if (selected_tag_suggestion_id == 0) {
            return;
        }
        let choice = $('[data-tag-suggestion-id='+selected_tag_suggestion_id+']').attr('data-tag-suggestion');
        console.log('choice = ' + choice);

        if (ALWAYS_ADD_SPACE_TO_SUGGESTION) {
            choice = choice + ' ';
        }

        if (selectedSubitemPath == '' || selectedSubitemPath == null) {
            $model.updateTag(item, choice);
        }
        else {
            $model.updateSubTag(item, selectedSubitemPath, choice);
        }
        $view.updateTag(item, choice);
        onChange(items, item, selectedSubitemPath);
    }

    function updateSelectedTagSuggestion(id=0) {
        if (selected_tag_suggestion_id != 0) {
            $('[data-tag-suggestion-id='+selected_tag_suggestion_id+']').removeClass('selected-tag-suggestion');
        }
        if (id >= 0) {
            selected_tag_suggestion_id = id;
        }
        if (selected_tag_suggestion_id != 0) {
            $('[data-tag-suggestion-id='+selected_tag_suggestion_id+']').addClass('selected-tag-suggestion');
        }
    }

    function onChange(items, item, selectedSubitemPath) {
        showOptions();
        console.log('item.id = ' + item.id + ' / subitem path = ' + selectedSubitemPath);
        let subitem = null;
        if (selectedSubitemPath == null) {
            subitem = item;
        }
        else {
            subitem = $model.getSubitem(item, selectedSubitemPath);
        }

        let parse_results = $parseTagging(items, subitem.tags);

        if (parse_results == null) {
            console.log('ILLEGAL PARSE');
            //TODO: how to deal with this visually? Or just don't allow it to be typed?
            $view.illegalTag(item);
        }
        else {
            //console.log('parse_results: ' + JSON.stringify(parse_results));
            let phrases = getSuggestions(items, item, subitem, parse_results);
            _updateDataList(item, phrases);
            updateSelectedTagSuggestion();
            $view.legalTag(item);
        }
    }

    function arrowUp() {
        console.log('arrow up todo');
        updateSelectedTagSuggestion(selected_tag_suggestion_id-1);
    }

    function arrowDown() {
        console.log('arrow down todo');
        updateSelectedTagSuggestion(selected_tag_suggestion_id+1);
    }


    return {
        onChange: onChange,
        hideOptions: hideOptions,
        showOptions: showOptions,
        updateSelectedTagSuggestion: updateSelectedTagSuggestion,
        selectSuggestion: selectSuggestion,
        arrowUp: arrowUp,
        arrowDown: arrowDown,
        getModeHidden: getModeHidden
    };
})();
