"use strict";

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
const fs = require('fs');
const bodyParser = require('body-parser');
const { exec } = require('child_process');

const MAX_ROLLING_BACKUPS = 10;

let save_dir_items_bundles = 'saved-items-bundles/';
let allow_exec = true;
let items_bundle_timestamp = null;

console.log('platform: ' + process.platform);

if (process.platform == 'linux' || process.platform == 'darwin') {
	const homedir = require('os').homedir();
	save_dir_items_bundles = homedir + '/MetaList/';
}
//TODO: other OS

const backup_dir = save_dir_items_bundles+'backups/'

if (!fs.existsSync(save_dir_items_bundles)){
    fs.mkdirSync(save_dir_items_bundles);
    console.log('created '+save_dir_items_bundles+' directory');
}

const filestore_path = save_dir_items_bundles + 'MetaListFileStore';

if (!fs.existsSync(filestore_path)) {
	console.log('creating ' + filestore_path);
	fs.mkdirSync(filestore_path);
}

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
	let files = fs.readdirSync(filestore_path);
	let items = [];
	let items_bundle = null;
	for (let file of files) {
		if (file == 'bundle') {
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
	console.log('Loading all items took '+(t2-t1)+'ms');
	res.json(items_bundle);
});

app.route('/delete-everything').post((req, res) => {
	console.log('/delete-everything');
	let t1 = Date.now();
	deleteAll(filestore_path);
	let t2 = Date.now();
	console.log('>>> files all deleted in '+(t2-t1)+'ms');
	res.json({"message":"POST /delete-everything okay"});
});

app.route('/items-diff').post((req, res) => {
	console.log('POST /items-diff');
	let diffs = req.body;
	if (diffs.updated.length == 0 &&
		diffs.added.length == 0 &&
		diffs.deleted.length == 0) {
		console.log('No diffs to update. Skipping');
		res.json({"message":"POST /items-diff okay"});
		return;
	}
	let t1 = Date.now();
	for (let item of diffs.updated) {
		fs.writeFileSync(filestore_path+'/'+item.id, JSON.stringify(item));
	}
	for (let item of diffs.added) {
		fs.writeFileSync(filestore_path+'/'+item.id, JSON.stringify(item));
	}
	for (let item of diffs.deleted) {
		fs.unlinkSync(filestore_path+'/'+item.id);
	}
	let t2 = Date.now();
	console.log('>>> diff file update took ' + (t2-t1) + 'ms');
	res.json({"message":"POST /items-diff okay"});
});

function deleteAll(path) {
	let files = fs.readdirSync(path);
	for (let file of files) {
		fs.unlinkSync(path+'/'+file);
	}
}

app.route('/items').post((req, res) => {
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
		command = `echo "${command}; echo [press enter to exit]; read" > ${script_path}; chmod +x ${script_path}; open ${script_path}`;
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
	if (allow_exec == false) {
		res.json({"message":"nice try."});
		return;
	}
	console.log(req.body);
	console.log(req.body.filePath);
	let command = req.body.filePath;
	command = command.replace(/\n\n/g, '\n').replace(/\n/g, '; ');
	command = command.replace(/"/g, '\\"');

	//TODO: handle Windows
	//TODO: handle spaces in file names!

	if (process.platform == 'linux') {
		command = `xdg-open ${command}`;
	}
	else if (process.platform == 'darwin') {
		command = `open ${command}`;
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
    server.close();
});