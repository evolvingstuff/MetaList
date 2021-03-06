"use strict";

let $ontology = (function () {

    let basicImplications = {};
    let implications = {};
    let _ontologyCache = '';

    function getImplications() {
        return implications;
    }

    function getBasicImplications() {
        return basicImplications;
    }

    function enrichImplications() {
        implications = copyJSON(basicImplications); //copy basic implications
        //extend basic implications repeatedly until no new additions
        let t1 = Date.now();
        let modified = true;
        while (modified) {
            modified = false;
            let keys = Object.keys(implications);
            //TODO asdf meta
            for (let i = 0; i < keys.length; i++) {
                let key = keys[i];
                let setImps = new Set(implications[key]);
                for (let j = 0; j < implications[key].length; j++) {
                    let imp = implications[key][j];
                    if (basicImplications[imp]) {
                        let imps2 = basicImplications[imp];
                        for (let k = 0; k < imps2.length; k++) {
                            if (setImps.has(imps2[k]) === false) {
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
        let t2 = Date.now();
    }

    function getEnrichedTags(rawTags) {
        let tags = null;
        if (Array.isArray(rawTags)) {
            tags = rawTags;
        }
        else {
            tags = rawTags.split(' ');
        }
        let result = new Set();
        for (let i = 0; i < tags.length; i++) {
            let trimmed = tags[i].trim();
            if (trimmed === '') {
                continue;
            }
            result.add(trimmed);
            if (implications[trimmed] !== undefined && implications[trimmed] !== null) {
                for (let j = 0; j < implications[trimmed].length; j++) {
                    result.add(implications[trimmed][j]);
                }
            }
        }
        return Array.from(result);
    }

    //NOTE: this is used for negative search terms, where we want to remove the 
    //reverse of the implications
    function getReverseEnrichedTags(rawTags) {
        let tags = null;
        if (Array.isArray(rawTags)) {
            tags = rawTags;
        }
        else {
            tags = rawTags.split(' ');
        }
        let result = new Set();
        for (let i = 0; i < tags.length; i++) {
            let trimmed = tags[i].trim();
            if (trimmed === '') {
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

    function _getRawMetaContent() {
        //TODO: this should be cached and updated with pub/sub
        //TODO: parser goes here?
        //TODO: read subitems as well as main data content
        function unencode(str) {
            //TODO: revisit this, it is kind of terrible
            return str.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/<\/div>/g, '\n').replace(/<div>/g, '\n').replace(/&nbsp;/g, '').replace(/<br>/g, '\n');
        }
        let lines = [];
        const items = $model.getUnsortedItems();
        for (let item of items) {
            for (let sub of item.subitems) {
                if (sub._tags !== undefined && sub._tags.includes(META_IMPLIES)) {
                    let parts = unencode(sub.data).trim().split('\n');
                    for (let part of parts) {
                        let trimmed = part.trim();
                        if (trimmed === '') {
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
        let result = {}; //reset
        let totalNew = 0;
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            let imps = null;

            imps = $parseMetaTagging.getImplications(line);
            totalNew++;

            for (let key in imps) {
                if (result[key] === undefined || result[key] === null) {
                    result[key] = [];
                }
                for (let imp of imps[key]) {
                    result[key].push(imp);
                }
            }
        }
        return result;
    }

    function maybeRecalculateOntology() {
        let lines = _getRawMetaContent();
        let newOntology = lines.join('\n');
        if (newOntology !== _ontologyCache) {
            _ontologyCache = newOntology;  //TODO: could do a hash of this
            basicImplications = parseBasicImplications(lines);
            enrichImplications();
            $model.recalculateAllTags();
            return true;
        }
        else {
            return false;
        }
    }

    return {
        maybeRecalculateOntology: maybeRecalculateOntology,
        getEnrichedTags: getEnrichedTags,
        getReverseEnrichedTags: getReverseEnrichedTags,
        getImplications: getImplications,
        getBasicImplications: getBasicImplications
    };
})();