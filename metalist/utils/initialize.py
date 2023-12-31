import copy
import json
import os
import sqlite3
import time
import tqdm
from metalist.config import development_mode
from metalist.utils.crud import get_database_path
from metalist.utils.decorate_single_item import decorate_item


def initialize_cache(cache):
    """
    Called once, upon program startup.
    Used to pull from database and store in memory.
    Currently, does not store back to the database; that will be added later.
    Also, will need to eventually handle encryption/decryption.
    :return:
    """
    cache['id_to_item'] = dict()
    cache['hash_to_item'] = dict()
    t1 = time.time()
    db_path = get_database_path()
    if not os.path.exists(db_path):
        # create a new database if none exists
        db = sqlite3.connect(db_path)
        sql = 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);'
        db.execute(sql)
        print('created new items table for empty database')
    else:
        db = sqlite3.connect(db_path)
        rows = db.execute('SELECT * from items').fetchall()
        for row in tqdm.tqdm(rows):
            id, value = row[0], row[1]
            raw_item = json.loads(value)
            item = decorate_item(raw_item)
            cache['id_to_item'][id] = item
            cache['hash_to_item'][item['_hash']] = copy.deepcopy(item)
        t2 = time.time()
        if development_mode:
            print(f'warmed up {len(rows)} items in {((t2-t1)*1000):.2f} ms')
