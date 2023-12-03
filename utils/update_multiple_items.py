import copy
from config.config import always_add_to_global_top
from utils.decorate_single_item import decorate_item
from utils.find import find_prev_visible_item, find_next_visible_item
from utils.generate import generate_unplaced_new_item
from utils.snapshots import Snapshot
from utils.server import Context


def undo(snapshots, cache):
    snapshot = snapshots.undo()
    assert snapshot is not None, 'nothing to undo'
    if len(snapshot.pre_op_items) == len(snapshot.post_op_items) == 1:
        if snapshot.pre_op_items[0]['id'] != snapshot.post_op_items[0]['id']:
            raise NotImplementedError('TODO: different pre/post ids')
        pre_op_item = snapshot.pre_op_items[0]
        item_id = pre_op_item['id']
        cache['id_to_item'][item_id] = pre_op_item
        decorate_item(pre_op_item)
    else:
        raise NotImplementedError('TODO: more than just update a single item')
    return snapshot.pre_op_selected_item_subitem_id


def redo(snapshots, cache):
    snapshot = snapshots.redo()
    assert snapshot is not None, 'nothing to redo'
    if len(snapshot.pre_op_items) == len(snapshot.post_op_items) == 1:
        if snapshot.pre_op_items[0]['id'] != snapshot.post_op_items[0]['id']:
            raise NotImplementedError('TODO: different pre/post ids')
        post_op_item = snapshot.post_op_items[0]
        item_id = post_op_item['id']
        cache['id_to_item'][item_id] = post_op_item
        decorate_item(post_op_item)
    else:
        raise NotImplementedError('TODO: more than just update a single item')
    print(f'debug: redo() post selected: {snapshot.post_op_selected_item_subitem_id}')
    return snapshot.post_op_selected_item_subitem_id


def remove_item(snapshots, cache, context: Context, update_snapshot=True):
    pre_op_item = copy.deepcopy(context.item)
    # TODO: write unit test for this
    if len(cache['id_to_item'].keys()) > 1:  # otherwise no need to rewrite references
        prev_item = None
        if context.item['prev'] is not None:
            prev_item = cache['id_to_item'][context.item['prev']]
        next_item = None
        if context.item['next'] is not None:
            next_item = cache['id_to_item'][context.item['next']]
        if prev_item is not None:
            if next_item is None:
                prev_item['next'] = None
            else:
                prev_item['next'] = next_item['id']
            decorate_item(prev_item)
        if next_item is not None:
            if prev_item is None:
                next_item['prev'] = None
            else:
                next_item['prev'] = prev_item['id']
            decorate_item(next_item)
    del cache['id_to_item'][context.item['id']]
    if update_snapshot:
        # TODO: update db
        snapshots.push(Snapshot('remove_item',
                                context.app_state,
                                context.item_subitem_id,
                                None,
                                pre_op_items=[pre_op_item],
                                post_op_items=[]))


def _insert_above_item(cache, item_to_insert, item_below):
    item_above = None
    if item_below['prev'] is not None:
        item_above = cache['id_to_item'][item_below['prev']]
    _insert_between_items(cache, item_to_insert, item_above, item_below)


def _insert_below_item(cache, item_to_insert, item_above):
    item_below = None
    if item_above['next'] is not None:
        item_below = cache['id_to_item'][item_above['next']]
    _insert_between_items(cache, item_to_insert, item_above, item_below)


def _insert_between_items(cache, item_to_insert, prev_item, next_item):
    if prev_item is None:
        item_to_insert['prev'] = None
    else:
        prev_item['next'] = item_to_insert['id']
        item_to_insert['prev'] = prev_item['id']
        decorate_item(prev_item)
    if next_item is None:
        item_to_insert['next'] = None
    else:
        next_item['prev'] = item_to_insert['id']
        item_to_insert['next'] = next_item['id']
        decorate_item(next_item)
    cache['id_to_item'][item_to_insert['id']] = item_to_insert
    decorate_item(item_to_insert)
    # TODO: update db


def move_item_up(snapshots, cache, context):
    above = find_prev_visible_item(cache, context.item, context.search_filter)
    if above is not None:
        remove_item(snapshots, cache, context, update_snapshot=False)
        _insert_above_item(cache, context.item, above)
    # TODO update db
    snapshots.push(Snapshot('move_item_up TODO', context.app_state))


def move_item_down(snapshots, cache, context):
    below = find_next_visible_item(cache, context.item, context.search_filter)
    if below is not None:
        remove_item(snapshots, cache, context, update_snapshot=False)
        _insert_below_item(cache, context.item, below)
    # TODO update db
    snapshots.push(Snapshot('move_item_down TODO', context.app_state))


def add_item_sibling(snapshots, cache, context):
    new_item = generate_unplaced_new_item(cache, context.search_filter)
    _insert_below_item(cache, new_item, context.item)
    decorate_item(new_item)
    cache['id_to_item'][new_item['id']] = new_item
    # TODO update db
    snapshots.push(Snapshot('add_item_sibling TODO', context.app_state))
    new_item_subitem_id = f'{new_item["id"]}:0'
    return new_item_subitem_id


def add_item_top(snapshots, cache, context):
    new_item = generate_unplaced_new_item(cache, context.search_filter)
    if always_add_to_global_top:
        if len(cache['id_to_item'].keys()) == 0:
            new_item['prev'] = None
            new_item['next'] = None
        else:
            old_head = None
            for item in cache['id_to_item'].values():
                if item['prev'] is None:
                    old_head = item
                    break
            assert old_head is not None
            new_item['prev'] = None
            new_item['next'] = old_head['id']
            old_head['prev'] = new_item['id']
            decorate_item(old_head, 'old_head')
    else:
        raise NotImplementedError
    decorate_item(new_item, 'new_item')
    cache['id_to_item'][new_item['id']] = new_item
    # TODO update db
    snapshots.push(Snapshot('add_item_top TODO', context.app_state))
    new_item_subitem_id = f'{new_item["id"]}:0'
    return new_item_subitem_id


def paste_sibling(snapshots, cache, context):
    """
    TODO: this should be broken out into two functions, at least
    """
    search_filter = context.search_filter
    item = context.item
    pre_op_item = copy.deepcopy(item)
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
        _insert_below_item(cache, new_item, item)
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
        # TODO update db
        snapshots.push(Snapshot('paste_sibling1 TODO', context.app_state))
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
        post_op_item = copy.deepcopy(item)
        new_item_subitem_id = f'{item["id"]}:{initial_insertion_point}'
        snapshots.push(Snapshot('paste_sibling2',
                                context.app_state,
                                context.item_subitem_id,
                                new_item_subitem_id,
                                pre_op_items=[pre_op_item],
                                post_op_items=[post_op_item]))

        return new_item_subitem_id
