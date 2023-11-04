import time
from typing import Tuple
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
    pagination_top_item_id: int
    pagination_lowest_item_id: int
    updated_content: str


def get_request_context(request, cache):
    search_filter = request.json['searchFilter']
    state = request.json['itemsListState']
    item_subitem_id = state['selectedItemSubitemId']
    pagination_top_item_id = state['paginationTopmostItemId']
    pagination_lowest_item_id = state['paginationLowestItemId']
    if item_subitem_id is None:
        return None, None, None, search_filter
    item_id, subitem_index = map(int, item_subitem_id.split(':'))
    item = cache['id_to_item'][item_id]
    updated_content = None
    if 'updatedContent' in state:
        updated_content = state['updatedContent']
    return Context(item_subitem_id,
                   item_id,
                   item,
                   subitem_index,
                   search_filter,
                   pagination_top_item_id,
                   pagination_lowest_item_id,
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


def generic_response(cache, search_filter, new_item_subitem_id=None, extra_data=None):
    # TODO 2023.10.04 need to make this more efficient
    t1 = time.time()
    items = []
    for item in cache['items']:
        # TODO: this is inefficient
        #  Don't do this if search filter hasn't changed at all
        if filter_item_and_decorate_subitem_matches(item, search_filter):
            items.append(item)
        if len(items) >= max_results:
            # TODO: this doesn't handle pagination
            break
    t2 = time.time()
    print(f'found {len(items)} items in {((t2 - t1) * 1000):.4f} ms')
    data = {
        'items': items
    }
    if new_item_subitem_id is not None:
        data['newSelectedItemSubitemId'] = new_item_subitem_id
    if extra_data is not None:
        data.update(extra_data)
    return data
