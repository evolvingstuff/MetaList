"use strict";

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
const fs = require('fs');
const bodyParser = require('body-parser');
const { exec } = require('child_process');

let save_dir_items_bundles = 'saved-items-bundles/';
let backup_dir = save_dir_items_bundles+'backups/'
let MAX_BACKUPS = 0;
let _most_recent_data_as_json = null;
let allow_exec = true;
let items_bundle_timestamp = null;


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
	console.log('get all items');
	//TODO: handle not finding file

	if (_most_recent_data_as_json != null) {
		let t1 = Date.now();
		let items_bundle = _most_recent_data_as_json;
		items_bundle_timestamp = items_bundle.timestamp;
		let t2 = Date.now();
		console.log('\titems loaded and parsed (in-memory), took '+(t2-t1)+'ms');
		res.json(items_bundle); //TODO: surround with other data
	}
	else {
		let path = save_dir_items_bundles+'items_bundle.json';
		console.log('attempting to load from file ' + path);
		let t1 = Date.now();
		if (fs.existsSync(path)) {
			console.log(path + ' exists');
			fs.readFile(path, function read(err, data) {
			    if (err) {
			        //throw err; //TODO: handle this
			        console.log('Could not read ' + save_dir_items_bundles + 'items_bundle.json');
			    }
			    else {
			    	console.log('Parsing data in ' + save_dir_items_bundles + 'items_bundle.json');
				    let items_bundle = JSON.parse(data);
				    _most_recent_data_as_json = items_bundle;
				    items_bundle_timestamp = items_bundle.timestamp;
				    let t2 = Date.now();
				    console.log('\titems bundle loaded and parsed (from file), took '+(t2-t1)+'ms');
				    res.json(items_bundle); //TODO: surround with other data
				}
			});
		}
		else {
			console.log('Making new empty file');
			let items = [];
		    let items_bundle = bundleItemsNonEncrypted(items);
		    items_bundle_timestamp = items_bundle.timestamp;
		    console.log(JSON.stringify(items_bundle));
		    _most_recent_data_as_json = items_bundle;
		    let t2 = Date.now();
		    console.log('\titems bundle loaded and parsed (from file), took '+(t2-t1)+'ms');
		    if (!fs.existsSync(save_dir_items_bundles)){
			    fs.mkdirSync(save_dir_items_bundles);
			    console.log('created '+save_dir_items_bundles+' directory');
			}
		    fs.writeFile(path, JSON.stringify(items_bundle), (err) => {  
			    if (err) {
			        throw err; //TODO: handle this
			    }
		    	res.json(items_bundle); //TODO: surround with other data
		    });
		}
	}
});

app.route('/items').post((req, res) => {

	let items_bundle = req.body;
	let items = items_bundle.data;
	items_bundle_timestamp = items_bundle.timestamp;

	let t1 = Date.now();
	let items_bundle_as_string = JSON.stringify(items_bundle);

	console.log('set all items');
	if (!fs.existsSync(save_dir_items_bundles)){
	    fs.mkdirSync(save_dir_items_bundles);
	    console.log('created '+save_dir_items_bundles+' directory');
	}

	let t1_write = Date.now();

	fs.writeFile(save_dir_items_bundles+'items_bundle.json', items_bundle_as_string, (err) => {  
	    if (err) {
	        throw err; //TODO: handle this
	    }
	    let t2 = Date.now();
	    console.log('items all saved, took '+(t2-t1)+'ms');
	    console.log('file io took '+(t2 - t1_write)+'ms')

	    _most_recent_data_as_json = items_bundle;

	    if (MAX_BACKUPS > 0) {
		    //handle backups
		    if (!fs.existsSync(backup_dir)){
			    fs.mkdirSync(backup_dir);
			    console.log('created backup save directory');
			}

			fs.writeFile(backup_dir+'items_bundle.'+t2+'.json', items_bundle_as_string, (err) => {
				if (err) {
		        	throw err; //TODO: handle this
		    	}
		    	let t3 = Date.now();
		    	console.log('items backed up, took '+(t3-t2)+'ms');

		    	fs.readdir(backup_dir, function(err, files) {
		    		if (err) {
		    			throw err;
		    		}
		    		console.log('\t' + files.length + ' backup versions (max = '+MAX_BACKUPS+')');

		    		let out = [];
		    		files.forEach(function(file) {
				        var stats = fs.statSync(backup_dir+file);
				        if(stats.isFile()) {
				            out.push({"file":file, "mtime": stats.mtime.getTime()});
				        }
				    });
				    out.sort(function(a,b) {
				        return b.mtime - a.mtime;
				    });
				    for (let i = 0; i < out.length; i++) {
				    	let f = out[i];
				    	if (i == 0) {
				    		console.log('\t\tmost recent: ' + f.file);
				    	}
				    	if (i >= MAX_BACKUPS) {
				    		console.log('\t\tremoving:    ' + f.file);
				    		fs.unlinkSync(backup_dir+f.file);
				    	}
				    }
				    let t4 = Date.now();
				    console.log('\tmanaging backups took '+(t4-t3)+'ms');
		    	});
		    });
		}
	});
  	res.json({"message":"POST okay ("+items_bundle.data.length+" items in bundle)"}); //TODO: not 'okay' until completed with backups

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
	//TODO: handle non-ubuntu
	command = command.replace(/"/g, '\\"');
	command = `gnome-terminal -- bash -c "${command}; echo [press enter to exit]; read"`
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