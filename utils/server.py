import time
from typing import Tuple
from config.config import *
from utils.decorate_single_item import filter_item_and_decorate_subitem_matches


def get_request_context(request) -> Tuple[int, int, str]:
    search_filter = request.json['searchFilter']
    item_subitem_id = request.json['itemSubitemId']
    if item_subitem_id is None:
        return None, None, None, search_filter
    item_id, subitem_index = map(int, item_subitem_id.split(':'))
    return item_subitem_id, item_id, subitem_index, search_filter


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


def generic_response(cache, search_filter, extra_data=None):
    # TODO 2023.10.04 need to make this more efficient
    t1 = time.time()
    items = []
    for item in cache['items']:
        # TODO: this is inefficient
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
    if extra_data is not None:
        data.update(extra_data)
    return data
