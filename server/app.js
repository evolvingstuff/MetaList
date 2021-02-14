"use strict";

//console.log('__filename = ' + __filename)
//console.log('__dirname =  ' + __dirname)

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
const fs = require('fs');
const url = require('url');
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const DATA_SCHEMA_VERSION = 18;  //TODO: should read this from central location
const VERBOSE_UPDATES = true;
let save_dir_items_bundles = null;
let allow_exec = true;
let items_bundle_timestamp = null;
let db = null;
let filestore_path = null;

let token = -1;


function updateToken() {
	token = Math.floor(Math.random() * 100000000000);
	console.log('new token = ' + token);
}


function initialize() {
	console.log('---------------------------------');
	console.log('METALIST');

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

	fs.mkdirSync(save_dir_items_bundles, { recursive: true });

	db = new sqlite3.Database(save_dir_items_bundles + 'metalist.db', (err) => {
	  if (err) {
	    console.error(err.message);
	    return;
	  }
	});
	let sql = `CREATE TABLE IF NOT EXISTS items (
			       key INTEGER PRIMARY KEY,
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
		db.all('SELECT * FROM config WHERE key=?', ['bundle'], (err, rows) => {
			if (!rows || rows.length === 0) {
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
	updateToken();
}


//TODO: figure out how to do this correctly
app.get('/', (req, res, next) => {
	// let user_agent = req.headers['user-agent'];
	// if (user_agent.includes('Mobile')) {
	// 	res.sendFile(__dirname + '/mobile/');
	// }
	// else {
	// 	next();
	// }
	next();
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


app.route('/items').get((req, res) => {
	console.log(formatDateTime() + ' GET /items');
	
	const t1 = Date.now();
	const items = [];
	db.all('SELECT * FROM items', [], (err, rows) => {
		if (err) {
			console.log('Error while loading items: ' + err);
			items_bundle = bundleItemsNonEncrypted([]);
			//TODO
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
			console.log('\tloading '+items.length+' items took '+(t2-t1)+'ms');
			updateToken();
			res.json({'bundle': items_bundle, 'token': token});
		});
	});
});


app.route('/delete-everything').post((req, res) => {
	console.log(formatDateTime() + ' POST /delete-everything');

	if (req.body.token != token) {
		throw "Invalid token";
	}
	else {
		console.log('valid token');
	}

	let t1 = Date.now();
	//TODO: add transaction
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
				updateToken();
				res.json({"message":"Deleted successfully.", "token": token});
			});
		});
	});
});


app.route('/items-diff').post((req, res) => {

	if (req.body.token != token) {
		throw "Invalid token";
	}
	else {
		console.log('valid token');
	}

	let diffs = req.body.data;
	if (diffs.updated.length === 0 &&
		diffs.added.length === 0 &&
		diffs.deleted.length === 0) {
		console.log('No diffs to update. Skipping');
		res.json({"message":"POST /items-diff okay", "token": token});
		return;
	}

	///////////////////////////////////////////////////////
	//consistency checks (no ids shared between operation types)
	for (const id of diffs.updated) {
		if (diffs.added.includes(id)) {
			throw "inconsistent";
		}
		if (diffs.deleted.includes(id)) {
			throw "inconsistent";
		}
	}
	for (const id of diffs.added) {
		if (diffs.deleted.includes(id)) {
			throw "inconsistent";
		}
	}
	///////////////////////////////////////////////////////

	const t1 = Date.now();
	db.serialize(() => {

		let msg2 = '';

		try {

			db.run("BEGIN TRANSACTION");

			let total_alterations = 0;
			for (const item of diffs.updated) {
				const params = [JSON.stringify(item), item.id];
				db.run('UPDATE items SET value=? WHERE key=?;', params, (err) => {
					if (err) {
						throw err;
					}
				});
				total_alterations += 1;
				if (VERBOSE_UPDATES) {
					try {
						msg2 += `\tUPDATE [${item.id}]: ${item.subitems[0].data.substring(0, 50)}...\n`;
					}
					catch (e) {
						//encrypted, do not show data in console
					}
				}
			}

			for (const item of diffs.added) {
				const params = [item.id, JSON.stringify(item)];
				db.run('INSERT INTO items (key, value) VALUES (?, ?);', params, (err) => {
					if (err) {
						throw err;
					}
				});
				total_alterations += 1;
				if (VERBOSE_UPDATES) {
					try {
						msg2 += `\tINSERT [${item.id}]: ${item.subitems[0].data.substring(0, 50)}...\n`;
					}
					catch (e) {}
				}
			}

			for (const item of diffs.deleted) {
				const params = [item.id];
				db.run('DELETE FROM items WHERE key=?;', params, (err, result) => {
					if (err) {
						throw err;
					}
				});
				total_alterations += 1;
				if (VERBOSE_UPDATES) {
					try {
						msg2 += `\tDELETE [${item.id}]: ${item.subitems[0].data.substring(0, 50)}...\n`;
					}
					catch (e) {}
				}
			}

			db.run("COMMIT", [], (err, result) => {
				if (err) {
					throw err;
				}
				const t2 = Date.now();
				let msg = formatDateTime() + ' ' + (t2-t1) + 'ms |';
				if (diffs.updated.length > 0) {
					msg += '  '+diffs.updated.length+' updates';
				}
				if (diffs.added.length > 0) {
					msg += '  '+diffs.added.length+' insertions';
				}
				if (diffs.deleted.length > 0) {
					msg += '  '+diffs.deleted.length+' deletions';
				}
				console.log(msg);
				if (VERBOSE_UPDATES && msg2 !== '') {
					console.log(msg2);
				}
				updateToken();
				res.json({"message":"POST /items-diff okay", "token": token});
			});
		}
		catch (e) {
			db.run('ROLLBACK', [], (err, result) => {
				console.log(`ERROR: ${e}`);
				console.log('Rolled back transaction');
				res.status(500).send(e);
			});
		}
	});
});


app.route('/items').post((req, res) => {
	console.log('----------------------------');
	console.log(formatDateTime() + ' POST /items');

	if (req.body.token != token) {
		throw "Invalid token";
	}
	else {
		console.log('valid token');
	}

	let items_bundle = req.body.data;
	let items = items_bundle.data;
	delete items_bundle.data;
	
	db.serialize(() => {
		try {
			db.run("BEGIN TRANSACTION");

			let t1 = Date.now();
			db.run('DELETE FROM items', [], (err, result) => {
				if (err) {
					throw err;
				}
				let t2 = Date.now();
				console.log('successfully deleted all entries in '+(t2-t1)+' ms');
			});

			console.log('About to add ' + items.length + ' items');
			for (let item of items) {
				let params = [item.id, JSON.stringify(item)]
				db.run('INSERT INTO items (key, value) VALUES (?, ?)', params, (err, result) => {
					if (err) {
						throw err;
					}
				});
			}

			db.run('DELETE FROM config WHERE key=?', ['bundle'], (err, result) => {
				if (err) {
					throw err;
				}
			});

			let bundle_params = ['bundle', JSON.stringify(items_bundle)]
			db.run('INSERT INTO config (key, value) VALUES (?, ?)', bundle_params, (err, result) => {
				if (err) {
					throw err;
				}
			});

			db.run("COMMIT", [], (err, result) => {
				if (err) {
					throw err;
				}
				let t2 = Date.now();
				console.log('successful commit. '+(t2-t1)+' ms');
				updateToken();
				res.json({"message":"POST /items okay", "token": token});
			});
		}
		catch (e) {
			db.run('ROLLBACK', [], (err, result) => {
				console.log(`ERROR: ${e}`);
				console.log('Rolled back transaction');
				res.status(500).send(e);
			});
		}
	});
});


app.route('/image').get((req, res) => {

	// Example
	// http://localhost:3000/image?path=/home/thomas/Desktop/random-forest.png

	let query = url.parse(req.url,true).query;
    let path = query.path;
    console.log(path);
	//read the image using fs and send the image content back in the response
	fs.readFile(path, function (err, content) {
		if (err) {
			res.writeHead(400, {'Content-type':'text/html'})
			console.log(err);
			res.end("No such image");
		} else {
			//specify the content type in the response will be an image
			let parts = path.split('.');
			let ext = parts[parts.length-1];
			console.log('sending image ' + path);
			res.writeHead(200,{'Content-type':'image/'+ext});
			res.end(content);
		}
	});
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


function formatDateTime() {
	let now = new Date();
	let year = now.getFullYear();
	let month = (now.getMonth()+1).toString().padStart(2, "0");
	let day = now.getDate().toString().padStart(2, "0");
	let hour = now.getHours().toString().padStart(2, "0");
	let minute = now.getMinutes().toString().padStart(2, "0");
	let second = now.getSeconds().toString().padStart(2, "0");
	let result = year+'-'+month+'-'+day+' '+hour+':'+minute+':'+second;
	return result;
}

	
const server = app.listen(port, () => {
	console.log(`listening on port ${port}`);
})


process.on('SIGINT', () => {
	if (db !== null) {
		console.log('closing database connection');
		db.close();
	}
    server.close();
});


initialize();