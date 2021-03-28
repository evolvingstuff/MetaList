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
    const SUGGEST_NUMERIC_TAGS_WITH_VALUES = true;
    const SUGGEST_META = true;
    const SUGGEST_VERB_FORMS = false;
    const NARROW_FOCUS = true;
    const GENERIC_SUGGESTIONS = true;
    const MIN_PARTIAL_TAG_LENGTH_TO_MATCH = 1; //3
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
    let _cache_reasons = {};
    let modeHidden = true;
    let selectedTagSuggestionId = 0;

    function getSuggestions(item, subitemIndex, parseResults) {
        let subitem = item.subitems[subitemIndex];
        //TODO: this hashing logic prevents sequential suggestions because it ignores prev siblings
        let h = hashCode(JSON.stringify(subitem)+JSON.stringify(parseResults));
        
        if (_cache[h] !== undefined) {
            return [_cache[h], _cache_reasons[h]]
        }

        let words = [];
        for (let parseResult of parseResults) {
            let tag = parseResult.text;
            if (parseResult.value !== undefined) { //this handles attribute tags
                tag += '='+parseResult.value;
            }
            words.push(tag);
        }
        let words_text = words.join(' ');
        let prefix = '';
        if (parseResults.length > 0) {
            for (let i = 0; i < parseResults.length; i++) {
                if (parseResults[i].partial === true) {
                }
                else {
                    prefix += parseResults[i].text
                    //handle attribute
                    if (parseResults[i].value !== undefined) {
                        prefix += '='+parseResults[i].value;
                    }
                    if (ALWAYS_ADD_SPACE_TO_TAG_SUGGESTION) {
                        prefix += ' ';
                    }
                }
            }
            let last = parseResults[parseResults.length-1];
            if (last.partial === true) {
                let phrases = [];
                let reasons = [];
                let [possiblePhrases, possibleReasons] = suggestNew(item, subitemIndex, prefix, last.text);

                //Test if this is a valid completion of current word
                for (let i = 0; i < possiblePhrases.length; i++) {
                    let possiblePhrase = possiblePhrases[i];
                    let possibleReason = possibleReasons[i]
                    if (possiblePhrase.toLowerCase().startsWith(words_text.toLowerCase()) && possiblePhrase !== words_text) {
                        if (phrases.includes(possiblePhrase) === false) {
                            phrases.push(possiblePhrase);
                            reasons.push(possibleReason);
                        }
                    }
                }

                if (SUGGEST_NEW_TAGS_FROM_TEXT && phrases.length === 0) {
                    let [textPhrases, textPhraseReasons] = suggestNewTagsFromText(subitem.data, last.text, prefix);
                    for (let i = 0; i < textPhrases.length; i++) {
                        let textPhrase = textPhrases[i];
                        let textPhraseReason = textPhraseReasons[i];
                        if (phrases.includes(textPhrase) === false) {
                            phrases.push(textPhrase);
                            reasons.push(textPhraseReason);
                        }
                    }
                }
                _cache[h] = phrases;
                _cache_reasons[h] = reasons;
                return [phrases, reasons];
            }
            else {

                let [phrases, reasons] = suggestNew(item, subitemIndex, prefix, null);
                _cache[h] = phrases;
                _cache_reasons[h] = reasons;
                return [phrases, reasons];
            }
        }
        else {

            let [phrases, reasons] = suggestNew(item, subitemIndex, prefix, null);
            _cache[h] = phrases;
            _cache_reasons[h] = reasons;
            return [phrases, reasons];
        }
        //TODO: remove logic redundancy above
    }

    function resetCache() {
        _cache = {};
        _cache_reasons = {};
    }

    function getModeHidden() {
        return modeHidden;
    }

    function applyPhrases($div, phrases, reasons) {
        
        if (phrases.length != reasons.length) {
            console.warn('ERROR: phrases.length != reasons.length');
            debugger;
        }

        let suggestionId = 1;
        let html = '';
        for (let i = 0; i < phrases.length; i++) {
            const phrase = phrases[i];
            const reason = reasons[i];
            let extra = '';
            if (reason != null && DEVELOPER_MODE) {
                extra = ' {' + reason + '}';
            }
            html += '<div data-tag-suggestion-id="'+suggestionId+'" data-tag-suggestion="'+phrase+'" class="tag-suggestion">'+phrase+extra+'</div>';
            suggestionId++;
        }
        $div.innerHTML = html;
        if (phrases.length === 0) {
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
                if (partialTag !== null && lowerTag.startsWith(partialTag.toLowerCase()) === false) {
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

            if (word === '') {
                continue;
            }

            if (tags[word] !== undefined) {
                result.push(tags[word]);
            }

            if (SUGGEST_VERB_FORMS) {
                if (verb_forms[word.toLowerCase()] !== undefined) {
                    for (let v of verb_forms[word.toLowerCase()]) {
                        if (tags[v] !== undefined) {
                            result.push(tags[v]);
                        }
                    }
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
                    if (partialTag !== null && lowerTag.startsWith(partialTag.toLowerCase()) === false) {
                        continue;
                    }
                    map[lowerTag] = tag;

                }
            }

            for (let imp in imps) {
                for (let tag of imps[imp]) {
                    if (tag === ' ') {
                        continue;
                    }
                    if (tag.startsWith(META_PREFIX)) {
                        //Don't propagate meta or macro rules to children
                        //TODO: should depend on tag
                        continue;
                    }
                    if (tag.includes('-') || tag.includes('_') || tag.includes('/') || tag.includes('.')) { //TODO: more combiners?
                        let lowerTag = tag.toLowerCase();
                        if (partialTag !== null && lowerTag.startsWith(partialTag.toLowerCase()) === false) {
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
                if (tags[lowPhrase] !== undefined) {
                    result.push(tags[lowPhrase]);
                }

                let lowPhraseReverse = lowWord2 + combiner + lowWord1;
                if (tags[lowPhraseReverse] !== undefined) {
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
                    if (tags[lowPhrase] !== undefined) {
                        result.push(tags[lowPhrase]);
                    }
                }
            }
        }

        return result;
    }

    function suggestNewTagsFromText(data, partial, prefix) {
        let temp = $format.toTextWithoutPreservedNewlines(data);
        let words = v.words(temp);
        let phrases = [];
        let reasons = [];
        for (let i = 0; i < words.length; i++) {
            let word1 = words[i];
            
            if (IGNORE_LIST.includes(word1.toLowerCase())) {
                continue;
            }
            
            if ($model.isValidTag(word1)) {
                if (word1.toLowerCase().startsWith(partial.toLowerCase())) {
                    if (phrases.includes(prefix+word1) === false) {
                        phrases.push(prefix+word1);
                        reasons.push('found tag in text');
                    }
                }
                if (SUGGEST_NEW_TAGS_FROM_TEXT_DOUBLE_WORD === false) {
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
                        if (phrases.includes(prefix+phraseAsTag) === false) {
                            phrases.push(prefix+phraseAsTag);
                            reasons.push('found 2 word tag in text');
                        }
                    }
                    if (SUGGEST_NEW_TAGS_FROM_TEXT_TRIPLE_WORD === false) {
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
                            if (phrases.includes(prefix+phraseAsTag) === false) {
                                phrases.push(prefix+phraseAsTag);
                                reasons.push('found 3 word tag in text');
                            }
                        }
                    }
                }
            }
        }
        return [phrases, reasons];
    }

    function suggestNew(item, subitemIndex, prefix, partialTag) {

        let subitem = item.subitems[subitemIndex];
        let phrases = [];
        let reasons = [];

        let allItemTags = $model.getAllTags();

        let prefixWords = prefix.split(' ');

        let acronyms = [];

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


        for (let tag of all_suggestions_so_far) {
            if (prefixWords.includes(tag)) {
                continue;
            }
            let phrase = prefix+tag;
            if (phrases.includes(phrase) === false) {
                phrases.push(phrase);
                reasons.push('literal suggestion');
            }
        }

        if (phrases.length != reasons.length) {
            console.warn('ERROR: phrases.length != reasons.length');
            debugger;
        }

        let struct = {};

        let allSubitemTags = subitem._direct_tags.concat(subitem._implied_tags).concat(subitem._inherited_tags); 

        let skipped = 0;

        for (let otherItem of items) {

            if (otherItem.id === item.id) {
                continue;
            }

            if (NARROW_FOCUS && otherItem.subitems[0]._include === -1) {
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

            if (someMatch === false) {
                continue;
            }

            for (let otherSubitem of otherItem.subitems) {

                if (NARROW_FOCUS && otherSubitem._include === -1) {
                    skipped += 1;
                    continue;
                }

                let matchTot = 0;
                let newTags = [];

                let allOtherTags = otherSubitem._direct_tags.concat(otherSubitem._implied_tags).concat(otherSubitem._inherited_tags);

                if (partialTag === null) {
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
                
                if (matchTot === 0) {
                    continue;
                }

                //Subtle point here - NOT actually suggesting implied tags of the match, even
                //though we used those to calculate the match similarity score above
                for (let otherTag of otherSubitem._tags) {

                    if (partialTag === null) {
                        if (subitem._tags.concat(subitem._implied_tags).includes(otherTag) === false) {
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
                
                if (newTags.length === 0) {
                    continue;
                }
                if (struct[matchTot] === undefined) {
                    struct[matchTot] = {};
                }
                for (let tag of newTags) {
                    if (struct[matchTot][tag] === undefined) {
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

                if (phrases.includes(tag.name) === false) {
                    let phrase = prefix+tag.name;
                    if (phrases.includes(phrase) === false) {
                        phrases.push(prefix+tag.name);
                        reasons.push('matched tag level=' + level + ' / value=' + tag.val);
                    }
                }
            }
        }

        if (phrases.length != reasons.length) {
            console.warn('ERROR: phrases.length != reasons.length');
            debugger;
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
                let editedReasons = [];
                for (let phrase of phrases) {
                    let parts = phrase.trim().split(' ');
                    let last = parts[parts.length-1];
                    if (numericTags.includes(last)) {
                        for (let n of numberlikes) {
                            parts[parts.length-1] = last+'='+n;
                            let combined = parts.join(' ');
                            if (editedPhrases.includes(combined) === false) {
                                editedPhrases.push(combined);
                                editedReasons.push('tag with value (a)');
                            }
                        }
                    }
                    else {
                        if (editedPhrases.includes(phrase) === false) {
                            editedPhrases.push(phrase);
                            editedReasons.push('tag with value (b)');
                        }
                    }
                }
                phrases = editedPhrases;
                reasons = editedReasons;
            }
        }

        if (phrases.length != reasons.length) {
            console.warn('ERROR: phrases.length != reasons.length');
            debugger;
        }

        let implications = $ontology.getImplications();

        if ((GENERIC_SUGGESTIONS && phrases.length < MAX_SUGGESTIONS) || 
            (phrases.length < MIN_SUGGESTIONS)) {
            let list = $model.getEnrichedAndSortedTagList(false);
            if (partialTag !== null) {
                for (let tag of list) {
                    if (phrases.length >= MAX_SUGGESTIONS) {
                        break;
                    }
                    let lowerTag = tag.tag.toLowerCase();
                    if (lowerTag.startsWith(partialTag.toLowerCase()) === false) {
                        continue;
                    }
                    let phrase = prefix+tag.tag;
                    if (phrases.includes(phrase) === false) {
                        phrases.push(phrase);
                        reasons.push('generic suggestion');
                    }
                }
            }
            else {
                for (let tag of list) {
                    if (phrases.length >= MAX_SUGGESTIONS) {
                        break;
                    }
                    let phrase = prefix+tag.tag;
                    if (phrases.includes(phrase) === false) {
                        phrases.push(phrase);
                        reasons.push('generic suggestion');
                    }
                }
            }
        }

        if (phrases.length != reasons.length) {
            console.warn('ERROR: phrases.length != reasons.length');
            debugger;
        }

        if (SUGGEST_META) {
            let parts = subitem.tags.split(' ');
            if (parts.length > 0) {
                let end = parts[parts.length-1];
                for (let meta of SUGGESTED_META) {
                    if (meta.startsWith(end)) {
                        let phrase = prefix+meta;
                        if (phrases.includes(phrase) === false) {
                            phrases.push(phrase);
                            reasons.push('suggeting meta');
                        }
                    }
                }
            }
        }

        if (phrases.length != reasons.length) {
            console.warn('ERROR: phrases.length != reasons.length');
            debugger;
        }

        let [uniquePhrases, uniqueReasons] = removeRedundancies(subitem, phrases, reasons, partialTag, implications);

        if (uniquePhrases.length != uniqueReasons.length) {
            console.warn('ERROR: uniquePhrases.length != uniqueReasons.length');
            debugger;
        }

        uniquePhrases = uniquePhrases.slice(0, MAX_SUGGESTIONS);
        uniqueReasons = uniqueReasons.slice(0, MAX_SUGGESTIONS);

        return [uniquePhrases, uniqueReasons];
    }

    function removeRedundancies(subitem, phrases, reasons, partialTag, implications) {
        let edited = [];
        let editedReasons = [];

        //Get rid of redundant implications
        if (partialTag === null) { //Only do this when not in middle of typing a tag
            for (let i = 0; i < phrases.length; i++) {
                let phrase = phrases[i];
                let reason = reasons[i];
                let redundant = false;
                let parts = phrase.split(' ');
                if (parts[parts.length-1].startsWith(META_PREFIX) && partialTag === null) {
                    continue; //don't suggest special tags unless we've started typing it
                }
                for (let i = 0; i < parts.length-1; i++) {
                    let w1 = parts[i].split('=')[0].trim(); //splitting on "=" to handle attribute tags
                    let w2 = parts[parts.length-1].split('=')[0].trim();
                    if (implications[w1] !== undefined && implications[w1].includes(w2)) {
                        redundant = true;
                        break;
                    }
                    if (w1 === w2) {
                        redundant = true;
                        break;
                    }
                }
                if (redundant === false) {
                    edited.push(phrase);
                    editedReasons.push(reason);
                }
            }
            phrases = edited;
            reasons = editedReasons;
        }

        if (phrases.length != reasons.length) {
            console.warn('ERROR: phrases.length != reasons.length');
            debugger;
        }

        //Get rid of redundant tags
        edited = [];
        editedReasons = [];
        for (let i = 0; i < phrases.length; i++) {
            let phrase = phrases[i];
            let reason = reasons[i];
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
            if (redundant === false) {
                edited.push(phrase);
                editedReasons.push(reason);
            }
        }
        phrases = edited;
        reasons = editedReasons;

        if (phrases.length != reasons.length) {
            console.warn('ERROR: phrases.length != reasons.length');
            debugger;
        }

        //get rid of inherited tags
        if (partialTag === null) { //Only do this when not in middle of typing a tag
            edited = [];
            editedReasons = [];
            for (let i = 0; i < phrases.length; i++) {
                let phrase = phrases[i];
                let reason = reasons[i]
                let redundant = false;
                let lParts = phrase.split(' ').map(x => x.toLowerCase());
                for (let p of lParts) {
                    for (let tag of subitem._inherited_tags) {
                        if (tag.toLowerCase() === p) {
                            redundant = true;
                            break;
                        }
                    }
                }
                if (redundant === false) {
                    edited.push(phrase);
                    editedReasons.push(reason);
                }
            }
            phrases = edited;
            reasons = editedReasons;
        }

        if (phrases.length != reasons.length) {
            console.warn('ERROR: phrases.length != reasons.length');
            debugger;
        }

        return [phrases, reasons];
    }

    function selectSuggestion(item, selectedSubitemPath) {
        if (selectedTagSuggestionId === 0) {
            return;
        }
        let choice = $('[data-tag-suggestion-id='+selectedTagSuggestionId+']').attr('data-tag-suggestion');

        if (choice === undefined) {
            console.warn('Choice was undefined');
            return;
        }

        if (ALWAYS_ADD_SPACE_TO_TAG_SUGGESTION) {
            choice = choice + ' ';
        }

        $model.updateSubTag(item, selectedSubitemPath, choice);

        let $input0 = $('[data-item-id='+item.id+']').find('.action-edit-tag');

        $view.updateTag(item, choice);

        let $input1 = $('[data-item-id='+item.id+']').find('.action-edit-tag');

        onChange(item, selectedSubitemPath, choice);
    }

    function updateSelectedTagSuggestion(id=0) {
        if (selectedTagSuggestionId !== 0) {
            $('[data-tag-suggestion-id='+selectedTagSuggestionId+']').removeClass('selected-tag-suggestion');
        }
        if (id >= 0) {
            selectedTagSuggestionId = id;
        }
        if (selectedTagSuggestionId !== 0) {
            $('[data-tag-suggestion-id='+selectedTagSuggestionId+']').addClass('selected-tag-suggestion');
        }
    }

    function onChange(item, selectedSubitemPath, tagsString) {
        showOptions();
        let subitemIndex = $model.getSubItemIndex(selectedSubitemPath);
        let subitem = item.subitems[subitemIndex];
        let parseResults = $parseTagging(tagsString);
        if (parseResults === null) {
            console.warn('ILLEGAL PARSE');
            $view.illegalTag(item);
        }
        else {
            let [phrases, reasons] = getSuggestions(item, subitemIndex, parseResults);
            let $el = $view.getItemTagSuggestionsElementById(item.id);
            applyPhrases($el, phrases, reasons);
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
