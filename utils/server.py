import time
from dataclasses import dataclass
from utils.decorate_single_item import filter_item_and_decorate_subitem_matches
from utils.snapshots import Snapshot


simulated_lag_seconds = None


@dataclass
class Context:
    app_state: dict
    item_subitem_id: str = None
    item_id: int = 0
    item: dict = None
    subitem_index: int = 0
    search_filter: dict = None
    total_items_to_return: int = 50
    updated_content: str = None
    updated_tags: str = None
    clipboard: dict = None
    topmost_visible_item_subitem_id: str = None
    topmost_pixel_offset: int = 0


def get_request_context(request, cache):
    state = request.json['appState']
    search_filter = state['searchFilter']
    updated_content = None
    updated_tags = None
    clipboard = None
    item_subitem_id = state['selectedItemSubitemId']
    total_items_to_return = state['totalItemsToReturn']
    topmost_visible_item_subitem_id = state['topmostVisibleItemSubitemId']
    topmost_pixel_offset = state['topmostPixelOffset']
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
                   search_filter,
                   total_items_to_return,
                   updated_content,
                   updated_tags,
                   clipboard,
                   topmost_visible_item_subitem_id,
                   topmost_pixel_offset)


def error_response(message):
    print(f'ERROR: {message}')
    return {
        'error': message
    }


def noop_response(message):
    print(f'NOOP: {message}')
    return {
        'noop': message
    }


def generic_response(snapshots, cache, context: Context, new_item_subitem_id):
    snapshots.show()
    t1 = time.time()
    if simulated_lag_seconds is not None and simulated_lag_seconds > 0:
        print(f'simulating lag of {simulated_lag_seconds} seconds')
        time.sleep(simulated_lag_seconds)
    items = []
    total_precomputed = 0
    total_processed = 0
    reached_scroll_end = True
    for item in cache['items']:
        # TODO: this is inefficient
        if '_computed' in item and '_match' in item['subitems'][0]:
            items.append(item)
            total_precomputed += 1
        elif filter_item_and_decorate_subitem_matches(item, context.search_filter):
            items.append(item)
            total_processed += 1
        if len(items) > context.total_items_to_return:
            items = items[:context.total_items_to_return]
            reached_scroll_end = False
            break
    t2 = time.time()
    print(f'retrieved {total_precomputed} precomputed and {total_processed} processed items in {((t2 - t1) * 1000):.4f} ms')
    data = {
        'items': items,
        'newSelectedItemSubitemId': new_item_subitem_id,
        'reachedScrollEnd': reached_scroll_end
    }
    return data
