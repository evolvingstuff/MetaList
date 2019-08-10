let DATA_SCHEMA_VERSION = 13;

let $schema = (function() {

	function checkSchemaUpdate(items_, loaded_schema_version) {

                console.log('-------------------------------');
                console.log('Loaded DATA_SCHEMA_VERSION = ' + loaded_schema_version);
                console.log('Target DATA_SCHEMA_VERSION = ' + DATA_SCHEMA_VERSION);

                if (loaded_schema_version > DATA_SCHEMA_VERSION) {
                        let msg = "Schema version being loaded is ahead of software ";
                        msg += "(v"+loaded_schema_version+" vs v"+DATA_SCHEMA_VERSION+").";
                        msg += "Update to latest version of MetaList."
                        throw msg;
                }

		let items = items_;
		let updated = false;

                if (loaded_schema_version < 13) {

                        let msg = 'Detected an old schema version ('+12+') that is no longer supported.\n';
                        msg += 'In order to convert to v13, it is necessary to load an earlier version of MetaList from the repo.\n';
                        msg += 'Tag: OldSchemaSupport / Commit: b1ef05e9e2d834a1495fe4f32ddbd841d966a1c1';

                        alert(msg);

                        throw msg;

                        /*
                        console.log('-------------------------------');
                        console.log('Update schema from 12 to 13');
                        let start = Date.now();
                        //items = convert_v12_to_v13(items);
                        let end = Date.now();
                        console.log('conversion to v13 schema took '+(end-start)+'ms');
                        localStorage.setItem('DATA_SCHEMA_VERSION', 13+'');
                        console.log('-------------------------------');
                        $model.recalculateAllTags(items);
                        updated = true;
                        loaded_schema_version = 13;
                        console.log(items);
                        */
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

	return {
		checkSchemaUpdate: checkSchemaUpdate
	}

})();