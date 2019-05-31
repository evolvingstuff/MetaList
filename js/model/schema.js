let DATA_SCHEMA_VERSION = 13;

let $schema = (function() {

	function checkSchemaUpdate(items_, loaded_schema_version) {
                if (loaded_schema_version > DATA_SCHEMA_VERSION) {
                        let msg = "Schema version being loaded is ahead of software ";
                        msg += "(v"+loaded_schema_version+" vs v"+DATA_SCHEMA_VERSION+").";
                        msg += "Update to latest version of MetaList."
                        throw msg;
                }
                console.log('-------------------------------');
                console.log('Loaded DATA_SCHEMA_VERSION = ' + loaded_schema_version);
                console.log('Target DATA_SCHEMA_VERSION = ' + DATA_SCHEMA_VERSION);
                // console.log('ITEMS before possible schema update:');
                // console.log(items_);
		let items = items_;
		let updated = false;
                if (loaded_schema_version == 0 || loaded_schema_version == 1) {
                	console.log('-------------------------------');
                	console.log('Update schema from 0/1 to 2');
                	let converted_items = [];
                	let start = Date.now();
                	for (let item of items) {
                		converted_items.push(convert_v1_to_v2(item));
                	}
                	let end = Date.now();
                	console.log('conversion to v2 schema took '+(end-start)+'ms');
                	localStorage.setItem('DATA_SCHEMA_VERSION', 2+'');
                	console.log('-------------------------------');
                	items = converted_items;
                	$model.recalculateAllTags(converted_items);
                	updated = true;
                        loaded_schema_version = 2;
                }
                
                if (loaded_schema_version == 2) {
                	console.log('-------------------------------');
                	console.log('Update schema from 2 to 3');
                	let converted_items = [];
                	let start = Date.now();
                	for (let item of items) {
                		converted_items.push(convert_v2_to_v3(item));
                	}
                	let end = Date.now();
                	console.log('conversion to v3 schema took '+(end-start)+'ms');
                	localStorage.setItem('DATA_SCHEMA_VERSION', 3+'');
                	console.log('-------------------------------');
                	items = converted_items;
                	$model.recalculateAllTags(converted_items);
                	updated = true;
                        loaded_schema_version = 3;
                }

                if (loaded_schema_version == 3) {
                	console.log('-------------------------------');
                	console.log('Update schema from 3 to 4');
                	let converted_items = [];
                	let start = Date.now();
                	for (let item of items) {
                		converted_items.push(convert_v3_to_v4(item));
                	}
                	let end = Date.now();
                	console.log('conversion to v4 schema took '+(end-start)+'ms');
                	localStorage.setItem('DATA_SCHEMA_VERSION', 4+'');
                	console.log('-------------------------------');
                	items = converted_items;
                	$model.recalculateAllTags(converted_items);
                	updated = true;
                        loaded_schema_version = 4;
                }

                if (loaded_schema_version == 4) {
                	console.log('-------------------------------');
                	console.log('Update schema from 4 to 5');
                	let converted_items = [];
                	let start = Date.now();
                	for (let item of items) {
                                converted_items.push(convert_v4_to_v5(item));
                	}
                	let end = Date.now();
                	console.log('conversion to v5 schema took '+(end-start)+'ms');
                	localStorage.setItem('DATA_SCHEMA_VERSION', 5+'');
                	console.log('-------------------------------');
                	items = converted_items;
                	$model.recalculateAllTags(converted_items);
                	updated = true;
                        loaded_schema_version = 5;
                }

                if (loaded_schema_version == 5) {
                	console.log('-------------------------------');
                	console.log('Update schema from 5 to 6');
                	let converted_items = [];
                	let start = Date.now();
                	for (let item of items) {
                		converted_items.push(convert_v5_to_v6(item));
                	}
                	let end = Date.now();
                	console.log('conversion to v6 schema took '+(end-start)+'ms');
                	localStorage.setItem('DATA_SCHEMA_VERSION', 6+'');
                	console.log('-------------------------------');
                	items = converted_items;
                	$model.recalculateAllTags(converted_items);
                	updated = true;
                        loaded_schema_version = 6
                }

                if (loaded_schema_version == 6) {
                	console.log('-------------------------------');
                	console.log('Update schema from 6 to 7');
                	let converted_items = [];
                	let start = Date.now();
                	for (let item of items) {
                		converted_items.push(convert_v6_to_v7(item));
                	}
                	let end = Date.now();
                	console.log('conversion to v7 schema took '+(end-start)+'ms');
                	localStorage.setItem('DATA_SCHEMA_VERSION', 7+'');
                	console.log('-------------------------------');
                	items = converted_items;
                	$model.recalculateAllTags(converted_items);
                	updated = true;
                        loaded_schema_version = 7;
                }

                if (loaded_schema_version == 7) {
                        console.log('-------------------------------');
                        console.log('Update schema from 7 to 8');
                        let converted_items = [];
                        let start = Date.now();
                        for (let item of items) {
                                converted_items.push(convert_v7_to_v8(item));
                        }
                        let end = Date.now();
                        console.log('conversion to v8 schema took '+(end-start)+'ms');
                        localStorage.setItem('DATA_SCHEMA_VERSION', 8+'');
                        console.log('-------------------------------');
                        items = converted_items;
                        $model.recalculateAllTags(converted_items);
                        updated = true;
                        loaded_schema_version = 8;
                }

                if (loaded_schema_version == 8) {
                        console.log('-------------------------------');
                        console.log('Update schema from 8 to 9');
                        let converted_items = [];
                        let start = Date.now();
                        for (let item of items) {
                                converted_items.push(convert_v8_to_v9(item));
                        }
                        let end = Date.now();
                        console.log('conversion to v9 schema took '+(end-start)+'ms');
                        localStorage.setItem('DATA_SCHEMA_VERSION', 9+'');
                        console.log('-------------------------------');
                        items = converted_items;
                        $model.recalculateAllTags(converted_items);
                        updated = true;
                        loaded_schema_version = 9;
                }

                if (loaded_schema_version == 9) {
                        console.log('-------------------------------');
                        console.log('Update schema from 9 to 10');
                        let converted_items = [];
                        let start = Date.now();
                        for (let item of items) {
                                converted_items.push(convert_v9_to_v10(item));
                        }
                        let end = Date.now();
                        console.log('conversion to v10 schema took '+(end-start)+'ms');
                        localStorage.setItem('DATA_SCHEMA_VERSION', 10+'');
                        console.log('-------------------------------');
                        items = converted_items;
                        $model.recalculateAllTags(converted_items);
                        updated = true;
                        loaded_schema_version = 10;
                        console.log(items);
                }

                if (loaded_schema_version == 10) {
                        console.log('-------------------------------');
                        console.log('Update schema from 10 to 11');
                        let converted_items = [];
                        let start = Date.now();
                        for (let item of items) {
                                converted_items.push(convert_v10_to_v11(item));
                        }
                        let end = Date.now();
                        console.log('conversion to v11 schema took '+(end-start)+'ms');
                        localStorage.setItem('DATA_SCHEMA_VERSION', 11+'');
                        console.log('-------------------------------');
                        items = converted_items;
                        $model.recalculateAllTags(converted_items);
                        updated = true;
                        loaded_schema_version = 11;
                        console.log(items);
                }

                if (loaded_schema_version == 11) {
                        console.log('-------------------------------');
                        console.log('Update schema from 11 to 12');
                        let start = Date.now();
                        items = convert_v11_to_v12(items);
                        let end = Date.now();
                        console.log('conversion to v12 schema took '+(end-start)+'ms');
                        localStorage.setItem('DATA_SCHEMA_VERSION', 12+'');
                        console.log('-------------------------------');
                        $model.recalculateAllTags(items);
                        updated = true;
                        loaded_schema_version = 12;
                        console.log(items);
                }

                if (loaded_schema_version == 12) {
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
                }

                if (updated) {
                	$persist.save(items, 
                                function onFnSuccess() {}, 
                                function onFnFailure() {
                                        alert('Failed to save');
                                });
                }

                return items;
	}

        /*
        function convert_v12_to_v13(items) {
                //Do anything?
        }
        */

        function convert_v11_to_v12(items) {
                let result = [];
                for (let item of items) {
                        if (item.deleted != undefined) {
                                console.log('removing deleted item ' + item.id);
                                continue;
                        }
                        result.push(item);
                }
                return result;
        }

        function convert_v10_to_v11(item) {
                if (item.last_sort != undefined) {
                        delete item.last_sort;
                }
                return item;
        }

        function convert_v9_to_v10(item) {
                if (item.timestamp != undefined) {
                        item.creation = item.timestamp;
                }
                return item;
        }

        function convert_v8_to_v9(item) {
                if (item['last'] != undefined) {
                        let last = item['last'];
                        delete item['last'];
                        item['last_edit'] = last;
                        item['last_sort'] = last;
                }
                return item;
        }

        function convert_v7_to_v8(item) {
                if (item['timestamp'] != undefined) {
                        item['last'] = item['timestamp'];
                }
                return item;
        }

	function convert_v6_to_v7(item) {
                if (item['collapse'] == undefined) {
		      item['collapse'] = 0;
                }
		return item;
	}

	function convert_v5_to_v6(item) {
                if (item.data != undefined) {
		      delete item.data;
                }
		return item;
	}

	function convert_v4_to_v5(item) {
		for (let subitem of item.subitems) {
                        if (subitem._include != undefined) {
			     delete subitem._include;
                        }
		}
		return item;
	}

	function convert_v3_to_v4(item) {
                if (item.data != undefined) {
		      delete item.data;
                }
		return item;
	}

	function convert_v2_to_v3(item) {
                if (item.subitems != undefined) {
        		for (let subitem of item.subitems) {
                                if (subitem.subitems != undefined) {
        			     delete subitem.subitems;
                                }
        		}
                }
		return item;
	}

	function convert_v1_to_v2(item) {

		if (item.data == undefined) {
			console.log('WARNING: item ' + item.id + ' may already be in v2 format. Skipping');
			return item;
		}

		let item2 = copyJSON(item);

		delete item2.data;
		delete item2.tags;
		delete item2._tags;
		delete item2._include;
		item2.subitems = [];
		let v2_main_subitem = {
			'data': item.data + '',
			'tags': item.tags + '',
			'indent': 0,
		};
		item2.subitems.push(v2_main_subitem);
		function _nest(item, indent) {
			if (item.subitems != undefined) {
				for (let subitem of item.subitems) {
					let v2_subitem = {
						'data': subitem.data + '',
						'tags': subitem.tags + '',
						'indent': indent
					}
					item2.subitems.push(v2_subitem);
					if (subitem.subitems != undefined) {
						_nest(subitem, indent+1);
					}
				}
			}
		}
		_nest(item, 1);
		return item2;
	}

	return {
		checkSchemaUpdate: checkSchemaUpdate
	}

})();