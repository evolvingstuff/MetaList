import time
from utils.decorate_single_item import filter_item_and_decorate_subitem_matches
from dataclasses import dataclass


@dataclass
class Context:
    item_subitem_id: str
    item_id: int
    item: dict
    subitem_index: int
    search_filter: str
    total_items_to_return: int
    updated_content: str
    updated_tags: str
    clipboard: dict


def get_request_context(request, cache):
    state = request.json['appState']
    search_filter = state['searchFilter']
    updated_content = None
    updated_tags = None
    clipboard = None
    item_subitem_id = state['selectedItemSubitemId']
    total_items_to_return = state['totalItemsToReturn']
    if 'updatedContent' in state:
        updated_content = state['updatedContent']
    if 'updatedTags' in state:
        updated_tags = state['updatedTags']
    if 'clipboard' in state:
        clipboard = state['clipboard']
    # else:
    #     item_subitem_id = None
    #     total_items_to_return = 50  # TODO: config
    if item_subitem_id is not None:
        item_id, subitem_index = map(int, item_subitem_id.split(':'))
        item = cache['id_to_item'][item_id]
    else:
        subitem_index, item_id, item = None, None, None
    return Context(item_subitem_id,
                   item_id,
                   item,
                   subitem_index,
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
    print(f'NOOP: {message}')
    return {
        'noop': message
    }


def generic_response(cache, context: Context, new_item_subitem_id):
    t1 = time.time()
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
