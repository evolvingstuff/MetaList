"use strict";

let $auto_complete_search = (function () {

    const ALWAYS_ADD_SPACE_TO_SUGGESTION = false;
    const USE_WEIGHTED_SEARCH_HISTORY = true;
    const MAX_PARSE_RESULTS_TO_USE_WEIGHTED_SEARCH_HISTORY = 5; //1
    const USE_WEIGHTED_SEARCH_HISTORY_WHEN_EMPTY = true;
    const DEFAULT_SELECT_FIRST = true;

    //TODO: don't control UI stuff in this file
    let divAuto = document.getElementById('div-search-suggestions');
    let inpSearch = document.getElementById('search-input');
    let modeHidden = true;
    let parseResults = [];
    let recentTotalPhrases = 0;

    function getParseResults() {
        return parseResults;
    }

    function getModeHidden() {
        return modeHidden;
    }

    function getSearchString() {
        return inpSearch.value;
    }

    function refreshParse() {
        parseResults = $parseSearch.parse(inpSearch.value);
        if (parseResults === null) {
            inpSearch.style['color'] = 'red';
            divAuto.innerHTML = '';
            localStorage.removeItem('search');
            return;
        }
        else {
            let soFarUnknownTag = null;
            for (let result of parseResults) {
                if (result.partial === true &&
                    (result.valid_exact_tag_matches === undefined || result.valid_exact_tag_matches.length === 0) &&
                    (result.valid_prefix_tag_matches === undefined || result.valid_prefix_tag_matches.length === 0)) {
                    soFarUnknownTag = result.text;
                }
            }

            if (soFarUnknownTag) {
                //TODO: this is getting errors for string search.
                //console.warn('Did not recognize tag "'+soFarUnknownTag+'"');
                inpSearch.style['color'] = 'grey';
            }
            else {
                inpSearch.style['color'] = 'black';
            }
        }
    }

    function onChange() {

        refreshParse();

        if (parseResults === null) {
            return;
        }

        let phrases = [];

        ////////////////////////////////
        // DEAL WITH EMPTY PARSE RESULTS
        ////////////////////////////////

        if (parseResults.length === 0) {

            //Then suggest single tags, sorted by frequency

            let allTags = [];
            $model.fullyIncludeAllItems();
            if (USE_WEIGHTED_SEARCH_HISTORY_WHEN_EMPTY) {
                allTags = $model.getIncludedSearchWeightedTagCounts(parseResults);
                //console.log('weighted');
            }
            else {
                allTags = $model.getIncludedTagCounts();
                //console.log('---');
            }

            for (let i = 0; i < allTags.length; i++) {
                phrases.push(allTags[i].tag);
            }
            applyPhrases(phrases);
            return;
        }

        ////////////////////////////////////
        // DEAL WITH NON-EMPTY PARSE RESULTS
        ////////////////////////////////////
        
        let last = parseResults[parseResults.length-1];

        let allowPrefixMatches = true;
        $model.filterItemsWithParse(parseResults, allowPrefixMatches); //TODO: the fact that this is called here is used by the render algorithm. Bad coupling

        /////////////////////////////
        // SKIP SUBSTRING SUGGESTIONS
        /////////////////////////////
        if (last !== null && last.partial === true && last.type === 'substring') {
            divAuto.innerHTML = '';
            return;
        }

        ////////////////////////////
        // SUGGEST REMAINING TAGS
        ////////////////////////////
        let pre = '';
        for (let i = 0; i < parseResults.length-1; i++) {
            pre += parseResults[i].src + ' ';
        }
        pre = pre.trim();

        let sortedIncludedTagCounts = [];

        let totFull = 0;
        for (let pr of parseResults) {
            if (pr.partial === undefined) {
                totFull += 1;
            }
            else {
                break;
            }
        }

        if (USE_WEIGHTED_SEARCH_HISTORY && 
            totFull < MAX_PARSE_RESULTS_TO_USE_WEIGHTED_SEARCH_HISTORY) {
            sortedIncludedTagCounts = $model.getIncludedSearchWeightedTagCounts(parseResults);
        }
        else {
            sortedIncludedTagCounts = $model.getIncludedTagCounts();
        }
        let implications = $ontology.getImplications();

        if (last.partial === true) {
            if (last.type === 'unknown') {
                //do nothing
            }
            else if (last.type === 'tag') {
                
                let pre = '';
                for (let p = 0; p < parseResults.length-1; p++) { //Don't include last, as we are auto completing it
                    pre += parseResults[p].src + ' ';
                }

                //need to know relevant remaining tags that fix prefix of last, and haven't already been suggested
                let maybeNeg = '';
                if (last.negated) {
                    maybeNeg = '-';
                }

                for (let item of sortedIncludedTagCounts) {
                    //TODO: get rid of implication matches too
                    let literalMatchAlready = false;
                    let impliedMatchAlready = false;
                    for (let p of parseResults) {
                        if (p.type === 'tag' && p.text.toLowerCase() === item.tag.toLowerCase()) {
                            literalMatchAlready = true;
                            break;
                        }
                        if (implications[p.text] !== undefined) {
                            for (let imp of implications[p.text]) {
                                if (imp.toLowerCase() === item.tag.toLowerCase()) {
                                    impliedMatchAlready = true;
                                    break;
                                }
                            }
                        }
                        if (impliedMatchAlready) {
                            break;
                        }
                    }
                    if (literalMatchAlready === true || impliedMatchAlready === true) {
                        continue;
                    }

                    if (item.tag.toLowerCase().startsWith(last.text.toLowerCase())) {
                        let suggestion = pre + maybeNeg + item.tag;
                        if (phrases.includes(suggestion) === false) {
                            phrases.push(suggestion);
                        }
                    }
                }
            }
            else if (last.type === 'substring') {
                throw "Unexpected - should have exited by now because not currently suggesting substring completions";
            }
            else {
                throw "Unexpected";
            }
        }
        else {
            if (last.type === 'tag' || last.type === 'substring') {

                let pre = '';
                for (let p = 0; p < parseResults.length; p++) { //Include last, because we are suggesting new
                    pre += parseResults[p].src + ' ';
                }

                for (let item of sortedIncludedTagCounts) {
                    //TODO: get rid of implication matches too
                    let literalMatchAlready = false;
                    let impliedMatchAlready = false;
                    for (let p of parseResults) {
                        if (p.type === 'tag' && p.text.toLowerCase() === item.tag.toLowerCase()) {
                            literalMatchAlready = true;
                            break;
                        }
                        if (implications[p.text] !== undefined) {
                            for (let imp of implications[p.text]) {
                                if (imp.toLowerCase() === item.tag.toLowerCase()) {
                                    impliedMatchAlready = true;
                                    break;
                                }
                            }
                        }
                        if (impliedMatchAlready) {
                            break;
                        }
                    }
                    if (literalMatchAlready === true || impliedMatchAlready === true) {
                        continue;
                    }
                    let suggestion = pre + item.tag;
                    if (phrases.includes(suggestion) === false) {
                        phrases.push(suggestion);
                    }
                }
            }
            else {
                throw "Unexpected";
            }
        }

        applyPhrases(phrases);

        if (DEFAULT_SELECT_FIRST) {
            if (last.partial === true && last.type === 'tag') {
                let validTags = $model.getAllTags();
                if (validTags.includes(last.text)) {
                    updateSelectedSearchSuggestion(0);
                }
                else {
                    updateSelectedSearchSuggestion(1);
                }
            }
            else {
                updateSelectedSearchSuggestion(1);
            }
        }
    }

    function applyPhrases(phrases) {

        recentTotalPhrases = phrases.length;

        let suggestionId = 1;
        let html = '';
        for (let i = 0; i < phrases.length; i++) {

            /* 2019.05.26
               This appears to be VERY sensitive to the escaping mechanism involved.
               So it completely broke when I do string.replace(/ /g, '&nbsp;')
               I don't fully understand why, but I clearly need to!
               Previously broken at commit 7aceac07a5874c6ed5027fd0a3c5bae9a56cd4a5
            */

            let escaped = escapeHtml(phrases[i]);
            html += '<div data-suggestion-id="'+suggestionId+'" data-suggestion="'+escaped+'" class="suggestion">'+escaped+'</div>';
            suggestionId++;
        }
        divAuto.innerHTML = html;
        updateSelectedSearchSuggestion();
        if (phrases.length === 0) {
            hideOptions();
        }
        else {
            showOptions();
        }
    }

    function hideOptions() {
        divAuto.style.display = 'none';
        modeHidden = true;
    }

    function showOptions() {
        if (recentTotalPhrases > 0) {
            divAuto.style.display = 'block';
            modeHidden = false;
        }
        if (DEFAULT_SELECT_FIRST) {
            updateSelectedSearchSuggestion(1);
        }
    }

    function selectSuggestion() {
        if (state.selectedSuggestionId === 0 || modeHidden) {
            return false;
        }
        let choice = $('[data-suggestion-id='+state.selectedSuggestionId+']').attr('data-suggestion');
        if (ALWAYS_ADD_SPACE_TO_SUGGESTION) {
            choice = choice + ' ';
        }
        $(inpSearch).val(choice);
        return true;
    }

    function updateSelectedSearchSuggestion(id=0) {
        if (state.selectedSuggestionId !== 0) {
            $('[data-suggestion-id='+state.selectedSuggestionId+']').removeClass('selected-search-suggestion');
        }
        if (id >= 0) {
            state.selectedSuggestionId = id;
        }
        if (state.selectedSuggestionId !== 0) {
            $('[data-suggestion-id='+state.selectedSuggestionId+']').addClass('selected-search-suggestion');
        }
        focus();
    }

    function focus() {
    	inpSearch.focus();
    }

    function blur() {
        //inpSearch.blur();  //TODO this may not be desirable
    }

    function hasFocus() {
        if (document.activeElement === inpSearch) {
            return true;
        }
        else {
            return false;
        }
    }

    function arrowUp() {
        updateSelectedSearchSuggestion(state.selectedSuggestionId-1);
    }

    function arrowDown() {
        updateSelectedSearchSuggestion(state.selectedSuggestionId+1);
    }

    function getTagsFromSearch() {
        let currentSearchString = $auto_complete_search.getSearchString();
        let parseResults = $parseSearch.parse(currentSearchString);
        if (parseResults === null) {
            console.warn('invalid parse, will not add new');
            return null;
        }

        let arr = []
        for (let result of parseResults) {
            if (result.type === 'tag' &&
                result.negated === undefined &&
                result.valid_exact_tag_matches.length > 0) {

                if (arr.includes(result.valid_exact_tag_matches[0]) === false) {
                    arr.push(result.valid_exact_tag_matches[0])
                }
            }
            //Need this to add new, non-existing tags
            if (result.type === 'tag' &&
                result.negated === undefined &&
                result.partial === true) {

                if (arr.includes(result.text) === false) {
                    arr.push(result.text);
                }
            }
        }
        let tags = arr.join(' ');
        return tags;
    }

    return {
        focus: focus,
        blur: blur,
        hasFocus: hasFocus,
        onChange: onChange,
        selectSuggestion: selectSuggestion,
        showOptions: showOptions,
        hideOptions: hideOptions,
        arrowUp: arrowUp,
        arrowDown: arrowDown,
        updateSelectedSearchSuggestion: updateSelectedSearchSuggestion,
        getParseResults: getParseResults,
        getModeHidden: getModeHidden,
        refreshParse: refreshParse,
        getSearchString: getSearchString,
        getTagsFromSearch: getTagsFromSearch
    };
})();
