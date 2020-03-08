"use strict";

let $auto_complete_search = (function () {

    const ALWAYS_ADD_SPACE_TO_SUGGESTION = true;  //TODO: maybe a bug with false
    const USE_WEIGHTED_SEARCH_HISTORY = true;
    const MAX_PARSE_RESULTS_TO_USE_WEIGHTED_SEARCH_HISTORY = 5; //1
    const USE_WEIGHTED_SEARCH_HISTORY_WHEN_EMPTY = true;
    const DEFAULT_SELECT_FIRST = false;

    //TODO: don't control UI stuff in this file
    let divAuto = document.getElementById('div-auto');
    let inpSearch = document.getElementById('search-input');
    let selectedSuggestionId = 0;
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
        if (parseResults == null) {
            inpSearch.style['color'] = 'red';
            divAuto.innerHTML = '';
            return;
        }
        else {
            let soFarUnknownTag = null;
            for (let result of parseResults) {
                if (result.partial == true &&
                    (result.valid_exact_tag_matches == undefined || result.valid_exact_tag_matches.length == 0) &&
                    (result.valid_prefix_tag_matches == undefined || result.valid_prefix_tag_matches.length == 0)) {
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

        if (parseResults == null) {
            return;
        }

        let phrases = [];

        ////////////////////////////////
        // DEAL WITH EMPTY PARSE RESULTS
        ////////////////////////////////

        if (parseResults.length == 0) {

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
        if (last != null && last.partial == true && last.type == 'substring') {
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
            if (pr.partial == undefined) {
                totFull += 1;
            }
            else {
                break;
            }
        }

        if (USE_WEIGHTED_SEARCH_HISTORY && 
            totFull < MAX_PARSE_RESULTS_TO_USE_WEIGHTED_SEARCH_HISTORY) {
            sortedIncludedTagCounts = $model.getIncludedSearchWeightedTagCounts(parseResults);
            //console.log('weighted / parseResults.length = ' + parseResults.length);
        }
        else {
            sortedIncludedTagCounts = $model.getIncludedTagCounts();
            //console.log('---');
        }
        let implications = $ontology.getImplications();

        if (last.partial == true) {
            if (last.type == 'unknown') {
                //do nothing
            }
            else if (last.type == 'tag') {
                
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
                        if (p.type == 'tag' && p.text.toLowerCase() == item.tag.toLowerCase()) {
                            literalMatchAlready = true;
                            break;
                        }
                        if (implications[p.text] != undefined) {
                            for (let imp of implications[p.text]) {
                                if (imp.toLowerCase() == item.tag.toLowerCase()) {
                                    impliedMatchAlready = true;
                                    break;
                                }
                            }
                        }
                        if (impliedMatchAlready) {
                            break;
                        }
                    }
                    if (literalMatchAlready == true || impliedMatchAlready == true) {
                        continue;
                    }

                    if (item.tag.toLowerCase().startsWith(last.text.toLowerCase())) {
                        let suggestion = pre + maybeNeg + item.tag;
                        if (phrases.includes(suggestion) == false) {
                            phrases.push(suggestion);
                        }
                    }
                }
            }
            else if (last.type == 'substring') {
                throw "Unexpected - should have exited by now because not currently suggesting substring completions";
            }
            else {
                throw "Unexpected";
            }
        }
        else {
            if (last.type == 'tag' || last.type == 'substring') {

                let pre = '';
                for (let p = 0; p < parseResults.length; p++) { //Include last, because we are suggesting new
                    pre += parseResults[p].src + ' ';
                }

                for (let item of sortedIncludedTagCounts) {
                    //TODO: get rid of implication matches too
                    let literalMatchAlready = false;
                    let impliedMatchAlready = false;
                    for (let p of parseResults) {
                        if (p.type == 'tag' && p.text.toLowerCase() == item.tag.toLowerCase()) {
                            literalMatchAlready = true;
                            break;
                        }
                        if (implications[p.text] != undefined) {
                            for (let imp of implications[p.text]) {
                                if (imp.toLowerCase() == item.tag.toLowerCase()) {
                                    impliedMatchAlready = true;
                                    break;
                                }
                            }
                        }
                        if (impliedMatchAlready) {
                            break;
                        }
                    }
                    if (literalMatchAlready == true || impliedMatchAlready == true) {
                        continue;
                    }
                    let suggestion = pre + item.tag;
                    if (phrases.includes(suggestion) == false) {
                        phrases.push(suggestion);
                    }
                }
            }
            else {
                throw "Unexpected";
            }
        }

        applyPhrases(phrases);
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
        if (phrases.length == 0) {
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
        console.log('showOptions search');
        if (DEFAULT_SELECT_FIRST) {
            updateSelectedSearchSuggestion(1);
        }
    }

    function selectSuggestion() {
        if (selectedSuggestionId == 0 || modeHidden) {
            return false;
        }
        let choice = $('[data-suggestion-id='+selectedSuggestionId+']').attr('data-suggestion');
        if (ALWAYS_ADD_SPACE_TO_SUGGESTION) {
            choice = choice + ' ';
        }
        $(inpSearch).val(choice);
        return true;
    }

    function updateSelectedSearchSuggestion(id=0) {
        if (selectedSuggestionId != 0) {
            $('[data-suggestion-id='+selectedSuggestionId+']').removeClass('selected-suggestion');
        }
        if (id >= 0) {
            selectedSuggestionId = id;
        }
        if (selectedSuggestionId != 0) {
            $('[data-suggestion-id='+selectedSuggestionId+']').addClass('selected-suggestion');
        }
        focus();
    }

    function focus() {
    	inpSearch.focus();
    }

    function arrowUp() {
        updateSelectedSearchSuggestion(selectedSuggestionId-1);
    }

    function arrowDown() {
        updateSelectedSearchSuggestion(selectedSuggestionId+1);
    }

    return {
        focus: focus,
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
        getSearchString: getSearchString
    };
})();
