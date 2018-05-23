"use strict";
let $ontology = (function () {

    let basic_implications = {};
    let implications = {};
    let _ontology_cache = '';
    let _per_line_cache = {};

    function getImplications() {
        return implications;
    }

    function enrichImplications() {
        implications = JSON.parse(JSON.stringify(basic_implications)); //copy basic implications
        //extend basic implications repeatedly until no new additions
        let modified = true;
        while (modified) {
            modified = false;
            let keys = Object.keys(implications);
            for (let i = 0; i < keys.length; i++) {
                let to_add = [];
                let key = keys[i];
                let setImps = new Set();
                for (let j = 0; j < implications[key].length; j++) {
                    let imp = implications[key][j];
                    setImps.add(imp);
                }
                for (let j = 0; j < implications[key].length; j++) {
                    let imp = implications[key][j];
                    if (basic_implications[imp] != undefined && basic_implications[imp] != null) {
                        let imps2 = basic_implications[imp];
                        for (let k = 0; k < imps2.length; k++) {
                            if (setImps.has(imps2[k]) == false) {
                                setImps.add(imps2[k]);
                                modified = true;
                            }
                        }
                    }
                }
                if (modified) {
                    implications[key] = Array.from(setImps);
                }
            }
        }
    }

    function getEnrichedTags(raw_tags) {
        let tags = null;
        if (Array.isArray(raw_tags)) {
            tags = raw_tags;
        }
        else {
            tags = raw_tags.split(' ');
        }
        let result = new Set();
        for (let i = 0; i < tags.length; i++) {
            let trimmed = tags[i].trim();
            if (trimmed == '') {
                continue;
            }
            result.add(trimmed);
            if (implications[trimmed] != undefined && implications[trimmed] != null) {
                for (let j = 0; j < implications[trimmed].length; j++) {
                    result.add(implications[trimmed][j]);
                }
            }
        }
        return Array.from(result);
    }

    //NOTE: this is used for negative search terms, where we want to remove the 
    //reverse of the implications
    function getReverseEnrichedTags(raw_tags) {
        let tags = null;
        if (Array.isArray(raw_tags)) {
            tags = raw_tags;
        }
        else {
            tags = raw_tags.split(' ');
        }
        let result = new Set();
        for (let i = 0; i < tags.length; i++) {
            let trimmed = tags[i].trim();
            if (trimmed == '') {
                continue;
            }
            result.add(trimmed);
            for (let key in implications) {
                if (implications[key].includes(trimmed)) {
                    result.add(key);
                }
            }
        }
        return Array.from(result);
    }

    function _getRawMetaContent(items) {

        //TODO: parser goes here?
        //TODO: read subitems as well as main data content

        function unencode(str) {
            //TODO: revisit this, it is kind of terrible
            return str.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/<\/div>/g, '\n').replace(/<div>/g, '\n').replace(/&nbsp;/g, '').replace(/<br>/g, '\n');
        }
        
        let lines = [];
        for (let item of items) {
            for (let sub of $model.enumerate(item)) {
                if (sub._tags != undefined && sub._tags.indexOf('@meta') != -1) {
                    let parts = unencode(sub.data).trim().split('\n');
                    for (let part of parts) {
                        let trimmed = part.trim();
                        if (trimmed == '') {
                            continue;
                        }
                        if (trimmed.startsWith(META_COMMENT_PREFIX)) {
                            continue;
                        }
                        lines.push(trimmed);
                    }
                }
            }
        }
        return lines;
    }

    function parseBasicImplications(lines) {
        //console.log(lines);
        let result = {}; //reset
        let total_cached = 0;
        let total_new = 0;
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            let imps = null;
            
            //TODO: bug, why does caching not work?
            /*
            if (_per_line_cache[line] != undefined) {
                console.log('already cached for ' + line);
                imps = _per_line_cache[line];
                total_cached++;
            }
            else {
                console.log('not cached for ' + line);
                let imps = $parseMetaTagging.getImplications(line);
                _per_line_cache[line] = imps;
                total_new++;
            }
            */

            
            imps = $parseMetaTagging.getImplications(line);
            total_new++;
            

            for (let key in imps) {
                //console.log('parseBasicImplications(): adding implications for key: ' + key);
                if (result[key] == undefined || result[key] == null) {
                    result[key] = [];
                }
                for (let imp of imps[key]) {
                    //console.log(key + ' -> ' + imp);
                    result[key].push(imp);
                }
            }
        }
        console.log('ontology cached/new = ' + total_cached + '/'+total_new);
        //enrichImplications();
        return result;
    }

    function maybeRecalculateOntology(items) {

        let timer = new Timer('parse ontology');

        let lines = _getRawMetaContent(items);
        let new_ontology = lines.join('\n');

        if (new_ontology != _ontology_cache) {
            console.log('updating ontology');
            _ontology_cache = new_ontology;
            basic_implications = parseBasicImplications(lines);
            enrichImplications();
            $model.recalculateAllTags(items);
            timer.end();
            timer.display();
            return true;
        }
        else {
            console.log('* use cached ontology');
            timer.end();
            timer.display();
            return false;
        }
    }

    return {
        maybeRecalculateOntology: maybeRecalculateOntology,
        getEnrichedTags: getEnrichedTags,
        getReverseEnrichedTags: getReverseEnrichedTags,
        getImplications: getImplications
    };
})();