import json
import os
from metalist import config


def clean_item(item):
    # remove all attributes starting with "_*"
    cleaned = {k: v for k, v in item.items() if not k.startswith('_')}
    cleaned['subitems'] = [{k: v for k, v in subitem.items() if not k.startswith('_')} for subitem in
                           cleaned['subitems'] if isinstance(subitem, dict)]
    return cleaned


def get_database_path():
    home_dir = os.path.expanduser("~")
    database_path = os.path.join(home_dir, config.db_dir, config.db_name)
    os.makedirs(os.path.dirname(database_path), exist_ok=True)
    return database_path


def begin(db):
    db.execute('BEGIN')


def rollback(db):
    db.rollback()


def commit(db):
    db.commit()


def create(db, item):
    item = clean_item(item)
    id = item['id']
    value = json.dumps(item)
    db.execute('INSERT INTO items (id, value) VALUES (?, ?)', (id, value))


def retrieve(db, item):
    raise NotImplementedError('retrieve not yet implemented')


def update(db, item):
    item = clean_item(item)
    id = item['id']
    value = json.dumps(item)
    db.execute('UPDATE items SET value = ? WHERE id = ?', (value, id))


def delete(db, item):
    id = item['id']
    db.execute('DELETE FROM items WHERE id = ?', (id,))