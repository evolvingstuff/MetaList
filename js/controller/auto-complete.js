"use strict";
let $auto_complete = (function () {

    let div_auto = document.getElementById('div_auto');
    let inp_search = document.getElementById('search_input');
    let selected_suggestion_id = 0;
    let mode_hidden = true;

    let ALWAYS_ADD_SPACE_TO_SUGGESTION = false;

    let SUGGEST_SEARCH_HISTORY = true;
    let MAX_SEARCH_HISTORY_DEPTH = 10;

    let parse_results = [];

    function getParseResults() {
        return parse_results;
    }

    function getModeHidden() {
        return mode_hidden;
    }

    function getSearchString() {
        return inp_search.value;
    }

    function refreshParse(items) {
        let current_search_string = inp_search.value;
        parse_results = $parseSearch(items, current_search_string);
        if (parse_results == null) {
            inp_search.style['color'] = 'red';
            div_auto.innerHTML = '';
            return;
        }
        else {

            let so_far_unknown_tag = null;
            for (let result of parse_results) {
                if (result.partial == true &&
                    (result.valid_exact_tag_matches == undefined || result.valid_exact_tag_matches.length == 0) &&
                    (result.valid_prefix_tag_matches == undefined || result.valid_prefix_tag_matches.length == 0)) {
                    so_far_unknown_tag = result.text;
                }
            }

            if (so_far_unknown_tag) {
                console.log('Did not recognize tag "'+so_far_unknown_tag+'"');
                inp_search.style['color'] = 'grey';
            }
            else {
                inp_search.style['color'] = 'black';
            }
        }
    }

    function onChange(items) {

        let timer = new Timer("Parse&Search");

        refreshParse(items);

        console.log('CHECKPOINT 1');

        if (parse_results == null) {
            return;
        }

        console.log('CHECKPOINT 2');

        ////////////////////////////////
        // DEAL WITH EMPTY PARSE RESULTS
        ////////////////////////////////
        if (parse_results.length == 0) {
            let phrases = [];
            if (SUGGEST_SEARCH_HISTORY) {
                phrases = $searchHistory.getHistorySuggestions(MAX_SEARCH_HISTORY_DEPTH);
            }
            let all_tags = $model.getEnrichedAndSortedTagList(items);
            for (let i = 0; i < all_tags.length; i++) {
                phrases.push(all_tags[i].tag);
            }
            applyPhrases(phrases);
            return;
        }

        
        let last = parse_results[parse_results.length-1];

        let allow_prefix_matches = true;
        $filter.filterItemsWithParse(items, parse_results, allow_prefix_matches); //TODO: the fact that this is called here is used by the render algorithm. Bad coupling

        /////////////////////////////
        // SKIP SUBSTRING SUGGESTIONS
        /////////////////////////////
        if (last != null && last.partial == true && last.type == 'substring') {
            console.log('Currently not making suggestions for substrings');
            div_auto.innerHTML = '';
            return;
        }

        ////////////////////////////
        // SUGGEST REMAINING TAGS
        ////////////////////////////

        let pre = '';
        for (let i = 0; i < parse_results.length-1; i++) {
            pre += parse_results[i].src + ' ';
        }
        pre = pre.trim();

        let phrases = [];

        let timer_counts = new Timer('getIncludedTagCounts');
        let sorted_included_tag_counts = $filter.getIncludedTagCounts(items);
        timer_counts.end();
        //timer_counts.display();

        let implications = $ontology.getImplications();

        if (last.partial == true) {
            if (last.type == 'unknown') {
                //do nothing
            }
            else if (last.type == 'tag') {
                
                let pre = '';
                for (let p = 0; p < parse_results.length-1; p++) { //Don't include last, as we are auto completing it
                    pre += parse_results[p].src + ' ';
                }

                //need to know relevant remaining tags that fix prefix of last, and haven't already been suggested
                let maybe_neg = '';
                if (last.negated) {
                    maybe_neg = '-';
                }

                for (let item of sorted_included_tag_counts) {
                    //TODO: get rid of implication matches too
                    let literal_match_already = false;
                    let implied_match_already = false;
                    for (let p of parse_results) {
                        if (p.type == 'tag' && p.text == item.tag) {
                            literal_match_already = true;
                            break;
                        }
                        if (implications[p.text] != undefined) {
                            for (let imp of implications[p.text]) {
                                if (imp == item.tag) {
                                    implied_match_already = true;
                                    break;
                                }
                            }
                        }
                        if (implied_match_already) {
                            break;
                        }
                    }
                    if (literal_match_already == true || implied_match_already == true) {
                        continue;
                    }

                    if (item.tag.indexOf(last.text) == 0) {
                        phrases.push(pre + maybe_neg + item.tag);
                    }
                }
            }
            else if (last.type == 'substring') {
                console.log('DEBUG: partial substring');
                throw "Unexpected - should have exited by now because not currently suggesting substring completions";
            }
            else {
                throw "Unexpected";
            }
        }
        else {
            if (last.type == 'tag' || last.type == 'substring') {

                let pre = '';
                for (let p = 0; p < parse_results.length; p++) { //Include last, because we are suggesting new
                    pre += parse_results[p].src + ' ';
                }

                for (let item of sorted_included_tag_counts) {
                    //TODO: get rid of implication matches too
                    let literal_match_already = false;
                    let implied_match_already = false;
                    for (let p of parse_results) {
                        if (p.type == 'tag' && p.text == item.tag) {
                            literal_match_already = true;
                            break;
                        }
                        if (implications[p.text] != undefined) {
                            for (let imp of implications[p.text]) {
                                if (imp == item.tag) {
                                    implied_match_already = true;
                                    break;
                                }
                            }
                        }
                        if (implied_match_already) {
                            break;
                        }
                    }
                    if (literal_match_already == true || implied_match_already == true) {
                        continue;
                    }
                    phrases.push(pre + item.tag);
                }
            }
            else {
                throw "Unexpected";
            }
        }

        timer.end();

        applyPhrases(phrases);
    }

    function applyPhrases(phrases) {
        let suggestion_id = 1;
        let html = '';
        for (let i = 0; i < phrases.length; i++) {
            let escaped = escapeHtml(phrases[i]);
            html += '<div data-suggestion-id="'+suggestion_id+'" data-suggestion="'+escaped+'" class="suggestion">'+escaped+'</div>';
            suggestion_id++;
        }
        div_auto.innerHTML = html;
        updateSelectedSearchSuggestion();
        if (phrases.length == 0) {
            hideOptions();
        }
        else {
            showOptions();
        }
    }

    function hideOptions() {
        div_auto.style.display = 'none';
        mode_hidden = true;
    }

    function showOptions() {
        div_auto.style.display = 'block';
        mode_hidden = false;
    }

    function selectSuggestion() {
        if (selected_suggestion_id == 0 || mode_hidden) {
            return;
        }
        let choice = $('[data-suggestion-id='+selected_suggestion_id+']').attr('data-suggestion');
        if (ALWAYS_ADD_SPACE_TO_SUGGESTION) {
            choice = choice + ' ';
        }
        $(inp_search).val(choice);
    }

    function updateSelectedSearchSuggestion(id=0) {
        if (selected_suggestion_id != 0) {
            $('[data-suggestion-id='+selected_suggestion_id+']').removeClass('selected-suggestion');
        }
        if (id >= 0) {
            selected_suggestion_id = id;
        }
        if (selected_suggestion_id != 0) {
            $('[data-suggestion-id='+selected_suggestion_id+']').addClass('selected-suggestion');
        }
        focus();
    }

    function focus() {
    	inp_search.focus();
    }

    function arrowUp() {
        updateSelectedSearchSuggestion(selected_suggestion_id-1);
    }

    function arrowDown() {
        updateSelectedSearchSuggestion(selected_suggestion_id+1);
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
