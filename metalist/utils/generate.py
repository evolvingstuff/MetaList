import time


def generate_timestamp():
    return int(round(time.time() * 1000))


def generate_new_subitem(indent, tags=''):
    return {
        'data': '',
        'tags': tags,
        'indent': indent
    }


def generate_unplaced_new_item(cache, search_filter):
    # find highest id
    # TODO: keep ref to this
    max_id = 0
    for item in cache['id_to_item'].values():  # TODO make more efficient
        max_id = max(max_id, item['id'])
    new_id = max_id + 1

    # generate new item
    now = generate_timestamp()
    tags = ' '.join(search_filter['tags']).strip()
    if search_filter['partial_tag'] is not None:
        tags = (tags + ' ' + search_filter['partial_tag']).strip()
    new_subitem = generate_new_subitem(indent=0, tags=tags)
    new_item = {
        'id': new_id,
        'creation': now,
        'last_edit': now,
        'prev': -1,
        'next': -1,
        'char_count': 0,
        'subitems': [new_subitem]
    }
    return new_item
