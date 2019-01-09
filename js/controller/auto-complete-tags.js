"use strict";
let $auto_complete_tags = (function () {

    let selected_tag_suggestion_id = 0;

    let DEVELOPER_MODE = false;

    let IGNORE_LIST = ['a', 'an', 'the', 'there', 
        'their', 'these', 'those', 'we', 'us', 'they', 
        'them', 'I', 'me', 'my', 'she', 'he', 'and', 'our', 'ours',
        'him', 'her', 'his', 'hers', 'and',
        'has', 'have', 'got', 'get', 'to', 'not', 'no', 
        'new', 'for', 'from', 'it', 'that', 'this',
        'because', 'before', 'after', 'during',
        'when', 'where', 'who', 'why', 'at', 'all',
        'under', 'over', 'also', 'too', 'yes', 'yeah',
        'ever', 'every', 'everything', 'nothing', 'nowhere',
        'always', 'never', 'sure', 'if', 'else', 'elsewhere',
        'going', 'above', 'below', 'around', 'inside', 'in', 
        'between', 'inbetween', 'now', 'then', 'some', 'none',
        'maybe', 'surely', 'ago', 'with', 'without',
        'should', 'shouldn\'t',
        'would', 'wouldn\'t',
        'could', 'couldn\'t',
        'did', 'didn\'t',
        'will', 'won\'t',
        'does', 'doesn\'t',
        'can', 'cannot', 'can\'t',
        'are', 'aren\'t',
        'of', 'on', 'be', 'as', 'is', '/'];

    let LITERAL_SUGGESTIONS_OF_EXISTING_TAGS = true;
    let LITERAL_PHRASE_SUGGESTIONS_OF_EXISTING_TAGS = true;
    let TRIPLE_WORD_PHRASES_OF_EXISTING_TAGS = true;

    let SUGGEST_ENRICHED_IMPLICATIONS = true;
    
    let GENERIC_SUGGESTIONS = true;
    let ALWAYS_ADD_SPACE_TO_SUGGESTION = true;

    let SUGGEST_NEW_TAGS_FROM_TEXT = true;
    let SUGGEST_NEW_TAGS_FROM_TEXT_DOUBLE_WORD = false;
    let SUGGEST_NEW_TAGS_FROM_TEXT_TRIPLE_WORD = false;

    let SUGGEST_ACRONYMS = true;
    let MIN_ACRONYM_LENGTH = 3;
    let MAX_ACRONYM_LENGTH = 5;

    let SUGGEST_NUMERIC_TAGS_WITH_VALUES = true;

    let SUGGEST_META = true;
    let SUGGESTED_META = [
                            '@date-headline','@meta','@todo','@done',
                            '@fold', '@unfold',
                            '@numbered','@bulleted',
                            '@goto-search',
                            '@username', '@password','@email',
                            '@private','@hide','@copy',
                            '@preview',
                            '@markdown','@csv','@LaTeX','@code',
                            '@html','@href','@bold',
                            '@italic',
                            '@h1','@h2','@h3','@h4',
                            '@red','@green','@blue','@grey',
                            '@text-only'
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
        let extra = '';
        if (DEVELOPER_MODE) {
            extra = ' [dev]';
        }
        for (let i = 0; i < phrases.length; i++) {
            html += '<div data-tag-suggestion-id="'+suggestion_id+'" data-tag-suggestion="'+phrases[i]+'" class="tag-suggestion">'+phrases[i]+extra+'</div>';
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

    function getLiteralSuggestionsOfExistingTags(data, partial_tag, all_item_tags) {

        let start = Date.now();
        function _getValidTags() {
            let map = {};
            //TODO: cache in here
            let set_tags = new Set();
            for (let tag of all_item_tags) {
                let lower_tag = tag.toLowerCase();
                if (partial_tag != null && lower_tag.startsWith(partial_tag.toLowerCase()) == false) {
                    continue;
                }
                map[lower_tag] = tag;
            }
            return map;
        }
        
        let start1 = Date.now();
        let tags = _getValidTags();
        let end1 = Date.now();
        console.log((end1-start1) + 'ms getting valid tags');

        let temp = data
            .replace(/&nbsp;/g, ' ')
            .replace(/&gt;/g, '>')
            .replace(/&lt;/g, '<')
            .replace(/<br>/g,' ')
            .replace(/\\n/g, ' ');
        //TODO: more replacements here?
        
        let words = getWords(temp);
        
        let result = [];

        for (let word of words) {

            if (word == '') {
                continue;
            }

            let low_word = word.toLowerCase();

            if (tags[low_word] != undefined) {
                if (word.length == 0) {
                    alert("BUG");
                }
                result.push(tags[low_word]);
                console.log('push 0 ' + low_word);
            }

            let alterations = ["es", "s", "'s", "ly", "d"];

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

            if (verb_forms[word.toLowerCase()] != undefined) {
                for (let v of verb_forms[word.toLowerCase()]) {
                    if (tags[v] != undefined) {
                        result.push(tags[v]);
                    }
                }
            }
        }

        let end = Date.now();
        console.log('literal suggestions took ' + (end-start) + 'ms');
        return result;
    }

    function getAcronymSuggestions(data, partial_tag, all_item_tags) {
        let start = Date.now();
        let result = [];
        let words = getWords(data);
        for (let i = 0; i < words.length; i++) {
            for (let len = MIN_ACRONYM_LENGTH; len < MAX_ACRONYM_LENGTH; len++) {
                if ($model.isValidTag(words[i]) == false) {
                    break;
                }
                if (IGNORE_LIST.includes(words[i].toLowerCase())) {
                    break;
                }
                let abrv = words[i].charAt(0);
                for (let j = i+1; j < i+len; j++) {
                    if (j >= words.length) {
                        break;
                    }
                    if ($model.isValidTag(words[j]) == false) {
                        break;
                    }
                    if (IGNORE_LIST.includes(words[j].toLowerCase())) {
                        break;
                    }
                    abrv += words[j].charAt(0);
                }
                if (abrv.length < MIN_ACRONYM_LENGTH) {
                    continue;
                }
                let ABRV = abrv.toUpperCase();
                if (all_item_tags.includes(ABRV)) {
                    console.log('Suggesting acronym: ' + ABRV);
                    result.push(ABRV);
                }
            }
        }
        let end = Date.now();
        console.log('Find acronyms took ' + (end-start) + 'ms');
        return result;
    }

    function getLiteralPhraseSuggestionsOfExistingTags(data, partial_tag, all_item_tags) {

        //TODO: factor this out! Repeated in parse-tagging.js

        console.log('getLiteralPhraseSuggestionsOfExistingTags()');

        let start = Date.now();

        function _getValidTags() {

            let map = {};

            let imps = $ontology.getImplications();

            //TODO: cache in here
            //TODO: need to add all meta-tags that were not attached to an item!
            let set_tags = new Set();
            for (let tag of all_item_tags) {
                if (tag.includes('-') || tag.includes('_') || tag.includes('/') || tag.includes('.')) { //TODO: more combiners?
                    let lower_tag = tag.toLowerCase();
                    if (partial_tag != null && lower_tag.startsWith(partial_tag.toLowerCase()) == false) {
                        continue;
                    }
                    map[lower_tag] = tag;

                }
            }

            for (let imp in imps) {
                for (let tag of imps[imp]) {
                    if (tag == ' ') {
                        continue;
                    }
                    if (tag.startsWith('@') || tag.startsWith('#')) {
                        //Don't propagate meta or macro rules to children
                        continue;
                    }
                    if (tag.includes('-') || tag.includes('_') || tag.includes('/') || tag.includes('.')) { //TODO: more combiners?
                        let lower_tag = tag.toLowerCase();
                        if (partial_tag != null && lower_tag.startsWith(partial_tag.toLowerCase()) == false) {
                            continue;
                        }
                        map[lower_tag] = tag;
                    }
                }       
            }
            return map;
        }
        
        let start1 = Date.now();
        let tags = _getValidTags();
        let end1 = Date.now();
        console.log((end1-start1) + 'ms getting valid tags');

        let temp = data;
        temp = temp.replace('&nbsp;', ' ');
        temp = temp.replace('&gt;', '>');
        temp = temp.replace('&lt;', '<');
        //TODO: more replacements here?

        let words = getWords(temp);

        let result = [];

        for (let i = 0; i < words.length-1; i++) {
            let low_word1 = words[i].toLowerCase();
            let low_word2 = words[i+1].toLowerCase();

            let combiners = ['-','_','/','.'];

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

        if (TRIPLE_WORD_PHRASES_OF_EXISTING_TAGS) {
            for (let i = 0; i < words.length-2; i++) {
                let low_word1 = words[i].toLowerCase();
                let low_word2 = words[i+1].toLowerCase();
                let low_word3 = words[i+2].toLowerCase();

                let combiners = ['-','_','/','.'];

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

    function getSuggestions(items, item, subitem_index, parse_results) {
        console.log('getSuggestions()');
        let subitem = item.subitems[subitem_index];
        let timer = new Timer("SUGGEST TIMER");
        //TODO: this prevents sequential suggestions because it ignores prev siblings
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
                let possible_phrases = _suggestNew(items, item, subitem_index, prefix, last.text);

                //Test if this is a valid completion of current word
                for (let possible_phrase of possible_phrases) {
                    if (possible_phrase.toLowerCase().startsWith(words_text.toLowerCase()) && possible_phrase != words_text) {
                        if (phrases.includes(possible_phrase) == false) {
                            phrases.push(possible_phrase);
                        }
                    }
                }

                console.log('phrases.length = ' + phrases.length);

                //console.log('getSuggestions() loc 0.1 possible_phrases = ' + JSON.stringify(possible_phrases));

                if (SUGGEST_NEW_TAGS_FROM_TEXT && phrases.length == 0) {
                    let text_phrases = suggestNewTagsFromText(subitem.data, last.text, prefix);
                    for (let p of text_phrases) {
                        if (phrases.includes(p) == false) {
                            phrases.push(p);
                        }
                    }
                }

                timer.end();
                console.log('partial tag mode');
                timer.display();
                //console.log('getSuggestions() loc 1 phrases = ' + JSON.stringify(phrases));
                _cache[h] = phrases;
                return phrases;
            }
            else {
                let phrases = _suggestNew(items, item, subitem_index, prefix, null);
                timer.end();
                console.log('new tag mode');
                timer.display();
                _cache[h] = phrases;
                //console.log('getSuggestions() loc 2 phrases = ' + JSON.stringify(phrases));
                return phrases;
            }
        }
        else {
            console.log('No parse results, handle this!');
            let phrases = _suggestNew(items, item, subitem_index, prefix, null);
            timer.end();
            timer.display();
            //console.log('getSuggestions() loc 3 phrases = ' + JSON.stringify(phrases));
            _cache[h] = phrases;
            return phrases;
        }
    }

    function suggestNewTagsFromText(data, partial, prefix) {
        let words = getWords(data);
        let phrases = [];
        for (let i = 0; i < words.length; i++) {
            let word1 = words[i];
            
            if (IGNORE_LIST.includes(word1.toLowerCase())) {
                continue;
            }
            
            if ($model.isValidTag(word1)) {
                if (word1.toLowerCase().startsWith(partial.toLowerCase())) {
                    if (phrases.includes(prefix+word1) == false) {
                        phrases.push(prefix+word1);
                    }
                }
                if (SUGGEST_NEW_TAGS_FROM_TEXT_DOUBLE_WORD == false) {
                    continue;
                }
                let j = i+1;
                if (j < words.length && $model.isValidTag(words[j])) {
                    let word2 = words[j];
                    
                    if (IGNORE_LIST.includes(word2.toLowerCase())) {
                        continue;
                    }
                    
                    let phrase_natural = word1+' '+word2;
                    let phrase_as_tag = word1+'-'+word2;

                    if (data.toLowerCase().includes(phrase_natural.toLowerCase()) && 
                        phrase_as_tag.toLowerCase().startsWith(partial.toLowerCase())) {
                        if (phrases.includes(prefix+phrase_as_tag) == false) {
                            phrases.push(prefix+phrase_as_tag);
                        }
                    }
                    if (SUGGEST_NEW_TAGS_FROM_TEXT_TRIPLE_WORD == false) {
                        continue;
                    }
                    let k = i+2;
                    if (k < words.length && $model.isValidTag(words[k])) {
                        let word3 = words[k];
                        
                        if (IGNORE_LIST.includes(word3.toLowerCase())) {
                            continue;
                        }
                        
                        let phrase_natural = word1+' '+word2+' '+word3;
                        let phrase_as_tag = word1+'-'+word2+'-'+word3;

                        if (data.toLowerCase().includes(phrase_natural.toLowerCase()) && 
                            phrase_as_tag.toLowerCase().startsWith(partial.toLowerCase())) {
                            if (phrases.includes(prefix+phrase_as_tag) == false) {
                                phrases.push(prefix+phrase_as_tag);
                            }
                        }
                    }
                }
            }
        }
        return phrases;
    }

    function getAllItemTags(items) {
        let result = [];
        for (let item of items) {
            if (item.deleted != undefined) {
                continue;
            }
            let s_tags = $model.getItemTags(item);
            for (let tag of s_tags.split(' ')) {
                if (tag == '' || tag == ' ') {
                    continue;
                }
                if (result.includes(tag) == false) {
                    result.push(tag);
                }
            }
        }
        return result;
    }

    function _suggestNew(items, item, subitem_index, prefix, partial_tag) {

        let subitem = item.subitems[subitem_index];

        let timer = new Timer("\t\t_suggestNew()");
        let phrases = [];
        let literals = [];

        let all_item_tags = getAllItemTags(items);

        if (SUGGEST_ACRONYMS) {
            let acronyms = getAcronymSuggestions(subitem.data, partial_tag, all_item_tags);
            let prefix_words = prefix.split(' ');
            for (let tag of acronyms) {
                if (prefix_words.includes(tag)) {
                    continue;
                }
                let phrase = prefix+tag;
                if (phrases.includes(phrase) == false) {
                    phrases.push(phrase);
                }
            }
        }

        //prioritize phrase suggestions before single term ones
        let timer1 = new Timer("\t\tliteral suggestions");
        if (LITERAL_PHRASE_SUGGESTIONS_OF_EXISTING_TAGS) {
            literals = getLiteralPhraseSuggestionsOfExistingTags(subitem.data, partial_tag, all_item_tags);
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

        if (LITERAL_SUGGESTIONS_OF_EXISTING_TAGS) {
            literals = getLiteralSuggestionsOfExistingTags(subitem.data, partial_tag, all_item_tags);
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
        timer1.end();
        timer1.display();

        let timer2 = new Timer('\t\titem loop');

        let struct = {};

        console.log('\t\t\tlooping over ' + items.length + ' items');

        let start_suggest_similar = Date.now();

        for (let other_item of items) {
            if (other_item.deleted != undefined) {
                continue;
            }
            if (other_item.id == item.id) {
                continue;
            }
            for (let other_subitem of other_item.subitems) {
                let match_tot = 0;
                let new_tags = [];

                let other_all_tags = other_subitem._tags.concat(other_subitem._implied_tags);

                if (partial_tag == null) {
                    for (let tag of subitem._tags.concat(subitem._implied_tags)) {
                        if (other_all_tags.includes(tag)) {
                            match_tot++;
                        }
                    }
                }
                else {
                    let at_least_one_match_of_partial = false;
                    for (let other_tag of other_all_tags) {
                        if (other_tag.toLowerCase().startsWith(partial_tag.toLowerCase())) {
                            at_least_one_match_of_partial = true;
                            match_tot++;
                        }
                    }
                    if (at_least_one_match_of_partial) {
                        for (let tag of subitem._tags.concat(subitem._implied_tags)) {
                            //asdf match on partial as well?
                            if (other_all_tags.includes(tag)) {
                                match_tot++;
                            }
                        }
                    }
                }

                
                if (match_tot == 0) {
                    continue;
                }

                //Subtle point here - NOT actually suggesting implied tags of the match, even
                //though we used those to calculate the match similarity score above
                for (let other_tag of other_subitem._tags) {
                    if (partial_tag == null) {
                        if (subitem._tags.concat(subitem._implied_tags).includes(other_tag) == false) {
                            if (partial_tag == null) {
                                new_tags.push(other_tag);
                            }
                            else {
                                if (other_tag.startsWith(partial_tag)) {
                                    new_tags.push(other_tag);
                                }
                            }
                        }
                    }
                }
                
                if (new_tags.length == 0) {
                    continue;
                }
                if (struct[match_tot] == undefined) {
                    struct[match_tot] = {};
                }
                for (let tag of new_tags) {
                    if (struct[match_tot][tag] == undefined) {
                        struct[match_tot][tag] = 1;
                    }
                    else {
                        struct[match_tot][tag] += 1;
                    }
                }
            }
        }
        let end_suggest_similar = Date.now();
        console.log('Suggesting tags from similar subitems, took '+(end_suggest_similar-start_suggest_similar)+'ms');

        timer2.end();
        timer2.display();

        let timer3 = new Timer('\t\tlevels');

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
            sortable.sort(function(a, b){
                return a.val - b.val;
            });
            sortable.reverse();
            for (let tag of sortable) {
                if (ignore.has(tag.name)) {
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

        timer3.end();
        timer3.display();

        if (SUGGEST_NUMERIC_TAGS_WITH_VALUES) {
            let timer_numeric = new Timer('\t\tnumeric');
            let numberlikes = getNumberlikeElements(subitem.data);
            if (numberlikes.length > 0) {
                let numeric_tags = $model.getNumericTags(items);
                let edited_phrases = [];
                for (let phrase of phrases) {
                    let parts = phrase.trim().split(' ');
                    let last = parts[parts.length-1];
                    if (numeric_tags.includes(last)) {
                        for (let n of numberlikes) {
                            parts[parts.length-1] = last+'='+n;
                            let combined = parts.join(' ');
                            if (edited_phrases.includes(combined) == false) {
                                edited_phrases.push(combined);
                            }
                        }
                    }
                    else {
                        if (edited_phrases.includes(phrase) == false) {
                            edited_phrases.push(phrase);
                        }
                    }
                }
                phrases = edited_phrases;
            }
            
            timer_numeric.end();
            timer_numeric.display();
        }

        phrases = removeRedundancies(subitem, phrases, partial_tag, implications);

        let timer4 = new Timer('\t\tgeneric suggestions');
        if (GENERIC_SUGGESTIONS && phrases.length < MAX_SUGGESTIONS) {
            let list = $model.getEnrichedAndSortedTagList(items);
            if (partial_tag != null) {
                for (let tag of list) {
                    if (phrases.length >= MAX_SUGGESTIONS) {
                        break;
                    }
                    let lower_tag = tag.tag.toLowerCase();
                    if (lower_tag.startsWith(partial_tag.toLowerCase()) == false) {
                        //console.log('\tSkipping suggestion of "'+lower_tag+'"');
                        continue;
                    }
                    let phrase = prefix+tag.tag;
                    if (phrases.includes(phrase) == false) {
                        phrases.push(phrase);
                    }
                }
            }
            else {
                for (let tag of list) {
                    if (phrases.length >= MAX_SUGGESTIONS) {
                        break;
                    }
                    let lower_tag = tag.tag.toLowerCase();
                    let phrase = prefix+tag.tag;
                    if (phrases.includes(phrase) == false) {
                        phrases.push(phrase);
                    }
                }
            }
            
            //console.log(phrases);
        }
        else {
            console.log('Too many suggestions, skipping GENERIC');
        }
        timer4.end();
        timer4.display();

        let timer5 = new Timer('\t\tsuggest meta');
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

        timer5.end();
        timer5.display();

        phrases = removeRedundancies(subitem, phrases, partial_tag, implications);

        phrases = phrases.slice(0, MAX_SUGGESTIONS);

        timer.end();
        timer.display();

        return phrases;
    }

    function removeRedundancies(subitem, phrases, partial_tag, implications) {
        let timer6 = new Timer('\t\tremove redundancies');
        let edited = [];
        //Get rid of redundant implications
        if (partial_tag == null) { //Only do this when not in middle of typing a tag
            for (let phrase of phrases) {
                let redundant = false;
                let parts = phrase.split(' ');
                if (parts[parts.length-1].startsWith('@') && partial_tag == null) {
                    continue; //don't suggest special tags unless we've started typing it
                }
                for (let i = 0; i < parts.length-1; i++) {
                    let w1 = parts[i].split('=')[0].trim(); //splitting on "=" to handle numeric tags
                    let w2 = parts[parts.length-1].split('=')[0].trim();
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
        }

        //Get rid of redundant tags
        edited = [];
        for (let phrase of phrases) {
            let redundant = false;
            let l_parts = phrase.split(' ').map(x => x.toLowerCase());
            let already = [];
            for (let p of l_parts) {
                if (already.includes(p)) {
                    redundant = true;
                    break;
                }
                already.push(p);
            }
            if (redundant == false) {
                edited.push(phrase);
            }
        }
        phrases = edited;

        //get rid of inherited tags
        edited = [];
        for (let phrase of phrases) {
            let redundant = false;
            let l_parts = phrase.split(' ').map(x => x.toLowerCase());
            for (let p of l_parts) {
                for (let tag of subitem._inherited_tags) {
                    if (tag.toLowerCase() == p) {
                        redundant = true;
                        break;
                    }
                }
            }
            if (redundant == false) {
                edited.push(phrase);
            }
        }
        phrases = edited;
        timer6.end();
        timer6.display();
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
        let subitem_index = $model.getSubItemIndex(selectedSubitemPath);
        let subitem = item.subitems[subitem_index];
        let parse_results = $parseTagging(items, subitem.tags);
        if (parse_results == null) {
            console.log('ILLEGAL PARSE');
            //TODO: how to deal with this visually? Or just don't allow it to be typed?
            $view.illegalTag(item);
        }
        else {
            let phrases = getSuggestions(items, item, subitem_index, parse_results);
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
