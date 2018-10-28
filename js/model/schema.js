let DATA_SCHEMA_VERSION = 6;

let $schema = (function() {

	function checkSchemaUpdate(items_, loaded_schema_version) {
		console.log('Target DATA_SCHEMA_VERSION = ' + loaded_schema_version);
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
        }

        if (updated) {
        	$persist.save(items);
        }

        return items;
	}

	function convert_v5_to_v6(item) {
		delete item.data;
		return item;
	}

	function convert_v4_to_v5(item) {
		for (let subitem of item.subitems) {
			delete subitem._include;
		}
		return item;
	}

	function convert_v3_to_v4(item) {
		delete item.data;
		return item;
	}

	function convert_v2_to_v3(item) {
		for (let subitem of item.subitems) {
			delete subitem.subitems;
		}
		return item;
	}

	function convert_v1_to_v2(item) {

		if (item.data == undefined) {
			console.log('WARNING: item ' + item.id + ' may already be in v2 format. Skipping');
			return item;
		}

		let item2 = JSON.parse(JSON.stringify(item));

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