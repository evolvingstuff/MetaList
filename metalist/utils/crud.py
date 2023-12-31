import json
import os
from metalist.config.config import db_name, db_dir


def get_database_path():
    home_dir = os.path.expanduser("~")
    database_path = os.path.join(home_dir, db_dir, db_name)
    os.makedirs(os.path.dirname(database_path), exist_ok=True)
    return database_path


def begin(db):
    db.execute('BEGIN')


def rollback(db):
    db.rollback()


def commit(db):
    db.commit()


def create(db, item):
    id = item['id']
    value = json.dumps(item)
    db.execute('INSERT INTO items (id, value) VALUES (?, ?)', (id, value))


def retrieve(db, item):
    raise NotImplementedError('retrieve not yet implemented')


def update(db, item):
    id = item['id']
    value = json.dumps(item)
    db.execute('UPDATE items SET value = ? WHERE id = ?', (value, id))


def delete(db, item):
    id = item['id']
    db.execute('DELETE FROM items WHERE id = ?', (id,))