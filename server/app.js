"use strict";

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
const fs = require('fs');
const bodyParser = require('body-parser');
const { exec } = require('child_process');

const DATA_SCHEMA_VERSION = 18;  //TODO: should read this from central location
const USE_SQLITE = true;

if (USE_SQLITE) {
	console.log('Using SQLite3');
}
else {
	console.log('Using native filesystem');
}

let save_dir_items_bundles = 'saved-items-bundles/';
let allow_exec = true;
let items_bundle_timestamp = null;

console.log('platform: ' + process.platform);

if (process.platform === 'linux' || 
	process.platform === 'darwin' || 
	process.platform === 'win32') {
	const homedir = require('os').homedir().replace(/\\/g, '/');
	save_dir_items_bundles = homedir + '/MetaList/';
}
else {
	console.warn('Unknown platform: ' + process.platform + '. Exiting.');
	return;
}
//TODO: other OS

let sqlite3 = null;
let db = null;
let filestore_path = null;

const backup_dir = save_dir_items_bundles+'backups/'
if (!fs.existsSync(save_dir_items_bundles)){
    fs.mkdirSync(save_dir_items_bundles);
    console.log('created '+save_dir_items_bundles+' directory');
}

if (USE_SQLITE) {
	sqlite3 = require('sqlite3').verbose();
	db = new sqlite3.Database(save_dir_items_bundles + 'metalist.db', (err) => {
	  if (err) {
	    console.error(err.message);
	  }
	  console.log('Connected to the sqlite3 database');
	});
	let sql = `CREATE TABLE IF NOT EXISTS items (
			       key TEXT PRIMARY KEY,
   			       value TEXT NOT NULL
			  ) WITHOUT ROWID;`;
	//TODO: error handling here
	db.run(sql, [], (err) => {
		//console.log('Initialized items table');
	});

	sql = `CREATE TABLE IF NOT EXISTS config (
			       key TEXT PRIMARY KEY,
   			       value TEXT NOT NULL
			  ) WITHOUT ROWID;`;
	//TODO: error handling here
	db.run(sql, [], (err) => {
		//console.log('Initialized config table');
		//console.log('Querying for existing bundle');
		db.all('SELECT * FROM config WHERE key=?', ['bundle'], (err, rows) => {
			if (!rows || rows.length === 0) {
				console.log(JSON.stringify(rows));
				//console.log('Creating new bundle');
				let bundle = bundleItemsNonEncrypted([]);
				let bundle_params = ['bundle', JSON.stringify(bundle)];
				db.run('INSERT INTO config (key, value) VALUES (?, ?)', bundle_params, (err, result) => {
					if (err) {
						console.log('ERROR ' + err);
					}
					console.log('Created blank unencrypted bundle');
				});
			}
			else {
				//console.log('already existing bundle detected');
			}
		});

	});

	//TODO: add blank config if not exists asdf
}
else {
	filestore_path = save_dir_items_bundles + 'MetaListFileStore';
	if (!fs.existsSync(filestore_path)) {
		console.log('creating ' + filestore_path);
		fs.mkdirSync(filestore_path);
	}
}

//TODO: figure out how to do this correctly
app.get('/', (req, res, next) => {
	let user_agent = req.headers['user-agent'];
	//console.log('user-agent: ' + user_agent);
	if (user_agent.includes('Mobile')) {
		res.sendFile(__dirname + '/mobile/');
	}
	else {
		next();
	}
});

app.use(express.static('../'));

app.use(bodyParser.json({limit: '100mb'}));

//TODO: grab from $persist
function bundleItemsNonEncrypted(items) {
    let bundle = {
        timestamp: Date.now(),
        data_schema_version: DATA_SCHEMA_VERSION,
        encryption: { encrypted: false },
        data: items
    }
    return bundle;
}

////////////////////////////////////////////////////

app.route('/items').get((req, res) => {
	if (USE_SQLITE) {
		console.log('GET /items');
		const t1 = Date.now();
		const items = [];
		db.all('SELECT * FROM items', [], (err, rows) => {
			if (err) {
				console.log('Error while loading items: ' + err);
				items_bundle = bundleItemsNonEncrypted([]);
				res.json(items_bundle);
				return;
			}

			for (const row of rows) {
				try {
					items.push(JSON.parse(row.value));
				}
				catch (e) {
					console.log('Error while parsing key ' + key +': ' + e);
				}
			}

			db.all('SELECT * FROM config WHERE key=?', ['bundle'], (err, rows) => {
				if (err) {
					console.warn("Error loading bundle");
					return;
				}
				const items_bundle = JSON.parse(rows[0].value);
				items_bundle.data = items;
				let t2 = Date.now();
				console.log('Loading '+items.length+' items + bundle took '+(t2-t1)+'ms');
				res.json(items_bundle);
			});
		});
	}
	else {
		console.log('GET /items');
		let t1 = Date.now();
		let files = fs.readdirSync(filestore_path);
		let items = [];
		let items_bundle = null;
		for (let file of files) {
			if (file === 'bundle') {
				items_bundle = JSON.parse(fs.readFileSync(filestore_path+'/bundle'));
			}
			else {
				let item = JSON.parse(fs.readFileSync(filestore_path+'/'+file));
				items.push(item);
			}
		}
		if (items_bundle != null) {
			items_bundle.data = items;
		}
		else {
			items_bundle = bundleItemsNonEncrypted(items);
		}
		let t2 = Date.now();
		console.log('Loading '+items.length+' items took '+(t2-t1)+'ms');
		res.json(items_bundle);
	}
});

app.route('/delete-everything').post((req, res) => {
	if (USE_SQLITE) {
		let t1 = Date.now();
		db.run('DELETE FROM items', [], (err, result) => {
			if (err) {
				console.warn('Could not delete items');
				res.json({"message":"Could not delete items."});
				return;
			}
			db.run('DELETE FROM config', [], () => {
				if (err) {
					console.warn('Could not delete items');
					res.json({"message":"Could not delete config."});
					return;
				}
				let t2 = Date.now();
				console.log('successfully deleted all items + config in '+(t2-t1)+' ms');
				console.log('Creating new bundle');
				let bundle = bundleItemsNonEncrypted([]);
				let bundle_params = ['bundle', JSON.stringify(bundle)];
				db.run('INSERT INTO config (key, value) VALUES (?, ?)', bundle_params, (err, result) => {
					if (err) {
						console.log('ERROR ' + err);
					}
					console.log('Created blank unencrypted bundle');
					res.json({"message":"Deleted successfully."});
				});
			});
		});
	}
	else {
		console.log('/delete-everything');
		let t1 = Date.now();
		deleteAll(filestore_path);
		let t2 = Date.now();
		console.log('>>> files all deleted in '+(t2-t1)+'ms');
		res.json({"message":"POST /delete-everything okay"});
	}
});

function deleteAll(path) {
	let files = fs.readdirSync(path);
	for (let file of files) {
		let filepath = path+'/'+file;
		console.log('\t deleting ' + filepath);
		fs.unlinkSync(filepath);
	}
}

app.route('/items-diff').post((req, res) => {

	if (USE_SQLITE) {
		let diffs = req.body;
		if (diffs.updated.length === 0 &&
			diffs.added.length === 0 &&
			diffs.deleted.length === 0) {
			console.log('No diffs to update. Skipping');
			res.json({"message":"POST /items-diff okay"});
			return;
		}

		///////////////////////////////////////////////////////
		//consistency checks (no ids shared between operation types)
		for (let id of diffs.updated) {
			if (diffs.added.includes(id)) {
				throw "inconsistent";
			}
			if (diffs.deleted.includes(id)) {
				throw "inconsistent";
			}
		}

		for (let id of diffs.added) {
			if (diffs.deleted.includes(id)) {
				throw "inconsistent";
			}
		}
		///////////////////////////////////////////////////////

		let t1 = Date.now();
		db.serialize(() => {

			db.run("BEGIN TRANSACTION");

			let total_alterations = 0;
			for (let item of diffs.updated) {
				let params = [JSON.stringify(item), item.id];
				db.run('UPDATE items SET value=? WHERE key=?;', params, (err) => {
					if (err) {
						console.warn('Error updating item ' + item.id);
					}
				});
				total_alterations += 1;
			}
			for (let item of diffs.added) {
				let params = [item.id, JSON.stringify(item)];
				db.run('INSERT INTO items (key, value) VALUES (?, ?);', params, (err) => {
					if (err) {
						console.warn('Error inserting item ' + item.id);
					}
				});
				total_alterations += 1;
			}
			for (let item of diffs.deleted) {
				let params = [item.id];
				db.run('DELETE FROM items WHERE key=?;', params, (err, result) => {
					if (err) {
						console.warn('Error deleting item ' + item.id);
					}
				});
				total_alterations += 1;
			}
			db.run("COMMIT", [], (err, result) => {
				if (err) {
					console.warn('Error while committing updates: ' + err);
				}
				let t2 = Date.now();
				let msg = 'POST /items-diff took ' + (t2-t1) + 'ms | ';
				msg += '\t'+diffs.updated.length+' updates';
				msg += '\t'+diffs.added.length+' insertions';
				msg += '\t'+diffs.deleted.length+' deletions';
				console.log(msg);
				res.json({"message":"POST /items-diff okay"});
			});
		});
	}
	else {
		let diffs = req.body;
		if (diffs.updated.length === 0 &&
			diffs.added.length === 0 &&
			diffs.deleted.length === 0) {
			console.log('No diffs to update. Skipping');
			res.json({"message":"POST /items-diff okay"});
			return;
		}

		///////////////////////////////////////////////////////
		//consistency checks (no ids shared between operation types)
		for (let id of diffs.updated) {
			if (diffs.added.includes(id)) {
				throw "inconsistent";
			}
			if (diffs.deleted.includes(id)) {
				throw "inconsistent";
			}
		}

		for (let id of diffs.added) {
			if (diffs.deleted.includes(id)) {
				throw "inconsistent";
			}
		}
		///////////////////////////////////////////////////////

		let t1 = Date.now();
		let total_alterations = 0;
		for (let item of diffs.updated) {
			fs.writeFileSync(filestore_path+'/'+item.id, JSON.stringify(item));
			total_alterations += 1;
		}
		for (let item of diffs.added) {
			fs.writeFileSync(filestore_path+'/'+item.id, JSON.stringify(item));
			total_alterations += 1;
		}
		for (let item of diffs.deleted) {
			fs.unlinkSync(filestore_path+'/'+item.id);
			total_alterations += 1;
		}
		let t2 = Date.now();
		let msg = 'POST /items-diff took ' + (t2-t1) + 'ms | ';
		msg += '\t'+diffs.updated.length+' updates';
		msg += '\t'+diffs.added.length+' insertions';
		msg += '\t'+diffs.deleted.length+' deletions';
		console.log(msg);
		res.json({"message":"POST /items-diff okay"});
	}

});


app.route('/items').post((req, res) => {

	if (USE_SQLITE) {
		console.log('----------------------------');
		console.log('POST /items');
		let items_bundle = req.body;
		let items = items_bundle.data;
		delete items_bundle.data;
		console.log('\ttotal items: ' + items.length);
		let t1 = Date.now();
		db.run('DELETE FROM items', [], (err, result) => {
			if (err) {
				console.log('cannot delete entry or none exists');
			}
			let t2 = Date.now();

			//TODO delete config asdf

			console.log('successfully deleted all entries in '+(t2-t1)+' ms');
			db.serialize(() => {
				db.run("BEGIN TRANSACTION");
				console.log('About to add ' + items.length + ' items');
				for (let item of items) {
					let params = [item.id, JSON.stringify(item)]
					db.run('INSERT INTO items (key, value) VALUES (?, ?)', params, (err, result) => {
						if (err) {
							console.log('ERROR ' + err);
						}
						//console.log('INSERTED ' + item.id);
					});
				}

				db.run('DELETE FROM config WHERE key=?', ['bundle'], (err, result) => {
					if (err) {
						console.log('ERROR ' + err);
					}
					//console.log('DELETED bundle');
				});

				let bundle_params = ['bundle', JSON.stringify(items_bundle)]
				db.run('INSERT INTO config (key, value) VALUES (?, ?)', bundle_params, (err, result) => {
					if (err) {
						console.log('ERROR ' + err);
					}
					//console.log('INSERTED bundle');
				});
				db.run("COMMIT", [], (err, result) => {
					let t2 = Date.now();
					console.log('successful commit. '+(t2-t1)+' ms');
					res.json({"message":"POST /items okay"});
				});
			});
		});
	}
	else {
		console.log('----------------------------');
		console.log('POST /items');
		let items_bundle = req.body;
		let items = items_bundle.data;
		console.log('\ttotal items: ' + items.length);
		let t1 = Date.now();
		deleteAll(filestore_path);
		for (let item of items) {
			fs.writeFileSync(filestore_path+'/'+item.id, JSON.stringify(item));
		}
		delete items_bundle.data;
		fs.writeFileSync(filestore_path+'/bundle', JSON.stringify(items_bundle));
		let t2 = Date.now();
		console.log('>>> files all written in '+(t2-t1)+'ms');
		res.json({"message":"POST /items okay"});
	}
});

app.route('/shell').post((req, res) => {
	if (allow_exec === false) {
		res.json({"message":"nice try."});
		return;
	}
	console.log(req.body);
	console.log(req.body.command);
	let command = req.body.command;
	command = command.replace(/\n\n/g, '\n').replace(/\n/g, '; ');
	command = command.replace(/"/g, '\\"');

	if (process.platform === 'linux') {
		command = `gnome-terminal -- bash -c "${command}; echo [press enter to exit]; read"`;
	}
	else if (process.platform === 'darwin') {
		let script_path = '~/MetaList/darwin.command';
		command = `echo "${command}; echo [press enter to exit]; read" > ${script_path}; chmod +x ${script_path}; open ${script_path}`;
	}
	else if (process.platform === 'win32') {
		//TODO
		console.log('@shell for win32 TODO...');
	}
	else {
		console.log('Unknown OS ' + process.platform);
		return;
	}
	console.log('------------------------');
	console.log(command);
	console.log('------------------------');
	exec(command, (err, stdout, stderr) => {
	  if (err) {
	    console.log(`err: ${err}`);
	    return;
	  }
	});
	res.json({"message": command});
});


app.route('/open-file').post((req, res) => {
	if (allow_exec === false) {
		res.json({"message":"nice try."});
		return;
	}
	console.log(req.body);
	console.log(req.body.filePath);
	let command = req.body.filePath;
	command = command.replace(/\n\n/g, '\n').replace(/\n/g, '; ');
	command = command.replace(/"/g, '\\"');

	//TODO: handle spaces in file names!

	if (process.platform === 'linux') {
		command = `xdg-open ${command}`;
	}
	else if (process.platform === 'darwin') {
		command = `open ${command}`;
	}
	else if (process.platform === 'win32') {
		//TODO
		console.log('open file on win32 TODO...');
	}
	else {
		console.log('Unknown OS ' + process.platform);
		return;
	}
	console.log('------------------------');
	console.log(command);
	console.log('------------------------');
	exec(command, (err, stdout, stderr) => {
	  if (err) {
	    console.log(`err: ${err}`);
	    return;
	  }
	});
	res.json({"message": command});
});
	
////////////////////////////////////////////////////

const server = app.listen(port, () => {
	console.log(`Listening on port ${port}`);
})

process.on('SIGINT', () => {
	if (db !== null) {
		console.log('closing database connection');
		db.close();
	}
    server.close();
});