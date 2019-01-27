'use strict';

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
const sqlite3 = require('sqlite3');
const fs = require('fs');

const $model = require('../js/model/model').$model;

let db = null;
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

app.use(express.static('../'));

////////////////////////////////////////////////////

app.route('/items').get((req, res) => {
	console.log('get all items');
  	res.json({"message":"okay"});
});

app.route('/items').post((req, res) => {
	console.log('set all items');
  	res.json({"message":"okay"});
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

app.route('/priorities').post((req, res) => {
	console.log('set priorities');
  	res.json({"message":"okay"});
});

////////////////////////////////////////////////////

/*
app.get('/', (req, res) => {
	res.send('Hello MetaList!');
})
*/

const server = app.listen(port, () => {
	console.log(`Listening on port ${port}!`)
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
})

process.on('SIGINT', () => {
	if (db != null) {
    	db.close();
    	console.log('db.close()');
	}
    server.close();
});