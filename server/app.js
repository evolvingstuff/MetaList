"use strict";

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
const fs = require('fs');
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();


let save_dir_items_bundles = 'saved-items-bundles/';
let backup_dir = save_dir_items_bundles+'backups/'
let allow_exec = true;
let items_bundle_timestamp = null;

console.log('platform: ' + process.platform);

if (process.platform == 'linux' || process.platform == 'darwin') {
	const homedir = require('os').homedir();
	save_dir_items_bundles = homedir + '/MetaList/';
}
//TODO: other OS

if (!fs.existsSync(save_dir_items_bundles)){
    fs.mkdirSync(save_dir_items_bundles);
    console.log('created '+save_dir_items_bundles+' directory');
}

const db_path = save_dir_items_bundles + 'MetaList.db';

let db = new sqlite3.Database(db_path);
db.run('CREATE TABLE IF NOT EXISTS bundle (value TEXT)');
db.run('CREATE TABLE IF NOT EXISTS item (id INTEGER PRIMARY KEY, value TEXT)');
db.close();


//TODO: figure out how to do this correctly
app.get('/', (req, res, next) => {
	let user_agent = req.headers['user-agent'];
	console.log('user-agent: ' + user_agent);
	if (user_agent.includes('Mobile')) {
		res.sendFile(__dirname + '/mobile/');
	}
	else {
		next();
	}
});

app.use(express.static('../'));

app.use(bodyParser.json({limit: '100mb'}));

let DATA_SCHEMA_VERSION = 16;  //TODO: should read this from central location

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

app.route('/items_bundle_timestamp').get((req, res) => {
	res.json({"items_bundle_timestamp": items_bundle_timestamp});
});

app.route('/items').get((req, res) => {
	console.log('GET /items');
	let t1 = Date.now();

	let db = new sqlite3.Database(db_path, (err) => {
		if (err) {
			return console.error(err.message);
		}
		console.log('connected to db');
	});

	let after = function(bundle, items) {
		if (bundle == undefined) {
			console.log('Fresh database');
			let items = [];
		    let items_bundle = bundleItemsNonEncrypted(items);
		    console.log('\titems bundle loaded and parsed (from file)');
		    db.serialize(() => {
		    	db.run("INSERT INTO bundle (value) VALUES ('"+JSON.stringify(items_bundle)+"');");
		    	console.log('\titems bundle added to db');
		    	db.close((err) => {
					if (err) {
						return console.error(err.message);
					}
					console.log('Close the database connection.');
					res.json(items_bundle); //TODO: surround with other data
				});
		    });
		}
		else {
			console.log('-------------------------------------');
			let items_bundle = JSON.parse(bundle.value);
			items_bundle.data = [];
			for (let item of items) {
				items_bundle.data.push(JSON.parse(item.value));
			}
			let t2 = Date.now();
			console.log('returning '+items_bundle.data.length+' items in '+(t2-t1)+'ms');
			db.close((err) => {
				if (err) {
					return console.error(err.message);
				}
				console.log('Close the database connection.');
				res.json(items_bundle); //TODO: surround with other data
			});
		}
	}

	db.serialize(() => {
		let bundle = null;
		db.get("SELECT * FROM bundle LIMIT 1;", [], (err, row) => {
			bundle = row;
		});
		db.all("SELECT * FROM item;", [], (err, items) => {
			after(bundle, items);
		});
	});
});

//TODO: move this
function sqlEsc(text) {
	return text.replace(/\'/g,"''");
}

app.route('/delete-everything').post((req, res) => {
	console.log('/delete-everything');
	let db = new sqlite3.Database(db_path, (err) => {
		if (err) {
			return console.error(err.message);
		}
		console.log('connected to db');
		console.log('');
		db.serialize(() => {
			db.run('DELETE FROM item;');
			db.run('DELETE FROM bundle;');
			db.close((err) => {
				if (err) {
					return console.error(err.message);
				}
				console.log('disconnected from db');
				res.json({"message":"POST /delete-everything okay"});
			});
		});
	});
});

app.route('/items-diff').post((req, res) => {
	console.log('POST /items-diff');
	let diffs = req.body;
	let sqls = [];
	for (let item of diffs.updated) {
		let id = parseInt(item.id);
		sqls.push("UPDATE item SET value='"+sqlEsc(JSON.stringify(item))+"' WHERE id="+id+";");
	}
	for (let item of diffs.added) {
		let id = parseInt(item.id);
		sqls.push("INSERT INTO item (id,value) VALUES ("+id+", '"+sqlEsc(JSON.stringify(item))+"');");
	}
	for (let item of diffs.deleted) {
		let id = parseInt(item.id);
		sqls.push("DELETE FROM item WHERE id="+id+";");
	}
	let db = new sqlite3.Database(db_path, (err) => {
		if (err) {
			return console.error(err.message);
		}
		console.log('connected to db');
		console.log('');
		db.serialize(() => {
			for (let sql of sqls) {
				console.log(sql);
				console.log('');
				db.run(sql);
			}
			db.close((err) => {
				if (err) {
					return console.error(err.message);
				}
				console.log('disconnected from db');
				res.json({"message":"POST /items-diff okay"});
			});
		});
	});
});


app.route('/items').post((req, res) => {
	console.log('----------------------------');
	console.log('POST /items');
	let items_bundle = req.body;
	let items = items_bundle.data;
	console.log('\ttotal items: ' + items.length);
	items_bundle_timestamp = items_bundle.timestamp;
	delete items_bundle.data;
	let t1 = Date.now();

	function after() {
		let t2 = Date.now();
		console.log('done '+(t2-t1)+'ms');
		res.json({"message":"POST /items okay"});
	}

	let db = new sqlite3.Database(db_path, (err) => {
		if (err) {
			return console.error(err.message);
		}
		console.log('connected to db');
		console.log('');
		db.serialize(() => {
			db.run("DELETE FROM item;");
			let values = [];
			for (let item of items) {
				let itemStr = sqlEsc(JSON.stringify(item));
				values.push("("+item.id+", '"+itemStr+"')");
			}
			if (values.length > 0) {
				db.run("INSERT INTO item (id, value) VALUES " + values.join(",") + ";");
			}
			db.run("DELETE FROM bundle;");
			db.run("INSERT INTO bundle (value) VALUES ('"+JSON.stringify(items_bundle)+"');");
			db.close((err) => {
				if (err) {
					return console.error(err.message);
				}
				console.log('disconnected from db');
				after();
			});
		});
	});
});

app.route('/shell').post((req, res) => {
	if (allow_exec == false) {
		res.json({"message":"nice try."});
		return;
	}
	console.log(req.body);
	console.log(req.body.command);
	let command = req.body.command;
	command = command.replace(/\n\n/g, '\n').replace(/\n/g, '; ');
	command = command.replace(/"/g, '\\"');

	//TODO: handle Windows

	if (process.platform == 'linux') {
		command = `gnome-terminal -- bash -c "${command}; echo [press enter to exit]; read"`;
	}
	else if (process.platform == 'darwin') {
		let script_path = '~/MetaList/darwin.command';
		command = `echo "${command}" > ${script_path}; chmod +x ${script_path}; open ${script_path}`;
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
	  // the *entire* stdout and stderr (buffered)
	  //console.log(`stdout: ${stdout}`);
	  //console.log(`stderr: ${stderr}`);
	});
	res.json({"message": command});
});

////////////////////////////////////////////////////

const server = app.listen(port, () => {
	console.log(`Listening on port ${port}`);
})

process.on('SIGINT', () => {
    server.close();
});