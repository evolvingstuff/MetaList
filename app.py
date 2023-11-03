from bottle import Bottle, run, static_file, request
import bottle_sqlite
from config.config import db_path
from utils.server import get_request_context, generic_response, noop_response, error_response
from utils.update_multiple_items import remove_item, initialize_cache
from utils.update_single_item import swap_subtrees

import utils

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
    item_subitem_id, item_id, subitem_index, search_filter = get_request_context(request)
    item = cache['id_to_item'][item_id]
    utils.update_single_item.toggle_todo(item, subitem_index)
    return generic_response(cache, search_filter)


@app.post('/toggle-outline')
def toggle_outline(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_request_context(request)
    item = cache['id_to_item'][item_id]
    utils.update_single_item.toggle_outline(item, subitem_index)
    return generic_response(cache, search_filter)


@app.post('/delete-subitem')
def delete_subitem(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_request_context(request)
    item = cache['id_to_item'][item_id]
    # TODO: these should be two separate API calls
    if subitem_index == 0:
        utils.update_multiple_items.remove_item(cache, item)
    else:
        utils.update_single_item.delete_subitem(item, subitem_index)
    return generic_response(cache, search_filter)


@app.post('/update-subitem-content')
def update_subitem_content(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_request_context(request)
    updated_content = request.json['updatedContent']
    item = cache['id_to_item'][item_id]
    utils.update_single_item.update_subitem_content(item, subitem_index, updated_content)
    return {}


@app.post('/move-item-up')
def move_item_up(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_request_context(request)
    item = cache['id_to_item'][item_id]
    assert subitem_index == 0, 'subitem_index should be 0'
    utils.update_multiple_items.move_item_up(cache, item, search_filter)
    return generic_response(cache, search_filter)


@app.post('/move-item-down')
def move_item_down(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_request_context(request)
    item = cache['id_to_item'][item_id]
    assert subitem_index == 0, 'subitem index should be zero'
    utils.update_multiple_items.move_item_down(cache, item, search_filter)
    return generic_response(cache, search_filter)


@app.post('/move-subitem-up')
def move_subitem_up(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_request_context(request)
    item = cache['id_to_item'][item_id]
    try:
        new_item_subitem_id = utils.update_single_item.move_subitem_up(item, subitem_index)
    except Exception as e:
        return noop_response('illegal operation')
    return generic_response(cache, search_filter, new_item_subitem_id=new_item_subitem_id)


@app.post('/move-subitem-down')
def move_subitem_down(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_request_context(request)
    item = cache['id_to_item'][item_id]
    try:
        new_item_subitem_id = utils.update_single_item.move_subitem_down(item, subitem_index)
    except Exception as e:
        return noop_response('illegal operation')
    return generic_response(cache, search_filter, new_item_subitem_id=new_item_subitem_id)


@app.post('/indent')
def indent(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_request_context(request)
    item = cache['id_to_item'][item_id]
    try:
        utils.update_single_item.indent(item, subitem_index)
    except Exception as e:
        return noop_response('illegal operation')
    return generic_response(cache, search_filter, new_item_subitem_id=item_subitem_id)


@app.post('/outdent')
def outdent(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_request_context(request)
    item = cache['id_to_item'][item_id]
    try:
        utils.update_single_item.outdent(item, subitem_index)
    except Exception as e:
        return noop_response('illegal operation')
    return generic_response(cache, search_filter, new_item_subitem_id=item_subitem_id)


@app.post('/search')
def search(db):
    global cache
    search_filter = request.json['searchFilter']
    return generic_response(cache, search_filter)


@app.post('/add-item-sibling')
def add_item_sibling(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_request_context(request)
    assert subitem_index == 0, 'expected subitem_idex == 0'
    item = cache['id_to_item'][item_id]
    new_item_subitem_id = add_item_sibling(cache, item, search_filter)
    return generic_response(cache, search_filter, new_item_subitem_id=new_item_subitem_id)


@app.post('/add-subitem-sibling')
def add_subitem_sibling(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_request_context(request)
    item = cache['id_to_item'][item_id]
    new_item_subitem_id = utils.update_single_item.add_subitem_sibling(item, subitem_index)
    return generic_response(cache, search_filter, new_item_subitem_id=new_item_subitem_id)


@app.post('/add-subitem-child')
def add_subitem_child(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_request_context(request)
    item = cache['id_to_item'][item_id]
    new_item_subitem_id = utils.update_single_item.add_subitem_child(item, subitem_id)
    return generic_response(cache, search_filter, new_item_subitem_id=new_item_subitem_id)


@app.post('/add-item-top')
def add_item_top(db):
    global cache
    search_filter = request.json['searchFilter']
    if len(search_filter['texts']) > 0 or search_filter['partial_text'] is not None:
        return error_response('Cannot add new items when using a text based search filter.')
    new_item_subitem_id = utils.update_multiple_items.add_item_top(cache, search_filter)
    return generic_response(cache, search_filter, new_item_subitem_id=new_item_subitem_id)


@app.post('/paste-sibling')
def paste_sibling(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_request_context(request)
    item = cache['id_to_item'][item_id]
    assert 'clipboard' in request.json, 'missing clipboard from request'
    clipboard = request.json['clipboard']
    new_item_subitem_id = utils.update_multiple_items.paste_sibling(cache,
                                                                    search_filter,
                                                                    item,
                                                                    subitem_index,
                                                                    clipboard)
    return generic_response(cache, search_filter, new_item_subitem_id=new_item_subitem_id)


@app.post('/paste-child')
def paste_child(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_request_context(request)
    item = cache['id_to_item'][item_id]
    assert 'clipboard' in request.json, 'missing clipboard from request'
    clipboard = request.json['clipboard']
    new_item_subitem_id = utils.update_single_item.paste_child(item, subitem_index, clipboard)
    return generic_response(cache, search_filter, new_item_subitem_id=new_item_subitem_id)


if __name__ == '__main__':
    initialize_cache(cache)
    run(app)
