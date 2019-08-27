"use strict";

let $auto_complete_tags = (function () {

    const DEVELOPER_MODE = false;
    const MAX_SUGGESTIONS = 50;
    const LITERAL_SUGGESTIONS_OF_EXISTING_TAGS = true;
    const LITERAL_PHRASE_SUGGESTIONS_OF_EXISTING_TAGS = true;
    const TRIPLE_WORD_PHRASES_OF_EXISTING_TAGS = true;
    const SUGGEST_ENRICHED_IMPLICATIONS = true;
    const GENERIC_SUGGESTIONS = true;
    const ALWAYS_ADD_SPACE_TO_SUGGESTION = true;
    const SUGGEST_NEW_TAGS_FROM_TEXT = true;
    const SUGGEST_NEW_TAGS_FROM_TEXT_DOUBLE_WORD = false;
    const SUGGEST_NEW_TAGS_FROM_TEXT_TRIPLE_WORD = false;
    const SUGGEST_ACRONYMS = true;
    const MIN_ACRONYM_LENGTH = 3;
    const MAX_ACRONYM_LENGTH = 5;
    const SUGGEST_NUMERIC_TAGS_WITH_VALUES = true;
    const SUGGEST_META = true;

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

    const SUGGESTED_META = [
                            '@meta', 
                            '@todo', '@done',
                            '@list-numbered', '@list-bulleted',
                            '@+', '@-',
                            '@date-headline',
                            '@goto', '@embed',
                            '@username', '@password', '@email',
                            '@private','@hide', '@copy',
                            '@markdown', '@csv' , '@json', 
                            '@code', '@exec',
                            '@LaTeX', '@nomnoml',
                            '@html',
                            '@monospace',
                            '@text-only',
                            '@bold', '@italic', '@strikethrough',
                            '@h1', '@h2', '@h3', '@h4',
                            '@red', '@green', '@blue', '@grey'
                        ];

    let _cache = {};
    let modeHidden = true;
    let selectedTagSuggestionId = 0;

    function resetCache() {
        _cache = {};
    }

    function getModeHidden() {
        return modeHidden;
    }

    function _updateDataList(item, phrases) {
        let $div = $('[data-item-id='+item.id+']')[0];
        let $sugg = $($div).find('.tag-suggestions')[0];
        applyPhrases($sugg, phrases);
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
    }

    function getLiteralSuggestionsOfExistingTags(data, partialTag, allItemTags) {
        let start = Date.now();
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

            let lowWord = word.toLowerCase();

            if (tags[lowWord] != undefined) {
                if (word.length == 0) {
                    alert("BUG");
                }
                result.push(tags[lowWord]);
                console.log('push 0 ' + lowWord);
            }

            let add_alterations = ["es", "s", "'s", "ly", "d"];
            let subtract_alterations = ["es", "s", "'s", "ly", "ded"];

            if (/\d/.test(lowWord) == false) { //do not suggests alterations for substrings containing numbers
                for (let alt of add_alterations) {
                    let lowWordAltPlus = lowWord + alt;
                    if (tags[lowWordAltPlus] != undefined) {
                        result.push(tags[lowWordAltPlus]);
                    }
                }

                for (let alt of subtract_alterations) {
                    let re = new RegExp('(.*?)'+alt+'$'); //TODO: precompile
                    let lowWordAltMinus = lowWord.replace(re, '$1');
                    if (tags[lowWordAltMinus] != undefined) {
                        result.push(tags[lowWordAltMinus]);
                    }
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

    function getAcronymSuggestions(data, partialTag, allItemTags) {
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
                if (allItemTags.includes(ABRV)) {
                    console.log('Suggesting acronym: ' + ABRV);
                    result.push(ABRV);
                }
            }
        }
        let end = Date.now();
        console.log('Find acronyms took ' + (end-start) + 'ms');
        return result;
    }

    function getLiteralPhraseSuggestionsOfExistingTags(data, partialTag, allItemTags) {

        //TODO: factor this out! Repeated in parse-tagging.js

        console.log('getLiteralPhraseSuggestionsOfExistingTags()');

        let start = Date.now();

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
                    if (tag.startsWith('@') || tag.startsWith('#')) {
                        //Don't propagate meta or macro rules to children
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
            let lowWord1 = words[i].toLowerCase();
            let lowWord2 = words[i+1].toLowerCase();

            let combiners = ['-','_','/','.'];

            for (let combiner of combiners) {
                let lowPhrase = lowWord1 + combiner + lowWord2;
                //console.log('\ttrying phrase ' + lowPhrase);
                if (tags[lowPhrase] != undefined) {
                    console.log('Phrase match on "'+lowWord1+' '+lowWord2+'" -> ' + tags[lowPhrase]);
                    result.push(tags[lowPhrase]);
                }

                let lowPhraseReverse = lowWord2 + combiner + lowWord1;
                if (tags[lowPhraseReverse] != undefined) {
                    console.log('Phrase match on "'+lowWord2+' '+lowWord1+'" -> ' + tags[lowPhraseReverse]);
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
                        console.log('Phrase match on "'+lowWord1+' '+lowWord2+' '+lowWord3+'" -> ' + tags[lowPhrase]);
                        result.push(tags[lowPhrase]);
                    }
                }
            }
        }

        let end = Date.now();
        console.log('literal phrase suggestions took ' + (end-start) + 'ms');
        return result;
    }

    function getSuggestions(item, subitemIndex, parseResults) {
        console.log('getSuggestions()');
        let subitem = item.subitems[subitemIndex];
        let timer = new Timer("SUGGEST TIMER");
        //TODO: this hashing logic prevents sequential suggestions because it ignores prev siblings
        let h = hashCode(JSON.stringify(subitem)+JSON.stringify(parseResults));
        //BUG: this is never called because items will have new _timestamp_update values
        if (_cache[h] != undefined) {
            console.log('*cached');
            timer.end();
            timer.display();
            return _cache[h];
        }

        let words = [];
        for (let parseResult of parseResults) {
            let tag = parseResult.text;
            if (parseResult.value != undefined) { //this handles numeric tags
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
                    //handle numeric
                    if (parseResults[i].value != undefined) {
                        prefix += '='+parseResults[i].value;
                    }
                    prefix += ' ';
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

                console.log('phrases.length = ' + phrases.length);

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
                let phrases = _suggestNew(item, subitemIndex, prefix, null);
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
            let phrases = _suggestNew(item, subitemIndex, prefix, null);
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

        let subitem = item.subitems[subitemIndex];

        console.log('^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^');
        console.log('_suggestNew()');
        let timer = new Timer("_suggestNew()");
        let phrases = [];
        let literals = [];

        let allItemTags = $model.getAllTags();

        if (SUGGEST_ACRONYMS) {
            let acronyms = getAcronymSuggestions(subitem.data, partialTag, allItemTags);
            let prefixWords = prefix.split(' ');
            for (let tag of acronyms) {
                if (prefixWords.includes(tag)) {
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
            literals = getLiteralPhraseSuggestionsOfExistingTags(subitem.data, partialTag, allItemTags);
            let prefixWords = prefix.split(' ');
            for (let tag of literals) {
                if (prefixWords.includes(tag)) {
                    continue;
                }
                let phrase = prefix+tag;
                if (phrases.includes(phrase) == false) {
                    phrases.push(phrase);
                }
            }
        }

        if (LITERAL_SUGGESTIONS_OF_EXISTING_TAGS) {
            literals = getLiteralSuggestionsOfExistingTags(subitem.data, partialTag, allItemTags);
            let prefixWords = prefix.split(' ');
            for (let tag of literals) {
                if (prefixWords.includes(tag)) {
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

        let startSuggestSimilar = Date.now();

        const items = $model.getUnsortedItems();
        console.log('\t\t\tlooping over ' + items.length + ' items');

        let allSubitemTags = subitem._tags.concat(subitem._implied_tags).concat(subitem._inherited_tags); 

        for (let otherItem of items) {

            if (otherItem.id == item.id) {
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
                let matchTot = 0;
                let newTags = [];

                //let allOtherTags = otherSubitem._tags.concat(otherSubitem._implied_tags);
                let allOtherTags = otherSubitem._tags.concat(otherSubitem._implied_tags).concat(otherSubitem._inherited_tags);

                if (partialTag == null) {
                    for (let tag of allSubitemTags) {
                        if (allOtherTags.includes(tag)) {
                            matchTot++;
                        }
                    }
                }
                else {
                    let atLeastOneMatchOfPartial = false;
                    for (let otherTag of allOtherTags) {
                        if (otherTag.toLowerCase().startsWith(partialTag.toLowerCase())) {
                            atLeastOneMatchOfPartial = true;
                            matchTot++;
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
                            if (partialTag == null) {
                                newTags.push(otherTag);
                            }
                            else {
                                if (otherTag.startsWith(partialTag)) {
                                    newTags.push(otherTag);
                                }
                            }
                        }
                    }
                    else {
                        //TODO: is there any logic that needs to go here?
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
        let endSuggestSimilar = Date.now();
        console.log('Suggesting tags from similar subitems, took '+(endSuggestSimilar-startSuggestSimilar)+'ms');

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
            let timerNumeric = new Timer('\t\tnumeric');
            let numberlikes = getNumberlikeElements(subitem.data);
            if (numberlikes.length > 0) {
                let numericTags = $model.getNumericTags();
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
            timerNumeric.end();
            timerNumeric.display();
        }

        let implications = $ontology.getImplications();
        //phrases = removeRedundancies(subitem, phrases, partialTag, implications);

        let timer4 = new Timer('\t\tgeneric suggestions');
        if (GENERIC_SUGGESTIONS && phrases.length < MAX_SUGGESTIONS) {
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

        phrases = removeRedundancies(subitem, phrases, partialTag, implications);

        phrases = phrases.slice(0, MAX_SUGGESTIONS);

        timer.end();
        timer.display();

        return phrases;
    }

    function removeRedundancies(subitem, phrases, partialTag, implications) {
        let timer6 = new Timer('\t\tremove redundancies');
        let edited = [];
        //Get rid of redundant implications
        if (partialTag == null) { //Only do this when not in middle of typing a tag
            for (let phrase of phrases) {
                let redundant = false;
                let parts = phrase.split(' ');
                if (parts[parts.length-1].startsWith('@') && partialTag == null) {
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
        timer6.end();
        timer6.display();
        return phrases;
    }

    function selectSuggestion(item, selectedSubitemPath) {
        if (selectedTagSuggestionId == 0) {
            return;
        }
        let choice = $('[data-tag-suggestion-id='+selectedTagSuggestionId+']').attr('data-tag-suggestion');
        console.log('choice = ' + choice);

        if (ALWAYS_ADD_SPACE_TO_SUGGESTION) {
            choice = choice + ' ';
        }

        $model.updateSubTag(item, selectedSubitemPath, choice);
        $view.updateTag(item, choice);
        onChange(item, selectedSubitemPath);
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

    function onChange(item, selectedSubitemPath) {
        showOptions();
        console.log('item.id = ' + item.id + ' / subitem path = ' + selectedSubitemPath);
        let subitemIndex = $model.getSubItemIndex(selectedSubitemPath);
        let subitem = item.subitems[subitemIndex];
        let parseResults = $parseTagging(subitem.tags);
        if (parseResults == null) {
            console.log('ILLEGAL PARSE');
            //TODO: how to deal with this visually? Or just don't allow it to be typed?
            $view.illegalTag(item);
        }
        else {
            let phrases = getSuggestions(item, subitemIndex, parseResults);
            _updateDataList(item, phrases);
            updateSelectedTagSuggestion();
            $view.legalTag(item);
        }
    }

    function arrowUp() {
        console.log('arrow up todo');
        updateSelectedTagSuggestion(selectedTagSuggestionId-1);
    }

    function arrowDown() {
        console.log('arrow down todo');
        updateSelectedTagSuggestion(selectedTagSuggestionId+1);
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
