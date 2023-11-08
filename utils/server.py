import time
from config.config import *
from utils.decorate_single_item import filter_item_and_decorate_subitem_matches
from dataclasses import dataclass


@dataclass
class Context:
    item_subitem_id: str
    item_id: int
    item: dict
    subitem_index: int
    search_filter: str
    items_to_return: int
    updated_content: str


def get_request_context(request, cache):
    search_filter = request.json['searchFilter']
    state = request.json['itemsListState']
    item_subitem_id = state['selectedItemSubitemId']
    items_to_return = state['itemsToReturn']
    if item_subitem_id is not None:
        item_id, subitem_index = map(int, item_subitem_id.split(':'))
        item = cache['id_to_item'][item_id]
    else:
        subitem_index, item_id, item = None, None, None
    updated_content = None
    if 'updatedContent' in state:
        updated_content = state['updatedContent']
    return Context(item_subitem_id,
                   item_id,
                   item,
                   subitem_index,
                   search_filter,
                   items_to_return,
                   updated_content)


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


def generic_response(cache, context: Context, new_item_subitem_id, extra_data=None):
    t1 = time.time()
    items = []
    total_precomputed = 0
    total_processed = 0
    for item in cache['items']:
        # TODO: this is inefficient
        #  Don't do this if search filter hasn't changed at all
        if '_computed' in item and '_match' in item['subitems'][0]:
            items.append(item)
            total_precomputed += 1
        elif filter_item_and_decorate_subitem_matches(item, context.search_filter):
            items.append(item)
            total_processed += 1
        if len(items) >= context.items_to_return:
            break
    t2 = time.time()
    print(f'retrieved {total_precomputed} precomputed and {total_processed} processed items in {((t2 - t1) * 1000):.4f} ms')
    data = {
        'items': items,
        'newSelectedItemSubitemId': new_item_subitem_id
    }
    if extra_data is not None:
        data.update(extra_data)
    return data
