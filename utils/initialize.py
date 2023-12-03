import json
import os
import sqlite3
import time
from config.config import db_path
from utils.decorate_single_item import decorate_item


def initialize_cache(cache):
    """
    Called once, upon program startup.
    Used to pull from database and store in memory.
    Currently, does not store back to the database; that will be added later.
    Also, will need to eventually handle encryption/decryption.
    :return:
    """
    cache['id_to_item'] = dict()
    t1 = time.time()
    if not os.path.exists(db_path):
        # create a new database if none exists
        db = sqlite3.connect("metalist.2.0.db")
        sql = 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);'
        db.execute(sql)
        print('created new items table for empty database')
    else:
        db = sqlite3.connect(db_path)
        rows = db.execute('SELECT * from items ORDER BY id DESC').fetchall()
        for row in rows:
            id, value = row[0], row[1]
            item = json.loads(value)
            cache['id_to_item'][id] = decorate_item(item)
        t2 = time.time()
        print(f'warmed up {len(rows)} items in {((t2-t1)*1000):.2f} ms')


def recalculate_item_ranks(cache):
    cache['items'] = []
    if len(cache['id_to_item']) == 0:
        print('no items to rank')
        return
    t1 = time.time()
    if len(cache['id_to_item']) == 0:
        raise NotImplementedError('does not account for no items')
    for item in cache['id_to_item'].values():
        if item['prev'] is None:
            head = item
            break
    node = head
    rank = 0
    while True:
        rank += 1
        cache['items'].append(node)
        if node['next'] is None:
            break
        node = cache['id_to_item'][node['next']]
    assert len(cache['items']) == len(cache['id_to_item']), f'mismatch when calculating item ranks, location 2: {len(cache["items"])} vs {len(cache["id_to_item"])}'
    t2 = time.time()
    print(f'recalculating item ranks took {((t2-t1)*1000):.2f} ms')