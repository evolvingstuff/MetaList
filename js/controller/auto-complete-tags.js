"use strict";
let $auto_complete_tags = (function () {

    let selected_tag_suggestion_id = 0;

    let IGNORE_LIST = ['a', 'an', 'the', 'there', 
        'their', 'these', 'those', 'we', 'they', 
        'them', 'I', 'me', 'she', 'he', 'and',
        'has','got','to', 'not', 'no', 'new'];

    let PRIORITY_RANK = false; //true doesn't work as well it seems
    let SUGGEST_ENRICHED_IMPLICATIONS = true;
    let LITERAL_SUGGESTIONS = true;
    let LITERAL_PHRASE_SUGGESTIONS = true;
    let GENERIC_SUGGESTIONS = true;
    let ALWAYS_ADD_SPACE_TO_SUGGESTION = true;
    let TRIPLE_WORD_PHRASES = true;

    let SUGGEST_META = true;
    let SUGGESTED_META = [
                            '@date','@meta','@todo','@done',
                            '@bug','@goto-search',
                            '@username', '@password','@email',
                            '@private','@hide','@copy',
                            '@markdown','@csv','@LaTeX','@code',
                            '@html','@href','@bold',
                            '@h1','@h2','@h3','@h4',
                            '@red','@green','@blue','@grey'
                        ];

    let MAX_SUGGESTIONS = 50; //100

    let _cache = {};

    let mode_hidden = true;

    function resetCache() {
        _cache = {};
    }

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

        //console.log('getLiteralSuggestions');
        //console.log('data = "'+data+'"');

        let start = Date.now();

        function _getValidTags(items) {
            let map = {};

            //TODO: cache in here
            let set_tags = new Set();
            for (let item of items) {
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

        let temp = data
            .replace(/&nbsp;/g, ' ')
            .replace(/&gt;/g, '>')
            .replace(/&lt;/g, '<')
            .replace(/<br>/g,' ')
            .replace(/\\n/g, ' ');
        //TODO: more replacements here?

        let words = temp.replace(/\b[-.,()&$#!\[\]{}"':]+\B|\B[-.,()&$#!\[\]{}"':]+\b/g, "").split(' ');
        
        //console.log(words);

        let result = [];

        for (let word of words) {

            if (word == '') {
                continue;
            }

            let low_word = word.toLowerCase();

            if (IGNORE_LIST.includes(low_word)) {
                continue;
            }

            if (tags[low_word] != undefined) {
                if (word.length == 0) {
                    alert("BUG");
                }
                result.push(tags[low_word]);
            }

            let alterations = ["es", "s", "'s", "ed", "ing", "ly", "."];

            //TODO: "strategies" -> "strategy"

            for (let alt of alterations) {
                let re = new RegExp('(.*?)'+alt+'$'); //TODO: precompile
                let low_word_alt_minus = low_word.replace(re, '$1');
                if (tags[low_word_alt_minus] != undefined) {
                    result.push(tags[low_word_alt_minus]);
                }
                let low_word_alt_plus = low_word + alt;
                if (tags[low_word_alt_plus] != undefined) {
                    result.push(tags[low_word_alt_plus]);
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

            let imps = $ontology.getImplications();

            //TODO: cache in here
            //TODO: need to add all meta-tags that were not attached to an item!
            let set_tags = new Set();
            for (let item of items) {
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
                    if (tag == ' ') {
                        continue;
                    }
                    if (tag.startsWith('@')) {
                        continue;
                    }
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

        if (TRIPLE_WORD_PHRASES) {
            for (let i = 0; i < words.length-2; i++) {
                let low_word1 = words[i].toLowerCase();
                let low_word2 = words[i+1].toLowerCase();
                let low_word3 = words[i+2].toLowerCase();

                let combiners = ['-','_'];

                for (let combiner of combiners) {
                    let low_phrase = low_word1 + combiner + low_word2 + combiner + low_word3;
                    if (tags[low_phrase] != undefined) {
                        console.log('Phrase match on "'+low_word1+' '+low_word2+' '+low_word3+'" -> ' + tags[low_phrase]);
                        result.push(tags[low_phrase]);
                    }
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
            let tag = parse_result.text;
            if (parse_result.value != undefined) { //this handles numeric tags
                tag += '='+parse_result.value;
            }
            words.push(tag);
        }
        let words_text = words.join(' ');
        let prefix = '';
        if (parse_results.length > 0) {
            for (let i = 0; i < parse_results.length; i++) {
                if (parse_results[i].partial == true) {
                    //console.log('partial, skip');
                }
                else {
                    prefix += parse_results[i].text
                    //handle numeric
                    if (parse_results[i].value != undefined) {
                        prefix += '='+parse_results[i].value;
                    }
                    prefix += ' ';
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
            for (let sub of item.subitems) {
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

        if (SUGGEST_META) {
            let parts = subitem.tags.split(' ');
            if (parts.length > 0) {
                let end = parts[parts.length-1];

                for (let meta of SUGGESTED_META) {
                    if (meta.startsWith(end)) {
                        let phrase = prefix+meta;
                        if (phrases.includes(phrase) == false) {
                            phrases.push(phrase);
                        }
                    }
                }
            }
        }

        //Get rid of redundant implications
        let edited = [];
        for (let phrase of phrases) {
            let redundant = false;
            let parts = phrase.split(' ');

            if (parts[parts.length-1].startsWith('@') && partial_tag == null) {
                continue; //don't suggest special tags unless we've started typing it
            }

            for (let i = 0; i < parts.length-1; i++) {
                let w1 = parts[i].trim();
                let w2 = parts[parts.length-1].trim();
                if (implications[w1] != undefined && implications[w1].includes(w2)) {
                    redundant = true;
                    break;
                }
                if (w1 == w2) {
                    redundant = true;
                    break;
                }
            }
            if (redundant == false) {
                edited.push(phrase);
            }
        }
        phrases = edited;
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
            subitem = item.subitems[0];
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
        getModeHidden: getModeHidden,
        resetCache: resetCache
    };
})();
