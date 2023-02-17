import time, json, re
from bottle import Bottle, run, static_file, request
import bottle_sqlite
import sqlite3
import hashlib


app = Bottle()
db_path = 'metalist.2.0.db'  # TODO from root or somewhere else
plugin = bottle_sqlite.Plugin(dbfile=db_path)
app.install(plugin)

# TODO use a better regex for this. For example, this will not work for &nbsp; and other html entities
re_clean_tags = re.compile('<.*?>|&([a-z0-9]+|#[0-9]{1,6}|#x[0-9a-f]{1,6});')

use_cache = True
cache = {}

max_results = 100  # TODO need dynamic pagination


def _initialize_cache():
    global cache
    cache['id_to_rank'] = {}
    cache['rank_to_id'] = {}
    cache['id_to_item'] = {}
    cache['search_filter'] = {}
    t1 = time.time()
    db = sqlite3.connect(db_path)
    rows = db.execute('SELECT * from items ORDER BY id DESC').fetchall()
    head, tail = None, None
    for row in rows:
        id, value = row[0], row[1]
        item = json.loads(value)
        if item['prev'] is None:
            head = item
        if item['next'] is None:
            tail = item
        # TODO this is inefficient, need to use deepcopy or something
        cache['id_to_item'][id] = decorate_item(item)
    assert head and tail, 'did not find head and tail'

    # calculate item ranks
    node = head
    rank = 1
    while True:
        id = node['id']
        cache['id_to_rank'][id] = rank
        cache['rank_to_id'][rank] = id
        if node['next'] is None:
            break
        node = cache['id_to_item'][node['next']]
        rank += 1
    assert rank == len(rows), 'rank != len(rows)'

    t2 = time.time()
    print(f'warmed up {len(rows)} items in {((t2-t1)*1000):.2f} ms')

# TODO handle cache control for static files
# https://stackoverflow.com/questions/24672996/python-bottle-and-cache-control

@app.route("/tests/<filepath:path>", method="GET")
def get_tests(filepath):
    return static_file(filepath, root='static/tests/')


@app.route("/js/<filepath:re:.*\.js>", method="GET")
def get_js(filepath):
    return static_file(filepath, root='static/js/')


@app.route("/components/<filepath:re:.*\.js>", method="GET")
def get_components(filepath):
    return static_file(filepath, root='static/components/')


@app.route("/css/<filepath:re:.*\.css>", method="GET")
def get_css(filepath):
    return static_file(filepath, root='static/css/')


@app.route("/<filepath:re:.*\.html>", method="GET")
def get_html(filepath):
    return static_file(filepath, root='static/html/')


@app.route("/img/<filepath:path>", method="GET")
def get_html(filepath):
    response = static_file(filepath, root='static/img/')
    # Note: cache-control appears not to work for Chrome if in dev mode
    response.set_header("Cache-Control", "public, max-age=604800")
    return response


@app.route("/libs/<filepath:path>", method="GET")
def get_lib(filepath):
    return static_file(filepath, root='static/libs/')


@app.post('/search')
def search(db):
    global cache
    t1 = time.time()
    search_filter = request.json['filter']
    show_more_results = request.json['show_more_results']
    print(f'show_more_results: {show_more_results}')
    hash_search_filter = hashlib.md5(json.dumps(search_filter).encode("utf-8")).hexdigest()  # TODO is this deterministic?
    print(f'search_filter: {search_filter}')
    print(f'hash: {hash_search_filter}')
    if use_cache:
        if hash_search_filter in cache['search_filter']:
            # TODO need to check if cache is stale
            # this should really help with the infinite scroll results
            print('using cached results')
            items = cache['search_filter'][hash_search_filter]
        else:
            items = []
            for id in sorted(cache['id_to_item'].keys()):
                item = cache['id_to_item'][id]
                at_least_one_match = False
                for subitem in item['subitems']:
                    if do_include_subitem(subitem, search_filter):
                        at_least_one_match = True
                        break
                if at_least_one_match:
                    items.append(item)
            cache['search_filter'][hash_search_filter] = items
        total_results = len(items)
        items.sort(key=lambda x: cache['id_to_rank'][x['id']])
        if not show_more_results:
            items = items[:max_results]  # TODO need dynamic pagination
        t2 = time.time()
        print(f'found {len(items)} items in {((t2 - t1) * 1000):.4f} ms')
    else:
        # TODO test fetchall vs fetchmany vs fetchone for performance
        rows = db.execute('SELECT * from items ORDER BY id DESC').fetchall()
        items = []
        total_results = 0
        for row in rows:
            item = json.loads(row['value'])
            decorate_item(item)
            at_least_one_match = False
            for subitem in item['subitems']:
                if do_include_subitem(subitem, search_filter):
                    at_least_one_match = True
                    break
            if at_least_one_match:
                items.append(item)
                if len(items) >= max_results:
                    break
        raise NotImplementedError('TODO: need to sort items by rank')
        total_results = len(items)
        if not show_more_results:
            items = items[:max_results]  # TODO need dynamic pagination
        t2 = time.time()
        print(f'found {len(items)} items in {((t2-t1)*1000):.4f} ms')
        for item in items:
            clean_item(item)
    return {'items': items, 'total_results': total_results}


def decorate_item(item):
    parent_stack = []
    for subitem in item['subitems']:
        clean_text = re_clean_tags.sub('', subitem['data'])
        subitem['_clean_text'] = clean_text.lower()  # TODO what strategy to use for case sensitivity?
        subitem['_tags'] = [t.strip() for t in subitem['tags'].split(' ')]
        if len(parent_stack) > 0:
            while parent_stack[-1]['indent'] >= subitem['indent']:
                parent_stack.pop()
            if len(parent_stack) > 0:
                assert int(parent_stack[-1]['indent']) == int(subitem['indent']) - 1
            for parent in parent_stack:
                non_special_tags = [t for t in parent['_tags'] if not t.startswith('@')]
                for tag in non_special_tags:
                    if tag not in subitem['_tags']:
                        subitem['_tags'].append(tag)
        parent_stack.append(subitem)
    return item


# def clean_item(item):
#     # TODO cache some of this
#     for subitem in item['subitems']:
#         del subitem['_clean_text']
#         del subitem['_tags']


def do_include_subitem(subitem, search_filter):

    # TODO this doesn't yet hide @implies subitems
    # TODO do set operations for tags

    if len(search_filter['tags']) == 0 and \
            len(search_filter['texts']) == 0 and \
            search_filter['partial_text'] is None and \
            search_filter['partial_tag'] is None and \
            len(search_filter['negated_tags']) == 0 and \
            len(search_filter['negated_texts']) == 0 and \
            search_filter['negated_partial_text'] is None and \
            search_filter['negated_partial_tag'] is None:
        return True

    subitem_text = subitem['_clean_text']
    subitem_tags = subitem['_tags']

    # remove positives first, because this narrows down the search space fastest
    # TODO: could order these by frequency, ascending
    if search_filter['partial_text'] is not None and \
            search_filter['partial_text'].lower() not in subitem_text:  # TODO what strategy to use for case sensitivity?
        return False
    if search_filter['partial_tag'] is not None:
        one_match = False
        for subitem_tag in subitem_tags:
            if subitem_tag.startswith(search_filter['partial_tag']):
                one_match = True
                break
        if not one_match:
            return False
    for required_tag in search_filter['tags']:
        if required_tag not in subitem_tags:
            return False
    for required_text in search_filter['texts']:
        if required_text.lower() not in subitem_text:  # TODO what strategy to use for case sensitivity?
            return False

    # then check for negatives after, because these are less likely to be true
    # TODO: could order these by frequency, descending
    if search_filter['negated_partial_tag'] is not None:
        for subitem_tag in subitem_tags:
            if subitem_tag.startswith(search_filter['negated_partial_tag']):
                return False
    if search_filter['negated_partial_text'] is not None and \
            search_filter['negated_partial_text'].lower() in subitem_text:  # TODO what strategy to use for case sensitivity?
        return False
    for negated_tag in search_filter['negated_tags']:
        if negated_tag in subitem_tags:
            return False
    for negated_text in search_filter['negated_texts']:
        if negated_text.lower() in subitem_text:  # TODO what strategy to use for case sensitivity?
            return False

    return True


if __name__ == '__main__':
    if use_cache:
        _initialize_cache()
    else:
        print('no cache')
    run(app)
