import copy
from metalist import config
from metalist.utils import crud
from metalist.utils.decorate_single_item import decorate_item
from metalist.utils.find import find_sibling_index_above, find_subtree_bounds, find_sibling_index_below, \
    find_subtree_bounds_all_siblings_below
from metalist.utils.generate import generate_new_subitem


def _swap_subtrees(item, a, b, c, d):
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
    assert len(subitems) == len(rearranged_subitems), f'length mismatch: original = {len(subitems)} | swapped = {len(rearranged_subitems)}'
    item['subitems'] = rearranged_subitems


def todo(db, context, cache):
    if '@done' in context.item['subitems'][context.subitem_index]['tags']:
        context.item['subitems'][context.subitem_index]['tags'] = context.item['subitems'][context.subitem_index]['tags'].replace('@done', '')
    if '@todo' not in context.item['subitems'][context.subitem_index]['tags']:
        context.item['subitems'][context.subitem_index]['tags'] += ' @todo'
    decorate_item(context.item, cache)
    crud.update(db, context.item)


def done(db, context, cache):
    if '@todo' in context.item['subitems'][context.subitem_index]['tags']:
        context.item['subitems'][context.subitem_index]['tags'] = context.item['subitems'][context.subitem_index]['tags'].replace('@todo', '')
    if '@done' not in context.item['subitems'][context.subitem_index]['tags']:
        context.item['subitems'][context.subitem_index]['tags'] += ' @done'
    decorate_item(context.item, cache)
    crud.update(db, context.item)


def expand(db, context, cache):
    if 'collapse' in context.item['subitems'][context.subitem_index]:
        del context.item['subitems'][context.subitem_index]['collapse']
    decorate_item(context.item, cache)
    crud.update(db, context.item)


def collapse(db, context, cache):
    context.item['subitems'][context.subitem_index]['collapse'] = True
    decorate_item(context.item, cache)
    crud.update(db, context.item)


def delete_subitem(db, context, cache):
    indent = context.item['subitems'][context.subitem_index]['indent']
    subitems_ = context.item['subitems'][:]
    del subitems_[context.subitem_index]
    while context.subitem_index < len(subitems_) and subitems_[context.subitem_index]['indent'] > indent:
        del subitems_[context.subitem_index]
    context.item['subitems'] = subitems_
    decorate_item(context.item, cache)
    crud.delete(db, context.item)
    must_recalculate_ontology = False
    if '@implies' in context.item['subitems'][context.subitem_index]['_tags']:
        must_recalculate_ontology = True
    return must_recalculate_ontology


def update_subitem_content(db, context, cache):
    context.item['subitems'][context.subitem_index]['data'] = context.updated_content
    item = decorate_item(context.item, cache)
    cache['hash_to_item'][item['_hash']] = copy.deepcopy(item)  # because we are not sending a response
    crud.update(db, context.item)
    must_recalculate_ontology = False
    if '@implies' in context.item['subitems'][context.subitem_index]['_tags']:
        must_recalculate_ontology = True
    return must_recalculate_ontology


def move_subitem_up(db, context, cache):
    sibling_index_above = find_sibling_index_above(context.item, context.subitem_index)
    if sibling_index_above is None:
        raise Exception('cannot move subitem above a parent')
    upper_bound, lower_bound = find_subtree_bounds(context.item, context.subitem_index)
    upper_bound_above, lower_bound_above = find_subtree_bounds(context.item, sibling_index_above)
    shift_up = lower_bound_above - upper_bound_above + 1
    new_subitem_index = context.subitem_index - shift_up
    _swap_subtrees(context.item, upper_bound_above, lower_bound_above, upper_bound, lower_bound)
    decorate_item(context.item, cache)
    crud.update(db, context.item)
    new_item_subitem_id = f'{context.item["id"]}:{new_subitem_index}'
    return new_item_subitem_id


def move_subitem_down(db, context, cache):
    sibling_index_below = find_sibling_index_below(context.item, context.subitem_index)
    if sibling_index_below is None:
        raise Exception('cannot move subitem directly below an elder')
    upper_bound, lower_bound = find_subtree_bounds(context.item, context.subitem_index)
    upper_bound_below, lower_bound_below = find_subtree_bounds(context.item, sibling_index_below)
    shift_down = lower_bound_below - upper_bound_below + 1
    new_subitem_index = context.subitem_index + shift_down
    _swap_subtrees(context.item, upper_bound, lower_bound, upper_bound_below, lower_bound_below)
    decorate_item(context.item, cache)
    crud.update(db, context.item)
    new_item_subitem_id = f'{context.item["id"]}:{new_subitem_index}'
    return new_item_subitem_id


def indent(db, context, cache):
    assert context.subitem_index > 0, "cannot indent top level item"
    sibling_index_above = find_sibling_index_above(context.item, context.subitem_index)
    if sibling_index_above is None:
        raise Exception('no sibling above exists, therefore cannot indent')
    sibling_above = context.item['subitems'][sibling_index_above]
    if 'collapse' in sibling_above:
        del sibling_above['collapse']
    upper_bound, lower_bound = find_subtree_bounds(context.item, context.subitem_index)
    for i in range(upper_bound, lower_bound + 1):
        context.item['subitems'][i]['indent'] += 1
    decorate_item(context.item, cache)
    crud.update(db, context.item)


def outdent(db, context, cache):
    subitem = context.item['subitems'][context.subitem_index]
    indent = subitem['indent']
    assert indent >= 2, 'cannot outdent any further'
    if config.outdent_all_siblings_below:
        upper_bound, lower_bound = find_subtree_bounds_all_siblings_below(context.item, context.subitem_index)
    else:
        upper_bound, lower_bound = find_subtree_bounds(context.item, context.subitem_index)
    for i in range(upper_bound, lower_bound + 1):
        context.item['subitems'][i]['indent'] -= 1
    decorate_item(context.item, cache)
    crud.update(db, context.item)


def add_subitem_sibling(db, context, cache):
    indent = context.item['subitems'][context.subitem_index]['indent']
    if context.subitem_index == 0:
        # we are adding from the title row, so it always goes to a fixed indented position
        insert_at = 1
        new_indent = 1
    else:
        new_indent = indent
        upper, lower = find_subtree_bounds(context.item, context.subitem_index)
        insert_at = lower + 1
    new_subitem = generate_new_subitem(indent=new_indent, tags='')
    context.item['subitems'].insert(insert_at, new_subitem)
    decorate_item(context.item, cache)
    crud.update(db, context.item)
    new_item_subitem_id = f'{context.item["id"]}:{insert_at}'
    return new_item_subitem_id


def add_subitem_child(db, context, cache):
    insert_at = context.subitem_index + 1
    indent = context.item['subitems'][context.subitem_index]['indent'] + 1
    new_subitem = generate_new_subitem(indent=indent, tags='')
    context.item['subitems'].insert(insert_at, new_subitem)
    parent_subitem = context.item['subitems'][context.subitem_index]
    if 'collapse' in parent_subitem:
        del parent_subitem['collapse']
    decorate_item(context.item, cache)
    crud.update(db, context.item)
    new_item_subitem_id = f'{context.item["id"]}:{insert_at}'
    return new_item_subitem_id


def paste_child(db, context, cache):
    indent = context.item['subitems'][context.subitem_index]['indent']
    clip_item = context.clipboard['item']
    decorate_item(clip_item, cache)  # in case we want to inherit parent tags
    clip_subitem_index = int(context.clipboard['subitemIndex'])
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

    insertion_point = context.subitem_index + 1
    # assumption: insertion point does NOT need to account for children of our target

    # insert subitems
    # TODO use slice notation
    context.item['subitems'][insertion_point:insertion_point] = clip_subitems
    del clip_subitems

    # make sure the target subitem is not collapsed
    if 'collapse' in context.item['subitems'][context.subitem_index]:
        del context.item['subitems'][context.subitem_index]['collapse']

    # decorate
    decorate_item(context.item, cache)
    # do not need to update cache or recalculate ranks
    crud.update(db, context.item)
    new_item_subitem_id = f'{context.item["id"]}:{insertion_point}'
    return new_item_subitem_id


def update_tags(db, context, cache):
    old_tags = context.item['subitems'][context.subitem_index]['tags'].split();
    new_tags = context.updated_tags.split()
    must_recalculate_ontology = False
    if '@implies' in old_tags:
        if '@implies' not in new_tags:
            must_recalculate_ontology = True
    else:
        if '@implies' in new_tags:
            must_recalculate_ontology = True
    context.item['subitems'][context.subitem_index]['tags'] = context.updated_tags
    decorate_item(context.item, cache, dirty_edit=True, dirty_tags=True, dirty_text=False)
    crud.update(db, context.item)
    return must_recalculate_ontology


def _expand_selected_node(context):
    subitem = context.item['subitems'][context.subitem_index]
    if 'collapse' in subitem:
        del subitem['collapse']


def _expand_parents(context):
    indent = context.item['subitems'][context.subitem_index]['indent']
    for indx in range(context.subitem_index - 1, -1, -1):
        subitem_above = context.item['subitems'][indx]
        if subitem_above['indent'] < indent:
            indent = subitem_above['indent']
            if 'collapse' in subitem_above:
                del subitem_above['collapse']


def _expand_children(context):
    indent = context.item['subitems'][context.subitem_index]['indent']
    for indx in range(context.subitem_index + 1, len(context.item['subitems'])):
        subitem_below = context.item['subitems'][indx]
        if subitem_below['indent'] <= indent:
            break
        if 'collapse' in subitem_below:
            del subitem_below['collapse']


def open_to(db, context, cache):
    assert context.item is not None, 'no item selectec?'
    _expand_selected_node(context)
    _expand_parents(context)
    _expand_children(context)
    decorate_item(context.item, cache)
    crud.update(db, context.item)
