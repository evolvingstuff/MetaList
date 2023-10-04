from bottle import Bottle, run, static_file, request
import bottle_sqlite
from utils import *


app = Bottle()
plugin = bottle_sqlite.Plugin(dbfile=db_path)
app.install(plugin)

cache = {}
diffs = []


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


@app.route('/', method="GET")
def index():
    return static_file('index.html', root='./static/html')


@app.route("/img/<filepath:path>", method="GET")
def get_img(filepath):
    response = static_file(filepath, root='static/img/')
    # Note: cache-control appears not to work for Chrome if in dev mode
    response.set_header("Cache-Control", "public, max-age=604800")
    return response


@app.route("/libs/<filepath:path>", method="GET")
def get_lib(filepath):
    return static_file(filepath, root='static/libs/')


@app.post('/toggle-todo')
def toggle_todo(db):
    global cache
    item_id, subitem_index, search_filter = get_context(request)

    item = cache['id_to_item'][item_id]
    if '@todo' in item['subitems'][subitem_index]['tags']:
        item['subitems'][subitem_index]['tags'] = item['subitems'][subitem_index]['tags'].replace('@todo', '@done')
    elif '@done' in item['subitems'][subitem_index]['tags']:
        item['subitems'][subitem_index]['tags'] = item['subitems'][subitem_index]['tags'].replace('@done', '@todo')

    decorate_item(item)
    item_copy = decorate_with_matches(item, search_filter)
    # TODO: update db
    return {
        'added_items': [],
        'deleted_items': [],
        'updated_items': [item_copy]
    }


@app.post('/toggle-outline')
def toggle_outline(db):
    global cache
    item_id, subitem_index, search_filter = get_context(request)

    item = cache['id_to_item'][item_id]
    if 'collapse' in item['subitems'][subitem_index]:
        del item['subitems'][subitem_index]['collapse']
    else:
        item['subitems'][subitem_index]['collapse'] = True

    decorate_item(item)
    item_copy = decorate_with_matches(item, search_filter)
    # TODO: update db
    return {
        'added_items': [],
        'deleted_items': [],
        'updated_items': [item_copy]
    }


@app.post('/delete-subitem')
def delete_subitem(db):
    global cache
    item_id, subitem_index, search_filter = get_context(request)
    item = cache['id_to_item'][item_id]
    if subitem_index == 0:
        del cache['id_to_item'][item_id]
        # TODO: cache['rank_to_id'] and cache['id_to_rank'] will be out of sync
        # TODO: update db
        return {
            'added_items': [],
            'deleted_items': [item],
            'updated_items': []
        }
    else:
        indent = item['subitems'][subitem_index]['indent']
        subitems_ = item['subitems'][:]
        del subitems_[subitem_index]
        while subitem_index < len(subitems_) and subitems_[subitem_index]['indent'] > indent:
            del subitems_[subitem_index]
        item['subitems'] = subitems_
        decorate_item(item)
        item_copy = decorate_with_matches(item, search_filter)
        # TODO: update db
        return {
            'added_items': [],
            'deleted_items': [],
            'updated_items': [item_copy]
        }


@app.post('/update-subitem-content')
def update_subitem_content(db):
    global cache
    item_subitem_id = request.json['itemSubitemId']
    item_id, subitem_index = map(int, item_subitem_id.split(':'))
    content = request.json['content']
    item = cache['id_to_item'][item_id]
    item['subitems'][subitem_index]['data'] = content
    decorate_item(item)
    # item_copy = decorate_with_matches(item, search_filter)  # TODO: this part we don't want immediate update on
    # because what if text changes while typing and it is now longer no longer included in search?
    item_copy = copy_item_for_client(item)
    # TODO: update db
    return {
        'added_items': [],
        'deleted_items': [],
        'updated_items': [item_copy]
    }


@app.post('/search')
def search(db):
    global cache
    t1 = time.time()
    search_filter = request.json['filter']
    show_more_results = request.json['show_more_results']
    if show_more_results:
        print(f'show_more_results: {show_more_results}')
    print(f'search_filter: {search_filter}')
    items = []
    for id in cache['id_to_item'].keys():
        item = cache['id_to_item'][id]
        item_copy = copy_item_for_client(item)
        at_least_one_match = False
        for subitem in item_copy['subitems']:
            if test_filter_against_subitem(subitem, search_filter):
                subitem['_match'] = True
                at_least_one_match = True
        if at_least_one_match:
            items.append(item_copy)
    total_results = len(items)
    items.sort(key=lambda x: cache['id_to_rank'][x['id']])
    if not show_more_results:
        items = items[:max_results]  # TODO need dynamic pagination
    for item in items:
        propagate_matches(item)
    t2 = time.time()
    print(f'found {len(items)} items in {((t2 - t1) * 1000):.4f} ms')
    return {
        'items': items,
        'total_results': total_results
    }


if __name__ == '__main__':
    initialize_cache(cache)
    run(app)
