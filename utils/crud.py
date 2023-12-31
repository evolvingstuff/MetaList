import json


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