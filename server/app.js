'use strict';

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
//const sqlite3 = require('sqlite3');
const fs = require('fs');
const bodyParser = require('body-parser');

const $model = require('../js/model/model').$model;

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
	let t1 = Date.now();
	fs.readFile('items.txt', function read(err, data) {
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
	fs.writeFile('items.txt', JSON.stringify(items), (err) => {  
	    // throws an error, you could also catch it here
	    if (err) {
	        throw err; //TODO: handle this
	    }
	    let t2 = Date.now();
	    // success case, the file was saved
	    console.log('items saved, took '+(t2-t1)+'ms');
	});

  	res.json({"message":"POST okay ("+items.length+" items)"});
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
	console.log(`Listening on port ${port}!`)
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