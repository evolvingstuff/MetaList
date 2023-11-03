from config.config import outdent_all_siblings_below
from utils.decorate_single_item import decorate_item
from utils.find import find_sibling_index_above, find_subtree_bounds, find_sibling_index_below, \
    find_subtree_bounds_all_siblings_below
from utils.generate import generate_new_subitem


def swap_subtrees(item, a, b, c, d):
    """
    Rearrange the subitems based on swapping two subtrees
    """
    subitems = item['subitems']
    assert a > 0
    assert a <= b
    assert b + 1 == c
    assert c <= d
    assert d < len(subitems)
    rearranged_subitems = list()
    rearranged_subitems.extend(subitems[0:a])
    rearranged_subitems.extend(subitems[c:d+1])
    rearranged_subitems.extend(subitems[a:b+1])
    if d < len(subitems) - 1:
        rearranged_subitems.extend(subitems[d+1:])
    print('---------------------------------------------')
    assert len(subitems) == len(rearranged_subitems), f'length mismatch: original = {len(subitems)} | swapped = {len(rearranged_subitems)}'
    item['subitems'] = rearranged_subitems


def toggle_todo(item, subitem_index):
    if '@todo' in item['subitems'][subitem_index]['tags']:
        item['subitems'][subitem_index]['tags'] = item['subitems'][subitem_index]['tags'].replace('@todo', '@done')
    elif '@done' in item['subitems'][subitem_index]['tags']:
        item['subitems'][subitem_index]['tags'] = item['subitems'][subitem_index]['tags'].replace('@done', '@todo')
    decorate_item(item)
    # TODO: update db


def toggle_outline(item, subitem_index):
    if 'collapse' in item['subitems'][subitem_index]:
        del item['subitems'][subitem_index]['collapse']
    else:
        item['subitems'][subitem_index]['collapse'] = True
    decorate_item(item)  # TODO do we need this?
    # TODO: update db


def delete_subitem(item, subitem_index):
    indent = item['subitems'][subitem_index]['indent']
    subitems_ = item['subitems'][:]
    del subitems_[subitem_index]
    while subitem_index < len(subitems_) and subitems_[subitem_index]['indent'] > indent:
        del subitems_[subitem_index]
    item['subitems'] = subitems_
    decorate_item(item)  # TODO do we need this?
    # TODO: update db


def update_subitem_content(item, subitem_index, updated_content):
    item['subitems'][subitem_index]['data'] = updated_content
    decorate_item(item)  # TODO do we need this?


def move_subitem_up(item, subitem_index):
    sibling_index_above = find_sibling_index_above(item, subitem_index)
    if sibling_index_above is None:
        raise Exception('cannot move subitem above a parent')
    upper_bound, lower_bound = find_subtree_bounds(item, subitem_index)
    upper_bound_above, lower_bound_above = find_subtree_bounds(item, sibling_index_above)
    shift_up = lower_bound_above - upper_bound_above + 1
    new_subitem_index = subitem_index - shift_up
    swap_subtrees(item, upper_bound_above, lower_bound_above, upper_bound, lower_bound)
    decorate_item(item)
    # TODO: update db
    new_item_subitem_id = f'{item["id"]}:{new_subitem_index}'
    return new_item_subitem_id


def move_subitem_down(item, subitem_index):
    sibling_index_below = find_sibling_index_below(item, subitem_index)
    if sibling_index_below is None:
        raise Exception('cannot move subitem directly below an elder')
    upper_bound, lower_bound = find_subtree_bounds(item, subitem_index)
    upper_bound_below, lower_bound_below = find_subtree_bounds(item, sibling_index_below)
    shift_down = lower_bound_below - upper_bound_below + 1
    new_subitem_index = subitem_index + shift_down
    swap_subtrees(item, upper_bound, lower_bound, upper_bound_below, lower_bound_below)
    decorate_item(item)
    # TODO: update db
    new_item_subitem_id = f'{item["id"]}:{new_subitem_index}'
    return new_item_subitem_id


def indent(item, subitem_index):
    assert subitem_index > 0, "cannot indent top level item"
    sibling_index_above = find_sibling_index_above(item, subitem_index)
    if sibling_index_above is None:
        raise Exception('no sibling above exists, therefore cannot indent')
    sibling_above = item['subitems'][sibling_index_above]
    if 'collapse' in sibling_above:
        del sibling_above['collapse']
    upper_bound, lower_bound = find_subtree_bounds(item, subitem_index)
    for i in range(upper_bound, lower_bound + 1):
        item['subitems'][i]['indent'] += 1
    decorate_item(item)
    # TODO update db


def outdent(item, subitem_index):
    subitem = item['subitems'][subitem_index]
    indent = subitem['indent']
    assert indent >= 2, 'cannot outdent any further'
    if outdent_all_siblings_below:
        upper_bound, lower_bound = find_subtree_bounds_all_siblings_below(item, subitem_index)
    else:
        upper_bound, lower_bound = find_subtree_bounds(item, subitem_index)
    for i in range(upper_bound, lower_bound + 1):
        item['subitems'][i]['indent'] -= 1
    decorate_item(item)
    # TODO update db


def add_subitem_sibling(item, subitem_index):
    indent = item['subitems'][subitem_index]['indent']
    if subitem_index == 0:
        # we are adding from the title row, so it always goes to a fixed indented position
        insert_at = 1
        new_indent = 1
    else:
        new_indent = indent
        insert_at = find_sibling_index_below(item, subitem_index)
        if insert_at is None:
            # no sibling below, therefore add to end of list
            insert_at = len(item['subitems'])
    new_subitem = generate_new_subitem(indent=new_indent, tags='')
    item['subitems'].insert(insert_at, new_subitem)
    decorate_item(item)
    # TODO update db
    new_item_subitem_id = f'{item["id"]}:{insert_at}'
    return new_item_subitem_id


def add_subitem_child(item, subitem_index):
    insert_at = subitem_index + 1
    indent = item['subitems'][subitem_index]['indent'] + 1
    new_subitem = generate_new_subitem(indent=indent, tags='')
    item['subitems'].insert(insert_at, new_subitem)
    parent_subitem = item['subitems'][subitem_index]
    if 'collapse' in parent_subitem:
        del parent_subitem['collapse']
    decorate_item(item)
    # TODO update db
    new_item_subitem_id = f'{item["id"]}:{insert_at}'
    return new_item_subitem_id


def paste_child(item, subitem_index, clipboard):
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

    # handle normalized indents
    for clip_subitem in clip_subitems:
        # going underneath as a child
        clip_subitem['indent'] += indent + 1  # +1 because it is a child

    insertion_point = subitem_index + 1
    # assumption: insertion point does NOT need to account for children of our target

    # insert subitems
    # TODO use slice notation
    item['subitems'][insertion_point:insertion_point] = clip_subitems
    del clip_subitems

    # make sure the target subitem is not collapsed
    if 'collapse' in item['subitems'][subitem_index]:
        del item['subitems'][subitem_index]['collapse']

    # decorate
    decorate_item(item)
    # do not need to update cache or recalculate ranks
    # TODO update db
    new_item_subitem_id = f'{item["id"]}:{insertion_point}'
    return new_item_subitem_id