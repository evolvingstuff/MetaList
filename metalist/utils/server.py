import copy
import time
from dataclasses import dataclass
from metalist.config import development_mode, simulated_lag_seconds
from metalist.utils.decorate_single_item import calculate_matches, hash_dictionary


prev_sorting_order = None


@dataclass
class Context:
    app_state: dict
    item_subitem_id: str = None
    item_id: int = 0
    item: dict = None
    subitem_index: int = 0
    search_text: str = None
    search_filter: dict = None
    total_items_to_return: int = 50
    updated_content: str = None
    updated_tags: str = None
    clipboard: dict = None


def get_request_context(request, cache):
    state = request.json['appState']
    search_text = state['searchText']
    search_filter = state['searchFilter']
    updated_content = None
    updated_tags = ''
    clipboard = None
    item_subitem_id = state['selectedItemSubitemId']
    total_items_to_return = state['totalItemsToReturn']
    if 'updatedContent' in state:
        updated_content = state['updatedContent']
    if 'updatedTags' in state:
        updated_tags = state['updatedTags']
    if 'clipboard' in state:
        clipboard = state['clipboard']
    if item_subitem_id is not None:
        item_id, subitem_index = map(int, item_subitem_id.split(':'))
        item = cache['id_to_item'][item_id]
    else:
        subitem_index, item_id, item = None, None, None
    return Context(state,
                   item_subitem_id,
                   item_id,
                   item,
                   subitem_index,
                   search_text,
                   search_filter,
                   total_items_to_return,
                   updated_content,
                   updated_tags,
                   clipboard)


def error_response(message):
    print(f'ERROR: {message}')
    return {
        'error': message
    }


def noop_response(message):
    if development_mode:
        print(f'NOOP: {message}')
    return {
        'noop': message
    }


def recalculate_item_ranks(cache, dirty_rank):
    global prev_sorting_order

    if len(cache['id_to_item']) == 0:
        if development_mode:
            print('no items to rank')
        return []

    sorted_items = list()
    t1 = time.time()

    if not dirty_rank and prev_sorting_order is not None:
        if development_mode:
            print('using previous sorting order')
        # TODO this could be more efficient
        for id in prev_sorting_order:
            node = cache['id_to_item'][id]
            sorted_items.append(node)
    else:
        if development_mode:
            print('dirty_rank == True')
        if len(cache['id_to_item']) == 0:
            raise NotImplementedError('does not account for no items')
        head = None
        for item in cache['id_to_item'].values():
            if item['prev'] is None:
                head = item
                break
        if head is None:
            raise Exception('no head node')
        node = head
        prev_sorting_order = list()
        while True:
            sorted_items.append(node)
            prev_sorting_order.append(node['id'])
            if node['next'] is None:
                break
            node = cache['id_to_item'][node['next']]
        assert len(sorted_items) == len(cache['id_to_item']), f'mismatch when calculating item ranks, location 2: {len(sorted_items)} vs {len(cache["id_to_item"])}'
        assert len(prev_sorting_order) == len(sorted_items), f'mismatch with prev_sorting_order'
    t2 = time.time()
    if development_mode:
        print(f're/calculating item ranks took {((t2-t1)*1000):.2f} ms')
    return sorted_items


def filter_items(cache, context, updated_search=False, dirty_ranking=False):

    t1 = time.time()
    if development_mode and simulated_lag_seconds is not None and simulated_lag_seconds > 0:
        print(f'simulating lag of {simulated_lag_seconds} seconds')
        time.sleep(simulated_lag_seconds)
    filtered_items = []
    total_precomputed = 0
    total_processed = 0
    reached_scroll_end = True

    sorted_items = recalculate_item_ranks(cache, dirty_ranking)

    if updated_search:
        if development_mode:
            print('updated search, therefore all item matches are dirty')
        for item in sorted_items:
            item['_dirty_matches'] = True

    for item in sorted_items:  # are these ALL items?

        #asdfasdf
        # # 2024.01.02: is there a bug here?
        if '_dirty_matches' in item:
            if calculate_matches(item, context.search_filter):
                filtered_items.append(item)
                total_processed += 1
        else:
            if '_match' in item['subitems'][0]:
                filtered_items.append(item)
                total_precomputed += 1

        # # _dirty_matches is a problem?
        # if calculate_matches(item, context.search_filter):
        #     filtered_items.append(item)
        #     total_processed += 1

        if item['_hash'] not in cache['hash_to_item']:
            cache['hash_to_item'][item['_hash']] = copy.deepcopy(item)

        if len(filtered_items) > context.total_items_to_return:
            filtered_items = filtered_items[:context.total_items_to_return]
            reached_scroll_end = False
            break

    t2 = time.time()
    if development_mode:
        print(
            f'retrieved {total_precomputed} precomputed items and {total_processed} processed items in {((t2 - t1) * 1000):.4f} ms')
        for indx, item in enumerate(filtered_items[:5]):
            print(f'\t[{indx+1}] {item["id"]} | {item["subitems"][0]["_searchable_text"][:50]}')
        if len(filtered_items) > 5:
            print(f'\t...')
    return filtered_items, reached_scroll_end


def generic_response(filtered_items, reached_scroll_end, new_item_subitem_id, extra_data: dict = None):
    data = {
        'items': filtered_items,
        'newSelectedItemSubitemId': new_item_subitem_id,
        'reachedScrollEnd': reached_scroll_end
    }
    if extra_data is not None:
        data.update(extra_data)
    return data
