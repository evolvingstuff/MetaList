let DATA_SCHEMA_VERSION = 14;

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

                if (updated) {
                	$persist.save(
                                function onFnSuccess() {}, 
                                function onFnFailure() {
                                        alert('Failed to save');
                                });
                }

                return items;
	}

        function convert_v13_to_v14(items) {
                items.sort(function (a, b) {
                    if (a.priority > b.priority) return 1;
                    if (a.priority < b.priority) return -1;
                    return 0;
                });
                let id = 0;
                for (let i = 0; i < items.length; i++) {
                        if (i == 0) {
                                items[0].prev = null;
                        }
                        else {
                                items[i].prev = items[i-1].id;  
                        }
                        if (i == items.length-1) {
                                items[items.length-1].next = null;
                        }
                        else {
                                items[i].next = items[i+1].id; 
                        }
                }
                for (let item of items) {
                        delete item.priority;
                }
                return items;
        }

	return {
		checkSchemaUpdate: checkSchemaUpdate
	}

})();