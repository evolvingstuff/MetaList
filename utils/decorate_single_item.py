import re
from config.config import inherit_text
from utils.search_filters import filter_subitem_negative, filter_subitem_positive
from utils.generate import generate_timestamp


re_clean_tags = re.compile('<.*?>|&([a-z0-9]+|#[0-9]{1,6}|#x[0-9a-f]{1,6});')


def decorate_item(item):
    parent_stack = []
    rank = 0  # TODO BUG this does not increase, so all items are 0)
    # TODO recalculate char_count
    item['last_edit'] = generate_timestamp()
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
                if inherit_text:
                    subitem['_clean_text'] += '|^|' + parent['_clean_text']
        parent_stack.append(subitem)
    now = generate_timestamp()
    item['_version'] = now
    if '_computed' in item:
        del item['_computed']
    return item


def filter_item_and_decorate_subitem_matches(item, search_filter):
    """
    This could technically be included in utils.search_filter, but
    since it has the possibility of mutating the decorated state of the item,
    it is more appropriate to be in here.
    """

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
            if '_block' in subitem:
                del subitem['_block']
            subitem['_match'] = True
        return True

    at_least_one_match = False
    for subitem in item['subitems']:
        if '_match' in subitem:
            del subitem['_match']
        if '_block' in subitem:
            del subitem['_block']
        if filter_subitem_negative(subitem, search_filter):
            subitem['_block'] = True
        elif filter_subitem_positive(subitem, search_filter):
            subitem['_match'] = True
            at_least_one_match = True
    if not at_least_one_match:
        return False
    propagate_match_decorations(item)
    item['_computed'] = True
    if '_match' not in item['subitems'][0]:
        return False
    return True


def propagate_match_decorations(item):
    # TODO this could be more efficient (use a stack)
    """
    Stages:
    1) propagate blocks to children
    2) propagate matches to parents
    3) propagate matches to children
    """
    blocked_indices = set()
    for i, subitem in enumerate(item['subitems']):
        if '_block' in subitem:
            # 1) propagate blocks to children
            for j in range(i+1, len(item['subitems'])):
                subitem2 = item['subitems'][j]
                if subitem2['indent'] > subitem['indent']:
                    blocked_indices.add(j)
                else:
                    break
    for i in blocked_indices:
        if '_match' in item['subitems'][i]:
            del item['subitems'][i]['_match']
        item['subitems'][i]['_block'] = True

    matched_indices = set()
    for i, subitem in enumerate(item['subitems']):
        if '_match' in subitem:
            indent_cursor = subitem['indent']
            # 2) propagate matches to parents
            for j in range(i-1, -1, -1):
                parent_subitem = item['subitems'][j]
                if parent_subitem['indent'] < indent_cursor:
                    if '_block' in parent_subitem:
                        break
                    matched_indices.add(j)
                    indent_cursor = parent_subitem['indent']
            # 3) propagate matches to children
            for j in range(i+1, len(item['subitems'])):
                child_subitem = item['subitems'][j]
                if '_block' in child_subitem:
                    break
                if child_subitem['indent'] > subitem['indent']:
                    matched_indices.add(j)
                else:
                    break
    for i in matched_indices:
        item['subitems'][i]['_match'] = True
