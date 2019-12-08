"use strict";

let DATA_SCHEMA_VERSION = 16;

let $schema = (function() {

	function checkSchemaUpdate(items, loaded_schema_version) {

        console.log('-------------------------------');
        console.log('Loaded DATA_SCHEMA_VERSION = ' + loaded_schema_version);
        console.log('Target DATA_SCHEMA_VERSION = ' + DATA_SCHEMA_VERSION);

        if (loaded_schema_version > DATA_SCHEMA_VERSION) {
                let msg = "Schema version being loaded is ahead of software ";
                msg += "(v"+loaded_schema_version+" vs v"+DATA_SCHEMA_VERSION+").";
                msg += "Update to latest version of MetaList."
                throw msg;
        }

		let updated = false;

        if (loaded_schema_version < 13) {
                let msg = 'Detected an old schema version ('+12+') that is no longer supported.\n';
                msg += 'In order to convert to v13, it is necessary to load an earlier version of MetaList from the repo.\n';
                msg += 'Tag: OldSchemaSupport / Commit: b1ef05e9e2d834a1495fe4f32ddbd841d966a1c1';
                alert(msg);
                throw msg;
        }

        if (loaded_schema_version == 13) {
                console.log('-------------------------------');
                console.log('Update schema from 13 to 14');
                let start = Date.now();
                items = convert_v13_to_v14(items);
                let end = Date.now();
                console.log('conversion to v14 schema took '+(end-start)+'ms');
                console.log('-------------------------------');
                $model.recalculateAllTags(items);
                updated = true;
                loaded_schema_version = 14;
                console.log(items);   
        }

        if (loaded_schema_version == 14) {
                console.log('-------------------------------');
                console.log('Update schema from 14 to 15');
                let start = Date.now();
                items = convert_v14_to_v15(items);
                let end = Date.now();
                console.log('conversion to v15 schema took '+(end-start)+'ms');
                console.log('-------------------------------');
                $model.recalculateAllTags(items);
                updated = true;
                loaded_schema_version = 15;
                console.log(items);   
        }

        if (loaded_schema_version == 15) {
                console.log('-------------------------------');
                console.log('Update schema from 15 to 16');
                let start = Date.now();
                items = convert_v15_to_v16(items);
                let end = Date.now();
                console.log('conversion to v15 schema took '+(end-start)+'ms');
                console.log('-------------------------------');
                $model.recalculateAllTags(items);
                updated = true;
                loaded_schema_version = 16;
                console.log(items);   
        }

        if (updated) {
        	$persist.saveToHostFull(
                function onFnSuccess() {}, 
                function onFnFailure() {
                        alert('Failed to save');
                }
            );
        }

        return items;
	}

    function convert_v15_to_v16(items) {
        let tagname1 = '@meta';
        let tagname2 = '@implies';
        for (let item of items) {
            for (let subitem of item.subitems) {
                if (subitem.tags == undefined || subitem.tags == null) {
                    continue;
                }
                let tags = subitem.tags.trim().split(' ');
                let updated_tags = [];
                let has1 = false;
                for (let tag of tags) {
                    if (tag.trim() != '') {
                        if (tag == tagname1) {
                            has1 = true;
                            updated_tags.push(tagname2);
                        }
                        else {
                            updated_tags.push(tag);
                        }
                    }
                }
                if (has1) {
                    console.log('update ' + tags.join(' ') + ' -> ' + updated_tags.join(' '));
                    subitem.tags = updated_tags.join(' ');
                }
            }
        }
        return items;
    }

    function convert_v14_to_v15(items) {
        for (let item of items) {
            for (let subitem of item.subitems) {
                let tags = subitem.tags.split(' ');
                let updated = [];
                for (let tag of tags) {
                    if (tag == '@-') {
                        if (updated.includes('@folded') == false) {
                            updated.push('@folded');
                        }
                    }
                    else if (tag == '@+') {
                        if (updated.includes('@unfolded') == false) {
                            updated.push('@unfolded');
                        }
                    }
                    else if (tag.trim() != '') {
                        updated.push(tag.trim());
                    }
                }
                subitem.tags = updated.join(' ');
            }
        }
        return items;
    }

    function convert_v13_to_v14(items) {

        let activeItems = [];
        let totalDeleted = 0;

        for (let item of items) {
            if (item.deleted != undefined) {
                //do nothing, we want to get rid of these
                totalDeleted++;
            }
            else {
                activeItems.push(item);
            }
        }

        activeItems.sort(function (a, b) {
            if (a.priority > b.priority) return 1;
            if (a.priority < b.priority) return -1;
            return 0;
        });

        for (let i = 0; i < activeItems.length; i++) {
            if (i == 0) {
                activeItems[0].prev = null;
            }
            else {
                activeItems[i].prev = activeItems[i-1].id;  
            }

            if (i == activeItems.length-1) {
                activeItems[activeItems.length-1].next = null;
            }
            else {
                activeItems[i].next = activeItems[i+1].id; 
            }
        }

        for (let item of activeItems) {
            delete item.priority;
        }

        console.log('Removed ' + totalDeleted + ' deleted items');
        console.log('Items: ' + items.length + ' -> ' + activeItems.length);

        return activeItems;
    }

	return {
		checkSchemaUpdate: checkSchemaUpdate
	}

})();