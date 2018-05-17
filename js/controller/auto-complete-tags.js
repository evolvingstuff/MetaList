"use strict";
var $auto_complete_tags = (function () {

    let selected_tag_suggestion_id = 0;

    let PRIORITY_RANK = false; //true doesn't work as well it seems

    let _cache = {};

    let mode_hidden = true;

    function getModeHidden() {
        return mode_hidden;
    }

    function _updateDataList(selectedItemId, phrases) {
        let $div = $('[data-item-id='+selectedItemId+']')[0];
        let $sugg = $($div).find('.tag-suggestions')[0];
        applyPhrases($sugg, phrases);
    }

    function applyPhrases($div, phrases) {
        let suggestion_id = 1;
        let html = '';
        for (var i = 0; i < phrases.length; i++) {
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

    function getSuggestions(selectedItemId, subitem, parse_results) {
        let timer = new Timer("suggest timer");
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
                let possible_phrases = _suggestNew(subitem, prefix);
                //Test if this is a valid completion of current word
                for (let possible_phrase of possible_phrases) {
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
                let phrases = _suggestNew(subitem, prefix);
                timer.end();
                timer.display();
                _cache[h] = phrases;
                return phrases;
            }
        }
        else {
            console.log('No parse results, handle this!');
            let phrases = _suggestNew(subitem, prefix);
            timer.end();
            timer.display();
            _cache[h] = phrases;
            return phrases;
        }

        
    }

    function _suggestNew(subitem, prefix) {
        console.log('DEBUG: _suggestNew()');
        let struct = {};
        for (let item of $model.getItems()) {

            let flat = $model.enumerate(item);
            for (let sub of flat) {
                let match_tot = 0;
                let suggestions = [];

                //implications
                let enriched = $ontology.getEnrichedTags(sub._tags);
                for (let tag of enriched) {
                    if (subitem._tags.includes(tag)) {
                        match_tot += 1;
                    }
                }

                //specific
                for (let tag of sub._tags) {
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
        let phrases = [];
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

        let list = $model.getEnrichedAndSortedTagList($model.getItems());

        for (let tag of list) {
            let phrase = prefix+tag.tag;
            if (phrases.includes(phrase) == false) {
                phrases.push(phrase);
            }
        }

        console.log('suggesting ' + phrases.length + ' phrases');

        return phrases;
    }

    function selectSuggestion(selectedItemId, selectedSubitemPath) {
        if (selected_tag_suggestion_id == 0) {
            return;
        }
        let choice = $('[data-tag-suggestion-id='+selected_tag_suggestion_id+']').attr('data-tag-suggestion');
        console.log('choice = ' + choice);

        if (selectedSubitemPath == '' || selectedSubitemPath == null) {
            $model.updateTag(selectedItemId, choice);
        }
        else {
            $model.updateSubTag(selectedItemId, selectedSubitemPath, choice);
        }
        $view.updateTag(selectedItemId, choice);
        onChange(selectedItemId, selectedSubitemPath);
    }



    function updateSelectedSearchSuggestion(id=0) {
        if (selected_tag_suggestion_id != 0) {
            $('[data-tag-suggestion-id='+selected_tag_suggestion_id+']').removeClass('selected-tag-suggestion');
        }
        if (id >= 0) {
            selected_tag_suggestion_id = id;
        }
        if (selected_tag_suggestion_id != 0) {
            $('[data-tag-suggestion-id='+selected_tag_suggestion_id+']').addClass('selected-tag-suggestion');
        }
        //focus();
    }

    function onChange(selectedItemId, selectedSubitemPath) {
        //$view.legalTag(selectedItemId);
        showOptions();
        console.log('selectedItemId = ' + selectedItemId + ' / subitem path = ' + selectedSubitemPath);
        let item = $model.getItemById(selectedItemId);
        $search2.decorateItemTags(item);
        let subitem = null;
        if (selectedSubitemPath == null) {
            subitem = item;
        }
        else {
            subitem = $model.getSubitem(selectedItemId, selectedSubitemPath);
        }

        let parse_results = $parseTagging(subitem.tags);

        if (parse_results == null) {
            console.log('ILLEGAL PARSE');
            //TODO: how to deal with this visually? Or just don't allow it to be typed?
            $view.illegalTag(selectedItemId);
        }
        else {
            //console.log('parse_results: ' + JSON.stringify(parse_results));
            let phrases = getSuggestions(selectedItemId, subitem, parse_results);
            _updateDataList(selectedItemId, phrases);
            updateSelectedSearchSuggestion();
            $view.legalTag(selectedItemId);
        }
    }

    function arrowUp() {
        console.log('arrow up todo');
        updateSelectedSearchSuggestion(selected_tag_suggestion_id-1);
    }

    function arrowDown() {
        console.log('arrow down todo');
        updateSelectedSearchSuggestion(selected_tag_suggestion_id+1);
    }


    return {
        onChange: onChange,
        hideOptions: hideOptions,
        showOptions: showOptions,
        updateSelectedSearchSuggestion: updateSelectedSearchSuggestion,
        selectSuggestion: selectSuggestion,
        arrowUp: arrowUp,
        arrowDown: arrowDown,
        getModeHidden: getModeHidden
    };
})();
