import copy
import json
import os
import sqlite3
import time
import tqdm
import metalist.config as conf
from metalist.utils.crud import get_database_path, get_database_dir
from metalist.utils.decorate_single_item import decorate_item
from metalist.utils.ontology import *
from metalist.utils.search_index import SearchIndex


def initialize_database(db_name=None):
    # potentially initialize directory for database
    database_dir = get_database_dir()
    if not os.path.exists(database_dir):
        print(f'creating new database directory at {database_dir}')
        os.makedirs(database_dir)

    # potentially initialize config database
    db_config_path = get_database_path(conf.db_config_name)
    if not os.path.exists(db_config_path):
        print(f'creating new config database at {db_config_path}')
        db = sqlite3.connect(db_config_path)
        sql = 'CREATE TABLE IF NOT EXISTS kv (key TEXT NOT NULL, value TEXT NOT NULL);'
        db.execute(sql)
        sql = f"INSERT INTO kv (key, value) VALUES ('db_version', '{conf.default_db_name}');"
        db.execute(sql)
        db.commit()

    # potentially initialize database
    if db_name is None:
        db_name = get_db_version()
    db_path = get_database_path(db_name)
    if not os.path.exists(db_path):
        # create a new database if none exists
        print(f'creating new database at {db_path}')
        db = sqlite3.connect(db_path)
        sql = 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);'
        db.execute(sql)
        db.commit()


def initialize_server_state(server_state):
    server_state.clear()
    server_state['db_name'] = get_db_version()


def get_db_version():
    db_config_path = get_database_path(conf.db_config_name)
    db = sqlite3.connect(db_config_path)
    sql = "SELECT * FROM kv WHERE key='db_version';"
    rows = db.execute(sql).fetchall()
    if len(rows) == 1:
        return rows[0][1]
    else:
        raise Exception('db_version not found in config database')


def set_db_version(db_name):
    db_config_path = get_database_path(conf.db_config_name)
    db = sqlite3.connect(db_config_path)
    sql = f"UPDATE kv SET value='{db_name}' WHERE key='db_version';"
    db.execute(sql)
    db.commit()
    print(f'set db_version to {db_name} in config database')


def initialize_cache(cache):
    """
    Called once, upon program startup.
    Used to pull from database and store in memory.
    Currently, does not store back to the database; that will be added later.
    Also, will need to eventually handle encryption/decryption.
    """
    cache.clear()
    cache['id_to_item'] = dict()
    cache['hash_to_item'] = dict()
    cache['ontology'] = dict()
    cache['implications'] = dict()
    cache['implications_text'] = dict()
    cache['search_index'] = SearchIndex()
    t1 = time.time()
    db_name = get_db_version()
    db_path = get_database_path(db_name)
    if not os.path.exists(db_path):
        # create a new database if none exists
        db = sqlite3.connect(db_path)
        sql = 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);'
        db.execute(sql)
        if config.development_mode:
            print('created new items table for empty database')
    else:
        db = sqlite3.connect(db_path)
        t1_load = time.time()
        rows = db.execute('SELECT * from items').fetchall()
        raw_items = []
        print('parsing as json:', flush=True)
        for row in tqdm.tqdm(rows):
            _, value = row[0], row[1]
            raw_item = json.loads(value)
            extract_ontology(cache, raw_item)
            raw_items.append(raw_item)
        t2_load = time.time()
        t1_imp = time.time()
        propagate_implications(cache)
        t2_imp = time.time()
        t1_dec = time.time()
        print('decorating items:', flush=True)
        for raw_item in tqdm.tqdm(raw_items):
            item = decorate_item(raw_item, cache, dirty_edit=False, dirty_text=True, dirty_tags=True)
            # TODO: do we actually need deep copies here?
            cache['id_to_item'][item['id']] = copy.deepcopy(item)
            cache['hash_to_item'][item['_hash']] = copy.deepcopy(item)
            cache['search_index'].add_item(item)
        t2_dec = time.time()
        t2 = time.time()
        if config.development_mode:
            print(f'warmed up {len(rows)} items in {((t2-t1)):.2f} seconds')
            print(f'db load and convert to json took {(t2_load - t1_load):.2f} seconds')
            print(f'implications took {((t2_imp - t1_imp)):.2f} seconds to propagate')
            print(f'decorations took {((t2_dec - t1_dec)):.2f} seconds to propagate')
            cache['search_index'].show()
