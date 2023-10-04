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


def initialize_cache(cache):
    """
    Called once, upon program startup.
    Used to pull from database and store in memory.
    Currently does not store back to the database; that will be added later.
    Also, will need to eventually handle encryption/decryption.
    :return:
    """
    cache['id_to_rank'] = {}
    cache['rank_to_id'] = {}
    cache['id_to_item'] = {}
    t1 = time.time()
    db = sqlite3.connect(db_path)
    rows = db.execute('SELECT * from items ORDER BY id DESC').fetchall()
    head, tail = None, None
    for row in rows:
        id, value = row[0], row[1]
        item = json.loads(value)
        if item['prev'] is None:
            head = item
        if item['next'] is None:
            tail = item
        # TODO this is inefficient, need to use deepcopy or something
        cache['id_to_item'][id] = decorate_item(item)
    assert head and tail, 'did not find head and tail'

    # calculate item ranks
    node = head
    rank = 1
    while True:
        id = node['id']
        cache['id_to_rank'][id] = rank
        cache['rank_to_id'][rank] = id
        if node['next'] is None:
            break
        node = cache['id_to_item'][node['next']]
        rank += 1
    assert rank == len(rows), 'rank != len(rows)'

    t2 = time.time()
    print(f'warmed up {len(rows)} items in {((t2-t1)*1000):.2f} ms')


def copy_item_for_client(item):
    subitems_copy = []
    for subitem in item['subitems']:
        subitem_copy = {
            'data': subitem['data'],
            'tags': subitem['tags'],
            'indent': subitem['indent'],
            '_tags': subitem['_tags'],
            '_clean_text': subitem['_clean_text']
        }
        if '_@list-bulleted' in subitem:
            subitem_copy['_@list-bulleted'] = subitem['_@list-bulleted']
        if '_@list-numbered' in subitem:
            subitem_copy['_@list-numbered'] = subitem['_@list-numbered']
        if 'collapse' in subitem:
            subitem_copy['collapse'] = subitem['collapse']
        subitems_copy.append(subitem_copy)
    # TODO add more fields later, e.g. date created, date modified, etc.
    item_copy = {
        'id': item['id'],
        'subitems': subitems_copy
    }
    return item_copy


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
    return item_id, subitem_index, search_filter


def decorate_with_matches(item, search_filter):
    item_copy = copy_item_for_client(item)
    at_least_one_match = False
    for i, subitem in enumerate(item_copy['subitems']):
        if test_filter_against_subitem(subitem, search_filter):
            subitem['_match'] = True
            at_least_one_match = True
        else:
            if '_match' in subitem:
                del subitem['_match']
    if at_least_one_match:
        propagate_matches(item_copy)
    else:
        print('no matches for item id', item['id'])
    return item_copy
