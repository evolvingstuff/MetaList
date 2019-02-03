'use strict';

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
//const sqlite3 = require('sqlite3');
const fs = require('fs');
const bodyParser = require('body-parser');

//const $model = require('../js/model/model').$model;

let save_dir = 'saved-data/';
let backup_dir = save_dir+'backups/'

let MAX_BACKUPS = 10;

let db = null;
/*
const DB_PATH = 'metalist.db';
const CREATE_SQL = `
	CREATE TABLE IF NOT EXISTS items (
		id INT,
		priority INT,
		timestamp INT,
		domain TEXT DEFAULT '*',
		subitems BLOB 
	)
`;
*/

/*
	http://localhost:3000/server/
*/

app.use(express.static('../'));

app.use(bodyParser.json({limit: '100mb'}));

////////////////////////////////////////////////////

app.route('/items').get((req, res) => {
	console.log('');
	console.log('-------------------------------------');
	console.log('get all items');
	//TODO: handle not finding file
	let t1 = Date.now();
	fs.readFile(save_dir+'items.txt', function read(err, data) {
	    if (err) {
	        throw err; //TODO: handle this
	    }
	    let t2 = Date.now();
	    let items = JSON.parse(data);
	    console.log('\t'+items.length+' items loaded and parsed, took '+(t2-t1)+'ms');
	    res.json(items);
	});
  	
});

app.route('/items').post((req, res) => {
	console.log('set all items');
	let items = req.body;
	console.log('\tlength of items = ' + items.length);
	let t1 = Date.now();
	let items_as_string = JSON.stringify(items);
	
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

/*
app.get('/', (req, res) => {
	res.send('Hello MetaList!');
})
*/

const server = app.listen(port, () => {
	console.log(`Listening on port ${port}`);
	/*
	db = new sqlite3.Database(DB_PATH, (err) => {
		if (err) {
			return console.error(err.message);
		}
		console.log('Connected to ' + DB_PATH);
		db.run(CREATE_SQL, [], (err) => {
			if (err) {
				return console.error(err.message);
			}
			console.log('Initialized database');
			console.log($model.serverTest());
		})
	});
	*/
})

process.on('SIGINT', () => {
	if (db != null) {
    	db.close();
    	console.log('db.close()');
	}
    server.close();
});