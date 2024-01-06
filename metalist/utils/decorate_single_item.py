import re
import json
import hashlib
from metalist import config
from metalist.utils.search_filters import filter_subitem_negative, filter_subitem_positive
from metalist.utils.generate import generate_timestamp


re_remove_breaks = re.compile(r'<br\s*/?>')
re_remove_divs = re.compile(r'</?(div|p)\b[^>]*>')
re_searchable_text = re.compile('<.*?>|&([a-z0-9]+|#[0-9]{1,6}|#x[0-9a-f]{1,6});')


def hash_dictionary(d):
    serialized = json.dumps(d, sort_keys=True)
    hash_object = hashlib.sha256(serialized.encode())
    hash_hex = hash_object.hexdigest()
    return hash_hex


def hash_dictionary_fast(d):
    serialized = json.dumps(d, sort_keys=True)
    return hash(serialized)


def get_searchable_text(text):
    newline = ' '  # /n  # TODO should we retain newlines?
    text = re.sub(re_remove_breaks, newline, text)
    text = re.sub(re_remove_divs, newline, text)
    return re_searchable_text.sub('', text).lower().strip()


def clean_tags(tags):
    cleaned_tags = tags
    cleaned_tags = cleaned_tags.lstrip()
    cleaned_tags = re.sub(r'\s+', ' ', cleaned_tags)
    cleaned_tags = re.sub(r'(\s)\s*$', r'\1', cleaned_tags)
    return cleaned_tags


def decorate_item(item, cache, dirty_edit=True, dirty_text=True, dirty_tags=True):
    parent_stack = []
    if dirty_edit:
        item['last_edit'] = generate_timestamp()

    # remove these so as not to include them in _hash
    if '_dirty_matches' in item:
        del item['_dirty_matches']

    item_tags = set()

    for indx, subitem in enumerate(item['subitems']):

        # remove search match decorations before hash
        if '_neg_match' in subitem:
            del subitem['_neg_match']
        if '_match' in subitem:
            del subitem['_match']

        if dirty_text:
            subitem['_searchable_text'] = get_searchable_text(subitem['data'])
            subitem['char_count'] = len(subitem['_searchable_text'])
            subitem['_searchable_text_full'] = subitem['_searchable_text']
        if dirty_tags:
            subitem['tags'] = clean_tags(subitem['tags'])
            subitem['_tags'] = [t for t in subitem['tags'].split() if t]

        # TODO this is probably not efficient
        # handle cascading tags
        if len(parent_stack) > 0:
            while parent_stack[-1]['indent'] >= subitem['indent']:
                parent_stack.pop()
            if len(parent_stack) > 0:
                assert int(parent_stack[-1]['indent']) == int(subitem['indent']) - 1
            for parent in parent_stack:
                if dirty_tags:
                    non_special_parent_tags = [t for t in parent['_tags'] if not t.startswith('@')]
                    for tag in non_special_parent_tags:
                        if tag not in subitem['_tags']:
                            subitem['_tags'].append(tag)
                if dirty_text:
                    if config.inherit_text:
                        subitem['_searchable_text_full'] += ' ' + parent['_searchable_text']

        parent_stack.append(subitem)

        # extend _tags with implications
        tags_set = set(subitem['_tags'])
        if dirty_tags:
            for tag in subitem['_tags']:
                if tag in cache['implications']:
                    tags_set.update(cache['implications'][tag])
            subitem['_tags'] = list(tags_set)
        item_tags.update(tags_set)

    if dirty_tags:
        item['_tags'] = list(item_tags)

    cache['search_index'].remove_item(item)
    cache['search_index'].add_item(item)

    if '_hash' in item:
        del item['_hash']  # don't hash the hash
    item['_hash'] = hash_dictionary(item)
    item['_dirty_matches'] = True  # add back in after, so we don't rerun filters on everything
    return item


def calculate_matches_per_item(item, search_filter):
    """
    This could technically be included in utils.search_filter, but
    since it has the possibility of mutating the decorated state of the item,
    it is more appropriate to be in here.
    """
    if '_dirty_matches' in item:
        del item['_dirty_matches']
    # if no search filter, EVERYTHING matches
    if len(search_filter['tags']) == 0 and \
            len(search_filter['texts']) == 0 and \
            search_filter['partial_text'] is None and \
            search_filter['partial_tag'] is None and \
            len(search_filter['negated_tags']) == 0 and \
            len(search_filter['negated_texts']) == 0 and \
            search_filter['negated_partial_text'] is None and \
            search_filter['negated_partial_tag'] is None:
        for subitem in item['subitems']:
            if '_neg_match' in subitem:
                del subitem['_neg_match']
            subitem['_match'] = True
        return True

    for tag in search_filter['tags']:
        if tag not in item['_tags']:
            item['subitems'][0]['_neg_match'] = True
            return False

    at_least_one_match = False
    for subitem in item['subitems']:
        if '_match' in subitem:
            del subitem['_match']
        if '_neg_match' in subitem:
            del subitem['_neg_match']
        if filter_subitem_negative(subitem, search_filter):
            subitem['_neg_match'] = True
        elif filter_subitem_positive(subitem, search_filter):
            subitem['_match'] = True
            at_least_one_match = True
    if not at_least_one_match:
        return False
    propagate_match_decorations(item)
    if '_match' not in item['subitems'][0]:
        return False
    return True


def propagate_match_decorations(item):
    # TODO this could be more efficient (use a stack)
    """
    Stages:
    1) propagate neg-matches to children
    2) propagate matches to parents
    3) propagate matches to children
    """
    blocked_indices = set()
    for i, subitem in enumerate(item['subitems']):
        if '_neg_match' in subitem:
            # 1) propagate neg-matches to children
            for j in range(i+1, len(item['subitems'])):
                subitem2 = item['subitems'][j]
                if subitem2['indent'] > subitem['indent']:
                    blocked_indices.add(j)
                else:
                    break
    for i in blocked_indices:
        if '_match' in item['subitems'][i]:
            del item['subitems'][i]['_match']
        item['subitems'][i]['_neg_match'] = True

    matched_indices = set()
    for i, subitem in enumerate(item['subitems']):
        if '_match' in subitem:
            indent_cursor = subitem['indent']
            # 2) propagate matches to parents
            for j in range(i-1, -1, -1):
                parent_subitem = item['subitems'][j]
                if parent_subitem['indent'] < indent_cursor:
                    if '_neg_match' in parent_subitem:
                        break
                    matched_indices.add(j)
                    indent_cursor = parent_subitem['indent']
            # 3) propagate matches to children
            for j in range(i+1, len(item['subitems'])):
                child_subitem = item['subitems'][j]
                if '_neg_match' in child_subitem:
                    break
                if child_subitem['indent'] > subitem['indent']:
                    matched_indices.add(j)
                else:
                    break
    for i in matched_indices:
        item['subitems'][i]['_match'] = True
