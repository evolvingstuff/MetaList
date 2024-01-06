import copy
import time
import tqdm
from metalist import config
from metalist.utils.decorate_single_item import decorate_item
from metalist.utils.find import find_prev_visible_item, find_next_visible_item
from metalist.utils.generate import generate_unplaced_new_item
from metalist.utils.ontology import extract_ontology, propagate_implications
from metalist.utils.snapshots import Snapshots, Snapshot
from metalist.utils.server import Context
from metalist.utils import crud


def undo(db, snapshots: Snapshots, cache):
    snapshot: Snapshot = snapshots.undo()
    assert snapshot is not None, 'nothing to undo'
    hashes_to_remove = snapshot.post.item_hashes - snapshot.pre.item_hashes
    for h in hashes_to_remove:
        item = cache['hash_to_item'][h]
        assert item['_hash'] == h
        assert item['id'] in cache['id_to_item']
        del cache['id_to_item'][item['id']]
        cache['search_index'].remove_item(item)
        crud.delete(db, item)  # TODO: eventually do updates for existing
    hashes_to_add = snapshot.pre.item_hashes - snapshot.post.item_hashes
    for h in hashes_to_add:
        item = cache['hash_to_item'][h]
        assert item['_hash'] == h
        assert item['id'] not in cache['id_to_item']
        cache['id_to_item'][item['id']] = copy.deepcopy(item)
        cache['search_index'].add_item(item)
        crud.create(db, item)  # TODO: eventually do updates for existing
    return snapshot.pre.item_subitem_id


def redo(db, snapshots, cache):
    snapshot: Snapshot = snapshots.redo()
    assert snapshot is not None, 'nothing to redo'
    hashes_to_remove = snapshot.pre.item_hashes - snapshot.post.item_hashes
    for h in hashes_to_remove:
        item = cache['hash_to_item'][h]
        assert item['_hash'] == h
        assert item['id'] in cache['id_to_item']
        del cache['id_to_item'][item['id']]
        cache['search_index'].remove_item(item)
        crud.delete(db, item)  # TODO: eventually do updates for existing
    hashes_to_add = snapshot.post.item_hashes - snapshot.pre.item_hashes
    for h in hashes_to_add:
        item = cache['hash_to_item'][h]
        assert item['_hash'] == h
        assert item['id'] not in cache['id_to_item']
        cache['id_to_item'][item['id']] = copy.deepcopy(item)
        cache['search_index'].add_item(item)
        crud.create(db, item)  # TODO: eventually do updates for existing
    return snapshot.post.item_subitem_id


def remove_item(db, cache, context: Context):
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
            decorate_item(prev_item, cache, dirty_tags=False)
            crud.update(db, prev_item)
        if next_item is not None:
            if prev_item is None:
                next_item['prev'] = None
            else:
                next_item['prev'] = prev_item['id']
            decorate_item(next_item, cache, dirty_tags=False)
            crud.update(db, next_item)
    del cache['id_to_item'][context.item['id']]
    crud.delete(db, context.item)
    cache['search_index'].remove_item(context.item)
    must_recalculate_ontology = False
    if '@implies' in context.item['_tags']:
        must_recalculate_ontology = True
    return must_recalculate_ontology


def _insert_above_item(db, cache, item_to_insert, item_below):
    item_above = None
    if item_below['prev'] is not None:
        item_above = cache['id_to_item'][item_below['prev']]
    _insert_between_items(db, cache, item_to_insert, item_above, item_below)


def _insert_below_item(db, cache, item_to_insert, item_above):
    item_below = None
    if item_above['next'] is not None:
        item_below = cache['id_to_item'][item_above['next']]
    _insert_between_items(db, cache, item_to_insert, item_above, item_below)


def _insert_between_items(db, cache, item_to_insert, prev_item, next_item):
    if prev_item is None:
        item_to_insert['prev'] = None
    else:
        prev_item['next'] = item_to_insert['id']
        item_to_insert['prev'] = prev_item['id']
        decorate_item(prev_item, cache, dirty_tags=False)
        crud.update(db, prev_item)
    if next_item is None:
        item_to_insert['next'] = None
    else:
        next_item['prev'] = item_to_insert['id']
        item_to_insert['next'] = next_item['id']
        decorate_item(next_item, cache, dirty_tags=False)
        crud.update(db, next_item)
    cache['id_to_item'][item_to_insert['id']] = item_to_insert
    decorate_item(item_to_insert, cache, dirty_tags=False)
    crud.update(db, item_to_insert)


def move_item_up(db, cache, context):
    above = find_prev_visible_item(cache, context.item, context.search_filter)
    if above is not None:
        remove_item(db, cache, context)
        _insert_above_item(db, cache, context.item, above)


def move_item_down(db, cache, context):
    below = find_next_visible_item(cache, context.item, context.search_filter)
    if below is not None:
        remove_item(db, cache, context)
        _insert_below_item(db, cache, context.item, below)


def add_item_sibling(db, cache, context):
    new_item = generate_unplaced_new_item(cache, context.search_filter)
    cache['id_to_item'][new_item['id']] = new_item
    crud.create(db, new_item)
    _insert_below_item(db, cache, new_item, context.item)
    decorate_item(new_item, cache)
    crud.update(db, new_item)
    new_item_subitem_id = f'{new_item["id"]}:0'
    return new_item_subitem_id


def add_item_top(db, cache, context):
    new_item = generate_unplaced_new_item(cache, context.search_filter)
    crud.create(db, new_item)
    if config.always_add_to_global_top:
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
            decorate_item(old_head, cache)
            crud.update(db, old_head)
    else:
        raise NotImplementedError
    decorate_item(new_item, cache)
    crud.update(db, new_item)
    cache['id_to_item'][new_item['id']] = new_item
    new_item_subitem_id = f'{new_item["id"]}:0'
    return new_item_subitem_id


def paste_sibling(db, cache, context):
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
    decorate_item(clip_item, cache)  # in case we want to inherit parent tags
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
        crud.create(db, new_item)
        _insert_below_item(db, cache, new_item, item)
        # decorate_item(new_item, cache)
        # crud.update(db, new_item)
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
        decorate_item(new_item, cache)
        crud.update(db, new_item)
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
        decorate_item(item, cache)
        crud.update(db, item)
        new_item_subitem_id = f'{item["id"]}:{initial_insertion_point}'

        return new_item_subitem_id


def recalculate_ontology(db, cache: dict, context):
    if config.development_mode:
        print('----------------------------------')
        print('RECALCUATING ONTOLOGY')
        print('----------------------------------')
    cache['ontology'] = dict()
    cache['implications'] = dict()
    # TODO: more efficient by just adding or removing the single rule just changed
    t1 = time.time()
    for item in cache['id_to_item'].values():
        extract_ontology(cache, item)
    propagate_implications(cache)
    t2 = time.time()
    if config.development_mode:
        print(f'recalculating ontology took {(t2 - t1):.6f} seconds')
    t1 = time.time()
    # TODO: this could be made more efficient by only updating affected items
    tot_updated = 0
    for item in tqdm.tqdm(cache['id_to_item'].values()):
        prev_hash = item['_hash']
        item = decorate_item(item, cache, dirty_edit=False, dirty_text=False, dirty_tags=True)
        next_hash = item['_hash']
        if prev_hash != next_hash:
            # crud.update(db, item)  TODO: do we even need to update database here?
            cache['id_to_item'][item['id']] = copy.deepcopy(item)
            cache['hash_to_item'][item['_hash']] = copy.deepcopy(item)
            tot_updated += 1
    t2 = time.time()
    if config.development_mode:
        print(f'decorating items took {(t2-t1):.6f} seconds. {tot_updated} updated items')
