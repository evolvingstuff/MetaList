"use strict";

const ALWAYS_ADD_SPACE_TO_TAG_SUGGESTION = true; //TODO: refactor

let $auto_complete_tags = (function () {

    const DEVELOPER_MODE = false;
    const MAX_SUGGESTIONS = 50;
    const LITERAL_SUGGESTIONS_OF_EXISTING_TAGS = true;
    const LITERAL_PHRASE_SUGGESTIONS_OF_EXISTING_TAGS = true;
    const TRIPLE_WORD_PHRASES_OF_EXISTING_TAGS = true;
    const SUGGEST_ENRICHED_IMPLICATIONS = true;
    const SUGGEST_NEW_TAGS_FROM_TEXT = true;
    const SUGGEST_NEW_TAGS_FROM_TEXT_DOUBLE_WORD = false;
    const SUGGEST_NEW_TAGS_FROM_TEXT_TRIPLE_WORD = false;
    const SUGGEST_ACRONYMS = false;
    const MIN_ACRONYM_LENGTH = 3;
    const MAX_ACRONYM_LENGTH = 5;
    const SUGGEST_NUMERIC_TAGS_WITH_VALUES = true;
    const SUGGEST_META = true;
    const SUGGEST_VERB_FORMS = false;
    const SORT_BY_CONTEXTUAL_POPULARITY = true;
    const EXCLUDE_LITERALS_WITH_ZERO_POPULARITY = false; //TODO
    const NARROW_FOCUS = true;
    const GENERIC_SUGGESTIONS = true;
    const MIN_PARTIAL_TAG_LENGTH_TO_MATCH = 1; //2
    const MIN_SUGGESTIONS = 0;
    
    const DEFAULT_SELECT_FIRST = true;

    //TODO: use js library for this?
    //https://github.com/spencermountain/compromise
    const IGNORE_LIST = ['a', 'an', 'the', 'there', 
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
        'but', 'however',
        'only', 'just',
        'of', 'on', 'be', 'as', 'is', '/'];


    let _cache = {};
    let modeHidden = true;
    let selectedTagSuggestionId = 0;

    function getSuggestions(item, subitemIndex, parseResults) {
        let subitem = item.subitems[subitemIndex];
        //TODO: this hashing logic prevents sequential suggestions because it ignores prev siblings
        let h = hashCode(JSON.stringify(subitem)+JSON.stringify(parseResults));
        //BUG: this is never called because items will have new _timestamp_update values
        if (_cache[h] != undefined) {
            return _cache[h];
        }

        let words = [];
        for (let parseResult of parseResults) {
            let tag = parseResult.text;
            if (parseResult.value != undefined) { //this handles attribute tags
                tag += '='+parseResult.value;
            }
            words.push(tag);
        }
        let words_text = words.join(' ');
        let prefix = '';
        if (parseResults.length > 0) {
            for (let i = 0; i < parseResults.length; i++) {
                if (parseResults[i].partial == true) {
                    //console.log('partial, skip');
                }
                else {
                    prefix += parseResults[i].text
                    //handle attribute
                    if (parseResults[i].value != undefined) {
                        prefix += '='+parseResults[i].value;
                    }
                    if (ALWAYS_ADD_SPACE_TO_TAG_SUGGESTION) {
                        prefix += ' ';
                    }
                }
            }
            let last = parseResults[parseResults.length-1];
            if (last.partial == true) {
                let phrases = [];
                let possiblePhrases = _suggestNew(item, subitemIndex, prefix, last.text);

                //Test if this is a valid completion of current word
                for (let possiblePhrase of possiblePhrases) {
                    if (possiblePhrase.toLowerCase().startsWith(words_text.toLowerCase()) && possiblePhrase != words_text) {
                        if (phrases.includes(possiblePhrase) == false) {
                            phrases.push(possiblePhrase);
                        }
                    }
                }

                if (SUGGEST_NEW_TAGS_FROM_TEXT && phrases.length == 0) {
                    let text_phrases = suggestNewTagsFromText(subitem.data, last.text, prefix);
                    for (let p of text_phrases) {
                        if (phrases.includes(p) == false) {
                            phrases.push(p);
                        }
                    }
                }
                _cache[h] = phrases;
                return phrases;
            }
            else {

                let phrases = _suggestNew(item, subitemIndex, prefix, null);

                _cache[h] = phrases;
                return phrases;
            }
        }
        else {
            let phrases = _suggestNew(item, subitemIndex, prefix, null);
            _cache[h] = phrases;
            return phrases;
        }
    }

    function resetCache() {
        _cache = {};
    }

    function getModeHidden() {
        return modeHidden;
    }

    function _updateDataList(item, phrases) {
        let $el = $view.getItemTagSuggestionsElementById(item.id);
        applyPhrases($el, phrases);
    }

    function applyPhrases($div, phrases) {
        let suggestionId = 1;
        let html = '';
        let extra = '';
        if (DEVELOPER_MODE) {
            extra = ' [dev]';
        }
        for (let i = 0; i < phrases.length; i++) {
            html += '<div data-tag-suggestion-id="'+suggestionId+'" data-tag-suggestion="'+phrases[i]+'" class="tag-suggestion">'+phrases[i]+extra+'</div>';
            suggestionId++;
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
        modeHidden = true;
    }

    function showOptions() {
        $('.tag-suggestions').css('display', 'block');
        $('.tag-suggestions').css('z-index', '100');
        modeHidden = false;
        if (DEFAULT_SELECT_FIRST) {
            updateSelectedTagSuggestion(1);
        }
    }

    function toggleOptions() {
        if (modeHidden) {
            showOptions();
        }
        else {
            hideOptions();
        }
    }

    function getLiteralSuggestionsOfExistingTags(data, partialTag, allItemTags) {
        function _getValidTags() {
            let map = {};
            //TODO: cache in here
            for (let tag of allItemTags) {
                let lowerTag = tag.toLowerCase();
                if (partialTag != null && lowerTag.startsWith(partialTag.toLowerCase()) == false) {
                    continue;
                }
                map[lowerTag] = tag;
            }
            return map;
        }
        
        let tags = _getValidTags();

        let temp = $format.toTextWithoutPreservedNewlines(data).toLowerCase();
        let words = v.words(temp);
        
        let result = [];

        for (let word of words) {

            if (word == '') {
                continue;
            }

            if (tags[word] != undefined) {
                result.push(tags[word]);
            }

            if (SUGGEST_VERB_FORMS) {
                if (verb_forms[word.toLowerCase()] != undefined) {
                    for (let v of verb_forms[word.toLowerCase()]) {
                        if (tags[v] != undefined) {
                            result.push(tags[v]);
                        }
                    }
                }
            }
        }
        return result;
    }

    function getAcronymSuggestions(data, partialTag, allItemTags) {
        let result = [];
        let temp = $format.toTextWithoutPreservedNewlines(data);
        let words = v.words(temp);
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
                if (allItemTags.includes(ABRV)) {
                    result.push(ABRV);
                }
            }
        }
        return result;
    }

    function getLiteralPhraseSuggestionsOfExistingTags(data, partialTag, allItemTags) {

        //TODO: factor this out! Repeated in parse-tagging.js

        function _getValidTags() {

            let map = {};

            let imps = $ontology.getImplications();

            //TODO: cache in here
            //TODO: need to add all meta-tags that were not attached to an item!

            for (let tag of allItemTags) {
                if (tag.includes('-') || tag.includes('_') || tag.includes('/') || tag.includes('.')) { //TODO: more combiners?
                    let lowerTag = tag.toLowerCase();
                    if (partialTag != null && lowerTag.startsWith(partialTag.toLowerCase()) == false) {
                        continue;
                    }
                    map[lowerTag] = tag;

                }
            }

            for (let imp in imps) {
                for (let tag of imps[imp]) {
                    if (tag == ' ') {
                        continue;
                    }
                    if (tag.startsWith(META_PREFIX)) {
                        //Don't propagate meta or macro rules to children
                        //TODO: should depend on tag
                        continue;
                    }
                    if (tag.includes('-') || tag.includes('_') || tag.includes('/') || tag.includes('.')) { //TODO: more combiners?
                        let lowerTag = tag.toLowerCase();
                        if (partialTag != null && lowerTag.startsWith(partialTag.toLowerCase()) == false) {
                            continue;
                        }
                        map[lowerTag] = tag;
                    }
                }       
            }
            return map;
        }
        
        let tags = _getValidTags();

        let temp = $format.toTextWithoutPreservedNewlines(data);
        let words = v.words(temp);

        let result = [];

        for (let i = 0; i < words.length-1; i++) {
            let lowWord1 = words[i].toLowerCase();
            let lowWord2 = words[i+1].toLowerCase();

            let combiners = ['-','_','/','.'];

            for (let combiner of combiners) {
                let lowPhrase = lowWord1 + combiner + lowWord2;
                if (tags[lowPhrase] != undefined) {
                    result.push(tags[lowPhrase]);
                }

                let lowPhraseReverse = lowWord2 + combiner + lowWord1;
                if (tags[lowPhraseReverse] != undefined) {
                    result.push(tags[lowPhraseReverse]);
                }
            }
        }

        if (TRIPLE_WORD_PHRASES_OF_EXISTING_TAGS) {
            for (let i = 0; i < words.length-2; i++) {
                let lowWord1 = words[i].toLowerCase();
                let lowWord2 = words[i+1].toLowerCase();
                let lowWord3 = words[i+2].toLowerCase();

                let combiners = ['-','_','/','.'];

                for (let combiner of combiners) {
                    let lowPhrase = lowWord1 + combiner + lowWord2 + combiner + lowWord3;
                    if (tags[lowPhrase] != undefined) {
                        result.push(tags[lowPhrase]);
                    }
                }
            }
        }

        return result;
    }

    function sortTagListByContextualPopularity(tagList, items) {
        let t1 = Date.now();
        let counts = {};
        for (let tag of tagList) {
            counts[tag] = 0;
        }

        for (let item of items) {
            if (item.subitems[0]._include == -1) {
                continue;
            }
            for (let subitem of item.subitems) {
                if (subitem._include == -1) {
                    continue;
                }
                for (let tag of subitem._tags) {
                    if (tag.startsWith('@')) {
                        continue;
                    }
                    if (counts[tag] !== undefined) {
                        counts[tag] += 1;
                    }
                }
            }
        }
        
        let sorted = sortDict(counts);
        let result = [];
        for (let item of sorted) {
            if (EXCLUDE_LITERALS_WITH_ZERO_POPULARITY && item[1] == 0) {
                continue;
            }
            result.push(item[0]);
        }
        let t2 = Date.now();
        // console.log('DEBUG: Sorted literals by contextual popularity:');
        // console.log(result);
        // console.log((t2-t1) + ' ms');
        return result;
    }

    

    function suggestNewTagsFromText(data, partial, prefix) {
        let temp = $format.toTextWithoutPreservedNewlines(data);
        let words = v.words(temp);
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
                    
                    let phraseNatural = word1+' '+word2;
                    let phraseAsTag = word1+'-'+word2;

                    if (data.toLowerCase().includes(phraseNatural.toLowerCase()) && 
                        phraseAsTag.toLowerCase().startsWith(partial.toLowerCase())) {
                        if (phrases.includes(prefix+phraseAsTag) == false) {
                            phrases.push(prefix+phraseAsTag);
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
                        
                        let phraseNatural = word1+' '+word2+' '+word3;
                        let phraseAsTag = word1+'-'+word2+'-'+word3;

                        if (data.toLowerCase().includes(phraseNatural.toLowerCase()) && 
                            phraseAsTag.toLowerCase().startsWith(partial.toLowerCase())) {
                            if (phrases.includes(prefix+phraseAsTag) == false) {
                                phrases.push(prefix+phraseAsTag);
                            }
                        }
                    }
                }
            }
        }
        return phrases;
    }

    function _suggestNew(item, subitemIndex, prefix, partialTag) {

        // console.log('none I REALLY hope');
        // console.log(phrases);

        let subitem = item.subitems[subitemIndex];
        let phrases = [];

        let allItemTags = $model.getAllTags();

        let prefixWords = prefix.split(' ');

        let acronyms = [];

        if (SUGGEST_ACRONYMS) {
            acronyms = getAcronymSuggestions(subitem.data, partialTag, allItemTags);
        }

        const items = $model.getUnsortedItems();

        //prioritize phrase suggestions before single term ones

        let literal_phrases = [];
        let literal_singles = [];

        if (LITERAL_PHRASE_SUGGESTIONS_OF_EXISTING_TAGS) {
            literal_phrases = getLiteralPhraseSuggestionsOfExistingTags(subitem.data, partialTag, allItemTags);
        }

        if (LITERAL_SUGGESTIONS_OF_EXISTING_TAGS) {
            literal_singles = getLiteralSuggestionsOfExistingTags(subitem.data, partialTag, allItemTags);
        }

        let all_suggestions_so_far = acronyms.concat(literal_phrases).concat(literal_singles);

        if (SORT_BY_CONTEXTUAL_POPULARITY) {
            all_suggestions_so_far = sortTagListByContextualPopularity(all_suggestions_so_far, items);
        }

        for (let tag of all_suggestions_so_far) {
            if (prefixWords.includes(tag)) {
                continue;
            }
            let phrase = prefix+tag;
            if (phrases.includes(phrase) == false) {
                phrases.push(phrase);
            }
        }

        let struct = {};

        let allSubitemTags = subitem._direct_tags.concat(subitem._implied_tags).concat(subitem._inherited_tags); 

        let skipped = 0;

        for (let otherItem of items) {

            if (otherItem.id == item.id) {
                continue;
            }

            if (NARROW_FOCUS && otherItem.subitems[0]._include == -1) {
                skipped += 1;
                continue;
            }

            let someMatch = false;
            for (let tag of allSubitemTags) {
                if (otherItem._tags.has(tag)) {
                    someMatch = true;
                    break;
                }
            }

            if (someMatch == false) {
                continue;
            }

            for (let otherSubitem of otherItem.subitems) {

                if (NARROW_FOCUS && otherSubitem._include == -1) {
                    skipped += 1;
                    continue;
                }

                let matchTot = 0;
                let newTags = [];

                let allOtherTags = otherSubitem._direct_tags.concat(otherSubitem._implied_tags).concat(otherSubitem._inherited_tags);

                if (partialTag == null) {
                    for (let tag of allSubitemTags) {
                        if (allOtherTags.includes(tag)) {
                            matchTot++;
                        }
                    }
                }
                else {
                    let atLeastOneMatchOfPartial = false;
                    if (partialTag.length >= MIN_PARTIAL_TAG_LENGTH_TO_MATCH) {
                        for (let otherTag of allOtherTags) {
                            if (otherTag.toLowerCase().startsWith(partialTag.toLowerCase())) {
                                atLeastOneMatchOfPartial = true;
                                matchTot++;
                            }
                        }
                    }
                    if (atLeastOneMatchOfPartial) {
                        for (let tag of allSubitemTags) {
                            if (allOtherTags.includes(tag)) {
                                matchTot++;
                            }
                        }
                    }
                }
                
                if (matchTot == 0) {
                    continue;
                }

                //Subtle point here - NOT actually suggesting implied tags of the match, even
                //though we used those to calculate the match similarity score above
                for (let otherTag of otherSubitem._tags) {

                    if (partialTag == null) {
                        if (subitem._tags.concat(subitem._implied_tags).includes(otherTag) == false) {
                            newTags.push(otherTag);
                        }
                    }
                    else {

                        // TODO do we need logic here?

                        if (otherTag.startsWith(partialTag)) {
                            newTags.push(otherTag);
                        }
                    }
                }
                
                if (newTags.length == 0) {
                    continue;
                }
                if (struct[matchTot] == undefined) {
                    struct[matchTot] = {};
                }
                for (let tag of newTags) {
                    if (struct[matchTot][tag] == undefined) {
                        struct[matchTot][tag] = 1;
                    }
                    else {
                        struct[matchTot][tag] += 1;
                    }
                }
            }
        }

        let levels = [];
        for (let level in struct) {
            let numLevel = parseInt(level);
            levels.push(numLevel);
        }
        sortArrayOfNumbersInPlace(levels);
        levels.reverse();
        
        let MAX_LEVELS = 10;

        let ignore = new Set();

        for (let tag of subitem._tags) {
            ignore.add(tag);
        }

        for (let tag of subitem._implied_tags) {
            ignore.add(tag);
        }

        for (let tag of subitem._inherited_tags) {
            ignore.add(tag);
        }

        for (let i = 0; i < Math.min(levels.length, MAX_LEVELS); i++) {
            if (phrases.length >= MAX_SUGGESTIONS) {
                break;
            }
            let level = levels[i].toString();
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

        if (SUGGEST_NUMERIC_TAGS_WITH_VALUES) {
            let numberlikes = getNumberlikeElements(subitem.data);
            if (numberlikes.length > 0) {
                let attributeTags = $model.getAttributeTags(); //TODO: narrowed focus?
                let numericTags = [];
                for (let fullTag of attributeTags) {
                    let parts = fullTag.split('=');
                    let tag = parts[0];
                    let val = parts[1];
                    if (v.isNumeric(val)) {
                        numericTags.push(tag);
                    }
                }
                let editedPhrases = [];
                for (let phrase of phrases) {
                    let parts = phrase.trim().split(' ');
                    let last = parts[parts.length-1];
                    if (numericTags.includes(last)) {
                        for (let n of numberlikes) {
                            parts[parts.length-1] = last+'='+n;
                            let combined = parts.join(' ');
                            if (editedPhrases.includes(combined) == false) {
                                editedPhrases.push(combined);
                            }
                        }
                    }
                    else {
                        if (editedPhrases.includes(phrase) == false) {
                            editedPhrases.push(phrase);
                        }
                    }
                }
                phrases = editedPhrases;
            }
        }

        let implications = $ontology.getImplications();

        if ((GENERIC_SUGGESTIONS && phrases.length < MAX_SUGGESTIONS) || 
            (phrases.length < MIN_SUGGESTIONS)) {
            let list = $model.getEnrichedAndSortedTagList(false);
            if (partialTag != null) {
                for (let tag of list) {
                    if (phrases.length >= MAX_SUGGESTIONS) {
                        break;
                    }
                    let lowerTag = tag.tag.toLowerCase();
                    if (lowerTag.startsWith(partialTag.toLowerCase()) == false) {
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
                    let phrase = prefix+tag.tag;
                    if (phrases.includes(phrase) == false) {
                        phrases.push(phrase);
                    }
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

        phrases = removeRedundancies(subitem, phrases, partialTag, implications);

        phrases = phrases.slice(0, MAX_SUGGESTIONS);

        return phrases;
    }

    function removeRedundancies(subitem, phrases, partialTag, implications) {
        let edited = [];

        //Get rid of redundant implications
        if (partialTag == null) { //Only do this when not in middle of typing a tag
            for (let phrase of phrases) {
                let redundant = false;
                let parts = phrase.split(' ');
                if (parts[parts.length-1].startsWith(META_PREFIX) && partialTag == null) {
                    continue; //don't suggest special tags unless we've started typing it
                }
                for (let i = 0; i < parts.length-1; i++) {
                    let w1 = parts[i].split('=')[0].trim(); //splitting on "=" to handle attribute tags
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
            let lParts = phrase.split(' ').map(x => x.toLowerCase());
            let already = [];
            for (let p of lParts) {
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
        if (partialTag == null) { //Only do this when not in middle of typing a tag
            edited = [];
            for (let phrase of phrases) {
                let redundant = false;
                let lParts = phrase.split(' ').map(x => x.toLowerCase());
                for (let p of lParts) {
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
        }

        return phrases;
    }

    function selectSuggestion(item, selectedSubitemPath) {
        if (selectedTagSuggestionId == 0) {
            return;
        }
        let choice = $('[data-tag-suggestion-id='+selectedTagSuggestionId+']').attr('data-tag-suggestion');

        if (choice == undefined) {
            console.warn('Choice was undefined');
            return;
        }

        if (ALWAYS_ADD_SPACE_TO_TAG_SUGGESTION) {
            choice = choice + ' ';
        }

        $model.updateSubTag(item, selectedSubitemPath, choice);

        // console.log('item: ');
        // console.log(item);
        // debugger;

        let $input0 = $('[data-item-id='+item.id+']').find('.action-edit-tag');
        console.log('cp0: "' + $input0.val()+'"');//asdfasdf

        console.log('choice = "'+choice+'"');

        $view.updateTag(item, choice);

        let $input1 = $('[data-item-id='+item.id+']').find('.action-edit-tag');
        console.log('cp1: "' + $input1.val()+'"');

        onChange(item, selectedSubitemPath, choice);
    }

    function updateSelectedTagSuggestion(id=0) {
        if (selectedTagSuggestionId != 0) {
            $('[data-tag-suggestion-id='+selectedTagSuggestionId+']').removeClass('selected-tag-suggestion');
        }
        if (id >= 0) {
            selectedTagSuggestionId = id;
        }
        if (selectedTagSuggestionId != 0) {
            $('[data-tag-suggestion-id='+selectedTagSuggestionId+']').addClass('selected-tag-suggestion');
        }
    }

    function onChange(item, selectedSubitemPath, tagsString) {
        showOptions();
        let subitemIndex = $model.getSubItemIndex(selectedSubitemPath);
        let subitem = item.subitems[subitemIndex];
        let parseResults = $parseTagging(tagsString);
        if (parseResults == null) {
            console.warn('ILLEGAL PARSE');
            $view.illegalTag(item);
        }
        else {
            let phrases = getSuggestions(item, subitemIndex, parseResults);
            _updateDataList(item, phrases);
            updateSelectedTagSuggestion();
            $view.legalTag(item);
        }
        if (DEFAULT_SELECT_FIRST) {
            updateSelectedTagSuggestion(1);
        }
    }

    function arrowUp() {
        updateSelectedTagSuggestion(selectedTagSuggestionId-1);
    }

    function arrowDown() {
        updateSelectedTagSuggestion(selectedTagSuggestionId+1);
    }

    return {
        onChange: onChange,
        hideOptions: hideOptions,
        showOptions: showOptions,
        toggleOptions: toggleOptions,
        updateSelectedTagSuggestion: updateSelectedTagSuggestion,
        selectSuggestion: selectSuggestion,
        arrowUp: arrowUp,
        arrowDown: arrowDown,
        getModeHidden: getModeHidden,
        resetCache: resetCache
    };
})();
