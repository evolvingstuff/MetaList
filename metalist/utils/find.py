from typing import Optional, Tuple
from metalist.utils.decorate_single_item import calculate_matches_per_item


def find_prev_visible_item(cache, item, search_filter):
    assert item['subitems'][0]['_match'] is True
    if item['prev'] is None:
        return None
    node = item
    while True:
        node = cache['id_to_item'][node['prev']]
        if calculate_matches_per_item(node, search_filter):
            return node
        if node['prev'] is None:
            return None
    return None


def find_next_visible_item(cache, item, search_filter):
    assert item['subitems'][0]['_match'] is True
    if item['next'] is None:
        return None
    node = item
    while True:
        node = cache['id_to_item'][node['next']]
        if calculate_matches_per_item(node, search_filter):
            return node
        if node['next'] is None:
            return None
    return None


def find_subtree_bounds(item, subitem_index) -> Tuple:
    """
    Find the subitem index bounds for this subitem
    """
    subitem = item['subitems'][subitem_index]
    upper_bound = subitem_index
    lower_bound = subitem_index
    for i in range(upper_bound + 1, len(item['subitems'])):
        if item['subitems'][i]['indent'] <= subitem['indent']:
            break
        lower_bound = i
    return upper_bound, lower_bound


def find_subtree_bounds_all_siblings_below(item, subitem_index) -> Tuple:
    """
    Find the subitem index bounds for this subitem and all subitem siblings below
    """
    subitem = item['subitems'][subitem_index]
    upper_bound = subitem_index
    lower_bound = subitem_index
    for i in range(upper_bound + 1, len(item['subitems'])):
        if item['subitems'][i]['indent'] < subitem['indent']:
            break
        lower_bound = i
    return upper_bound, lower_bound


def find_sibling_index_above(item, subitem_index) -> Optional[int]:
    """
    Find the subitem index of the nearest sibling above
    Return None if doesn't exit
    """
    if subitem_index == 0:
        return None
    indent = item['subitems'][subitem_index]['indent']
    for i in range(subitem_index-1, -1, -1):
        indent_above = item['subitems'][i]['indent']
        if indent_above > indent:
            continue
        if indent_above == indent:
            return i
        if indent_above < indent:
            return None
    raise Exception('should not have made it to top')


def find_sibling_index_below(item, subitem_index) -> Optional[int]:
    """
    Find the subitem index of the nearest sibling below
    Return None if doesn't exist
    """
    if subitem_index == 0:
        return None
    indent = item['subitems'][subitem_index]['indent']
    for i in range(subitem_index + 1, len(item['subitems'])):
        indent_below = item['subitems'][i]['indent']
        if indent_below > indent:
            continue
        if indent_below == indent:
            return i
        if indent_below < indent:
            return None
    return None
