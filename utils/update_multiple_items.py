import json
import os
import sqlite3
import time
from config.config import db_path, always_add_to_global_top
from utils.decorate_single_item import decorate_item
from utils.find import find_prev_visible_item, find_next_visible_item
from utils.generate import generate_unplaced_new_item


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
        prev_item = None
        if item['prev'] is not None:
            prev_item = cache['id_to_item'][item['prev']]
        next_item = None
        if item['next'] is not None:
            next_item = cache['id_to_item'][item['next']]
        if prev_item is not None:
            if next_item is None:
                prev_item['next'] = None
            else:
                prev_item['next'] = next_item['id']
        if next_item is not None:
            if prev_item is None:
                next_item['prev'] = None
            else:
                next_item['prev'] = prev_item['id']
    cache['items'].remove(item)
    del cache['id_to_item'][item['id']]
    recalculate_item_ranks(cache)
    # TODO: update db


def insert_above_item(cache, item_to_insert, item_below):
    item_above = None
    if item_below['prev'] is not None:
        item_above = cache['id_to_item'][item_below['prev']]
    insert_between_items(cache, item_to_insert, item_above, item_below)


def insert_below_item(cache, item_to_insert, item_above):
    item_below = None
    if item_above['next'] is not None:
        item_below = cache['id_to_item'][item_above['next']]
    insert_between_items(cache, item_to_insert, item_above, item_below)


def insert_between_items(cache, item_to_insert, prev_item, next_item):
    if prev_item is None:
        item_to_insert['prev'] = None
    else:
        prev_item['next'] = item_to_insert['id']
        item_to_insert['prev'] = prev_item['id']
    if next_item is None:
        item_to_insert['next'] = None
    else:
        next_item['prev'] = item_to_insert['id']
        item_to_insert['next'] = next_item['id']
    cache['id_to_item'][item_to_insert['id']] = item_to_insert
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
    rank = 0
    while True:
        node['_rank'] = rank
        rank += 1
        cache['items'].append(node)
        if node['next'] is None:
            break
        node = cache['id_to_item'][node['next']]
    assert len(cache['items']) == len(cache['id_to_item']), 'mismatch when calculating item ranks, location 2'
    t2 = time.time()
    print(f'recalculating item ranks took {((t2-t1)*1000):.2f} ms')


def move_item_up(cache, item, search_filter):
    above = find_prev_visible_item(cache, item, search_filter)
    if above is not None:
        remove_item(cache, item)
        insert_above_item(cache, item, above)
    # TODO update db


def move_item_down(cache, item, search_filter):
    below = find_next_visible_item(cache, item, search_filter)
    if below is not None:
        remove_item(cache, item)
        insert_below_item(cache, item, below)
    # TODO update db


def add_item_sibling(cache, item, search_filter):
    # TODO asdfasdf
    print('cp')
    new_item = generate_unplaced_new_item(cache, search_filter)
    insert_below_item(cache, new_item, item)
    decorate_item(new_item)
    cache['id_to_item'][new_item['id']] = new_item
    # TODO update db
    new_item_subitem_id = f'{new_item["id"]}:0'
    return new_item_subitem_id


def add_item_top(cache, search_filter):
    new_item = generate_unplaced_new_item(cache, search_filter)
    if always_add_to_global_top:
        if len(cache['items']) == 0:
            new_item['prev'] = None
            new_item['next'] = None
        else:
            head = None
            for item in cache['items']:
                if item['prev'] is None:
                    head = item
                    break
            assert head is not None
            new_item['prev'] = None
            new_item['next'] = head['id']
            head['prev'] = new_item['id']
    else:
        raise NotImplementedError
    decorate_item(new_item)
    cache['id_to_item'][new_item['id']] = new_item
    recalculate_item_ranks(cache)
    # TODO update db
    new_item_subitem_id = f'{new_item["id"]}:0'
    return new_item_subitem_id


def paste_sibling(cache, context):
    """
    TODO: this should be broken out into two functions, at least
    """
    search_filter = context.search_filter
    item = context.item
    subitem_index = context.subitem_index
    clipboard = context.clipboard
    indent = item['subitems'][subitem_index]['indent']
    clip_item = clipboard['item']
    decorate_item(clip_item)  # in case we want to inherit parent tags
    clip_subitem_index = int(clipboard['subitemIndex'])
    clip_indent = clip_item['subitems'][clip_subitem_index]['indent']
    # inherit parent tags, but only at top level
    clip_item['subitems'][clip_subitem_index]['tags'] = ' '.join(clip_item['subitems'][clip_subitem_index]['_tags'])
    # normalize indent
    clip_item['subitems'][clip_subitem_index]['indent'] = 0
    # always add root to list
    clip_subitems = [clip_item['subitems'][clip_subitem_index]]
    # add any children
    for i in range(clip_subitem_index + 1, len(clip_item['subitems'])):
        next_subitem = clip_item['subitems'][i]
        if next_subitem['indent'] <= clip_indent:  # sibling or an eldar
            break
        next_subitem['indent'] -= clip_indent  # normalize indent
        # add to our clip subitems list
        clip_subitems.append(next_subitem)
    del clip_item, clip_subitem_index  # should not need anymore
    assert len(clip_subitems) > 0, 'no clip subitems'
    if subitem_index == 0:
        # need to create new item, and insert the clipboard stuff (actually, just substitute)
        # also need to include tags from search context
        new_item = generate_unplaced_new_item(cache, search_filter)
        insert_below_item(cache, new_item, item)
        decorate_item(new_item)
        # remember to include tags from search context!
        for tag in new_item['subitems'][0]['_tags']:
            if tag not in clip_subitems[0]['_tags']:
                clip_subitems[0]['tags'] += f' {tag}'
                clip_subitems[0]['_tags'].append(tag)
        # assign subitems directly
        new_item['subitems'] = clip_subitems
        # do not need to decorate
        # do not need to handle normalized indents
        cache['id_to_item'][new_item['id']] = new_item
        recalculate_item_ranks(cache)
        # TODO update db
        new_item_subitem_id = f'{new_item["id"]}:0'
        return new_item_subitem_id
    else:
        # handle normalized indents
        for clip_subitem in clip_subitems:
            # going underneath as a sibling
            clip_subitem['indent'] += indent
        # find the proper insertion point (earliest is immediately after)
        insertion_point = subitem_index + 1
        for i in range(insertion_point, len(item['subitems'])):
            if item['subitems'][i]['indent'] <= indent:  # sibling or eldar
                break
            insertion_point += 1
        initial_insertion_point = insertion_point
        # insert subitems
        item['subitems'][insertion_point:insertion_point] = clip_subitems
        del clip_subitems
        # decorate
        decorate_item(item)
        # do not need to update cache or recalculate ranks
        # TODO update db
        new_item_subitem_id = f'{item["id"]}:{initial_insertion_point}'
        return new_item_subitem_id
