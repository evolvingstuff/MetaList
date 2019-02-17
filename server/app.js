'use strict';

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
const fs = require('fs');
const bodyParser = require('body-parser');

let save_dir = 'saved-data/';
let backup_dir = save_dir+'backups/'

let timestamp_version = Date.now();

let MAX_BACKUPS = 10;

let _most_recent_data_as_string = null;
let _most_recent_data_as_json = null;


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

////////////////////////////////////////////////////

app.route('/items').get((req, res) => {
	console.log('');
	console.log('-------------------------------------');
	console.log('get all items');
	//TODO: handle not finding file

	if (_most_recent_data_as_string != null) {
		let t1 = Date.now();
		let items = _most_recent_data_as_json;
		let t2 = Date.now();
		console.log('\t'+items.length+' items loaded and parsed (in-memory), took '+(t2-t1)+'ms');
		res.json(items); //TODO: surround with other data
	}
	else {
		let t1 = Date.now();
		fs.readFile(save_dir+'items.txt', function read(err, data) {
		    if (err) {
		        throw err; //TODO: handle this
		    }
		    let items = JSON.parse(data);
		    _most_recent_data_as_string = data;
		    _most_recent_data_as_json = items;
		    let t2 = Date.now();
		    timestamp_version = Date.now();
		    console.log('\t'+items.length+' items loaded and parsed (from file), took '+(t2-t1)+'ms');
		    res.json(items); //TODO: surround with other data
		});
	}
});

app.route('/items').post((req, res) => {

	let items = req.body;
	let t1 = Date.now();
	let items_as_string = JSON.stringify(items);

	if (items_as_string == _most_recent_data_as_string) {
		console.log('\titems are unchanged, no update needed');
		res.json({"message":"POST okay ("+items.length+" items)"});
	}
	else {
		console.log('set all items');
		console.log('\tlength of items = ' + items.length);
		if (!fs.existsSync(save_dir)){
		    fs.mkdirSync(save_dir);
		    console.log('created saved-data directory');
		}

		fs.writeFile(save_dir+'items.txt', items_as_string, (err) => {  
		    if (err) {
		        throw err; //TODO: handle this
		    }
		    let t2 = Date.now();
		    console.log('items saved, took '+(t2-t1)+'ms');

		    _most_recent_data_as_string = items_as_string;
		    _most_recent_data_as_json = items;

		    //handle backups
		    if (!fs.existsSync(backup_dir)){
			    fs.mkdirSync(backup_dir);
			    console.log('created backup save directory');
			}

			fs.writeFile(backup_dir+'items.'+t2+'.txt', items_as_string, (err) => {
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
		});
	  	res.json({"message":"POST okay ("+items.length+" items)"}); //TODO: not 'okay' until completed with backups
	}
	
});

app.route('/items/:itemId').post((req, res) => {
	console.log('set item');
  	const id = req.params.itemId;
  	res.json({"message":"okay", "id": id});
});

app.route('/items/:itemId').delete((req, res) => {
	console.log('delete item');
  	const id = req.params.itemId;
  	res.json({"message":"okay", "id": id});
});

////////////////////////////////////////////////////

const server = app.listen(port, () => {
	console.log(`Listening on port ${port}`);
})

process.on('SIGINT', () => {
	/*
	if (db != null) {
    	db.close();
    	console.log('db.close()');
	}
	*/
    server.close();
});