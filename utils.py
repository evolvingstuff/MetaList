import time, json, re
import sqlite3
from dataclasses import dataclass
from config import *
from typing import Tuple


# TODO use a better regex for this. For example, this will not work for &nbsp; and other html entities
re_clean_tags = re.compile('<.*?>|&([a-z0-9]+|#[0-9]{1,6}|#x[0-9a-f]{1,6});')


@dataclass
class Diff:
    updated_items: list
    added_items: list
    deleted_items: list
    search_filter: str
    item_subitem_id: str


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
    db = sqlite3.connect(db_path)
    rows = db.execute('SELECT * from items ORDER BY id DESC').fetchall()
    for row in rows:
        id, value = row[0], row[1]
        item = json.loads(value)
        cache['id_to_item'][id] = decorate_item(item)
    recalculate_item_ranks(cache)
    t2 = time.time()
    print(f'warmed up {len(rows)} items in {((t2-t1)*1000):.2f} ms')


def recalculate_item_ranks(cache):
    cache['items'] = []
    if len(cache['id_to_item']) == 0:
        print('no items to rank')
        return
    t1 = time.time()
    # TODO: does not account for zero items
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


def propagate_matches(item):
    # TODO 2023.02.17 this could be more efficient (use a stack)
    added_indices = set()
    for i, subitem in enumerate(item['subitems']):
        if '_match' in subitem:
            indent_cursor = subitem['indent']
            # propagate up
            for j in range(i-1, -1, -1):
                subitem2 = item['subitems'][j]
                if subitem2['indent'] < indent_cursor:
                    added_indices.add(j)
                    indent_cursor = subitem2['indent']
            # propagate down
            for j in range(i+1, len(item['subitems'])):
                subitem2 = item['subitems'][j]
                if subitem2['indent'] > subitem['indent']:
                    added_indices.add(j)
                else:
                    break
    for i in added_indices:
        item['subitems'][i]['_match'] = True


def decorate_item(item):
    parent_stack = []
    rank = 0  # TODO 2023.02.17 BUG this does not increase, so all items are 0)
    for subitem in item['subitems']:
        clean_text = re_clean_tags.sub('', subitem['data'])
        subitem['_clean_text'] = clean_text.lower()  # TODO what strategy to use for case sensitivity?
        subitem['_tags'] = [t.strip() for t in subitem['tags'].split(' ')]
        if len(parent_stack) > 0:
            while parent_stack[-1]['indent'] >= subitem['indent']:
                parent_stack.pop()
            if len(parent_stack) > 0:
                assert int(parent_stack[-1]['indent']) == int(subitem['indent']) - 1
                if '@list-bulleted' in parent_stack[-1]['_tags']:
                    subitem['_@list-bulleted'] = True
                if '@list-numbered' in parent_stack[-1]['_tags']:
                    subitem['_@list-numbered'] = rank
            for parent in parent_stack:
                non_special_parent_tags = [t for t in parent['_tags'] if not t.startswith('@')]
                for tag in non_special_parent_tags:
                    if tag not in subitem['_tags']:
                        subitem['_tags'].append(tag)
        parent_stack.append(subitem)
    return item


def test_filter_against_subitem(subitem, search_filter: str) -> bool:
    """
    This takes a single subitem, and compares its content to a
    search filter argument, which may be a combination of tags
    and text requirements (both positive and negative.) Case
    sensitivity is ignored.
    :param subitem:
    :param search_filter:
    :return: bool
    """

    if len(search_filter['tags']) == 0 and \
            len(search_filter['texts']) == 0 and \
            search_filter['partial_text'] is None and \
            search_filter['partial_tag'] is None and \
            len(search_filter['negated_tags']) == 0 and \
            len(search_filter['negated_texts']) == 0 and \
            search_filter['negated_partial_text'] is None and \
            search_filter['negated_partial_tag'] is None:
        # if we have no filters whatsoever, return subitem (True)
        return True

    subitem_text = subitem['_clean_text']
    subitem_tags = subitem['_tags']

    # remove positives first, because this narrows down the search space fastest
    # TODO: for better efficiency, could order these by frequency, ascending
    if search_filter['partial_text'] is not None and \
            search_filter['partial_text'].lower() not in subitem_text:
        return False
    if search_filter['partial_tag'] is not None:
        one_match = False
        for subitem_tag in subitem_tags:
            if use_partial_tag_matches_positive:
                if subitem_tag.lower().startswith(search_filter['partial_tag'].lower()):
                    one_match = True
                    break
            else:
                if subitem_tag.lower() == search_filter['partial_tag'].lower():
                    one_match = True
                    break
        if not one_match:
            return False
    for required_tag in search_filter['tags']:
        if required_tag.lower() not in [t.lower() for t in subitem_tags]:
            return False
    for required_text in search_filter['texts']:
        if required_text.lower() not in subitem_text:
            return False

    # then check for negatives after, because these are less likely to be true
    # TODO: for better efficiency, could order these by frequency, descending
    if search_filter['negated_partial_tag'] is not None:
        # TODO: 2023.09.21 apply use_partial_tag_matches logic
        for subitem_tag in subitem_tags:
            if use_partial_tag_matches_negative:
                if subitem_tag.lower().startswith(search_filter['negated_partial_tag'].lower()):
                    return False
            else:
                if subitem_tag.lower() == search_filter['negated_partial_tag'].lower():
                    return False
    if search_filter['negated_partial_text'] is not None and \
            search_filter['negated_partial_text'].lower() in subitem_text:
        return False
    for negated_tag in search_filter['negated_tags']:
        if negated_tag.lower() in [t.lower() for t in subitem_tags]:
            return False
    for negated_text in search_filter['negated_texts']:
        if negated_text.lower() in subitem_text:
            return False
    return True


def get_context(request) -> Tuple[int, int, str]:
    item_subitem_id = request.json['itemSubitemId']
    search_filter = request.json['searchFilter']
    item_id, subitem_index = map(int, item_subitem_id.split(':'))
    return item_subitem_id, item_id, subitem_index, search_filter


def annotate_item_match(item, search_filter):
    at_least_one_match = False
    for subitem in item['subitems']:  # TODO, if no search filter, auto match
        if test_filter_against_subitem(subitem, search_filter):
            subitem['_match'] = True
            at_least_one_match = True
    return at_least_one_match


def generic_response(cache, search_filter):
    # TODO 2023.10.04 need to make this more efficient
    t1 = time.time()
    items = []
    for item in cache['items']:
        if annotate_item_match(item, search_filter):
            propagate_matches(item)
            items.append(item)
        if len(items) >= max_results:
            # TODO: this doesn't handle pagination
            break
    t2 = time.time()
    print(f'found {len(items)} items in {((t2 - t1) * 1000):.4f} ms')
    return {
        'items': items
    }


def prev_visible(cache, item):
    assert item['subitems'][0]['_match'] is True
    if item['prev'] is None:
        return None
    node = item
    while True:
        node = cache['id_to_item'][node['prev']]
        if '_match' in node['subitems'][0] and node['subitems'][0]['_match'] is True:
            return node
        if node['prev'] is None:
            return None
    return None


def next_visible(cache, item):
    assert item['subitems'][0]['_match'] is True
    if item['next'] is None:
        return None
    node = item
    while True:
        node = cache['id_to_item'][node['next']]
        if '_match' in node['subitems'][0] and node['subitems'][0]['_match'] is True:
            return node
        if node['next'] is None:
            return None
    return None


def remove_item(cache, item):
    # TODO: write unit test for this
    if len(cache['items']) > 1:  # otherwise no need to rewrite references
        prev = cache['id_to_item'][item['prev']]
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
    loc_next = cache['items'].index(next)
    prev['next'] = item['id']
    item['prev'] = prev['id']
    next['prev'] = item['id']
    item['next'] = next['id']
    cache['items'].insert(loc_next, item)
    cache['id_to_item'][item['id']] = item
