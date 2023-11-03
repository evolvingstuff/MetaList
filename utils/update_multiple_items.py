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
        recalculate_item_ranks(cache)
        print('created new items table for empty database')
    else:
        db = sqlite3.connect(db_path)
        rows = db.execute('SELECT * from items ORDER BY id DESC').fetchall()
        for row in rows:
            id, value = row[0], row[1]
            item = json.loads(value)
            cache['id_to_item'][id] = decorate_item(item)
        recalculate_item_ranks(cache)
        t2 = time.time()
        print(f'warmed up {len(rows)} items in {((t2-t1)*1000):.2f} ms')


def remove_item(cache, item):
    # TODO: write unit test for this
    if len(cache['items']) > 1:  # otherwise no need to rewrite references
        prev = None
        if item['prev'] is not None:
            prev = cache['id_to_item'][item['prev']]
        next = None
        if item['next'] is not None:
            next = cache['id_to_item'][item['next']]
        if prev is not None:
            if next is None:
                prev['next'] = None
            else:
                prev['next'] = next['id']
        if next is not None:
            if prev is None:
                next['prev'] = None
            else:
                next['prev'] = prev['id']
    cache['items'].remove(item)
    del cache['id_to_item'][item['id']]
    recalculate_item_ranks(cache)
    # TODO: update db


def insert_above_item(cache, item_to_insert, target_item):
    next = target_item
    prev = None
    if target_item['prev'] is not None:
        prev = cache['id_to_item'][target_item['prev']]
    insert_between_items(cache, item_to_insert, prev, next)


def insert_below_item(cache, item_to_insert, target_item):
    prev = target_item
    next = None
    if target_item['next'] is not None:
        next = cache['id_to_item'][target_item['next']]
    insert_between_items(cache, item_to_insert, prev, next)


def insert_between_items(cache, item, prev, next):
    if prev is None:
        item['prev'] = None
    else:
        prev['next'] = item['id']
        item['prev'] = prev['id']
    if next is None:
        item['next'] = None
    else:
        next['prev'] = item['id']
        item['next'] = next['id']
    cache['id_to_item'][item['id']] = item
    # TODO: update db
    recalculate_item_ranks(cache)


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
    while True:
        cache['items'].append(node)
        if node['next'] is None:
            break
        node = cache['id_to_item'][node['next']]
    assert len(cache['items']) == len(cache['id_to_item']), 'mismatch when calculating item ranks, location 2'
    t2 = time.time()
    print(f'recalculating item ranks took {((t2-t1)*1000):.2f} ms')
