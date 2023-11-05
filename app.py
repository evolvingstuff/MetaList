from bottle import Bottle, run, static_file, request
import bottle_sqlite
from config.config import db_path
from utils.server import get_request_context, generic_response, noop_response, error_response, Context, \
    pagination_response
from utils.update_multiple_items import remove_item, initialize_cache
from utils.update_single_item import swap_subtrees

import utils

app = Bottle()
plugin = bottle_sqlite.Plugin(dbfile=db_path)
app.install(plugin)

cache = {}


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
    context = get_request_context(request, cache)
    utils.update_single_item.toggle_todo(context.item, context.subitem_index)
    return generic_response(cache, context)


@app.post('/toggle-outline')
def toggle_outline(db):
    global cache
    context = get_request_context(request, cache)
    utils.update_single_item.toggle_outline(context.item, context.subitem_index)
    return generic_response(cache, context)


@app.post('/delete-subitem')
def delete_subitem(db):
    global cache
    context = get_request_context(request, cache)
    # TODO: these should be two separate API calls
    if context.subitem_index == 0:
        utils.update_multiple_items.remove_item(cache, context.item)
    else:
        utils.update_single_item.delete_subitem(context.item, context.subitem_index)
    return generic_response(cache, context)


@app.post('/update-subitem-content')
def update_subitem_content(db):
    global cache
    context = get_request_context(request, cache)
    utils.update_single_item.update_subitem_content(context.item, context.subitem_index, context.updated_content)
    return {}


@app.post('/move-item-up')
def move_item_up(db):
    global cache
    context = get_request_context(request, cache)
    utils.update_multiple_items.move_item_up(cache, context.item, context.search_filter)
    return generic_response(cache, context)


@app.post('/move-item-down')
def move_item_down(db):
    global cache
    context = get_request_context(request, cache)
    utils.update_multiple_items.move_item_down(cache, context.item, context.search_filter)
    return generic_response(cache, context)


@app.post('/move-subitem-up')
def move_subitem_up(db):
    global cache
    context = get_request_context(request, cache)
    try:
        new_item_subitem_id = utils.update_single_item.move_subitem_up(context.item, context.subitem_index)
    except Exception as e:
        return noop_response('illegal operation')
    return generic_response(cache, context, new_item_subitem_id=new_item_subitem_id)


@app.post('/move-subitem-down')
def move_subitem_down(db):
    global cache
    context = get_request_context(request, cache)
    try:
        new_item_subitem_id = utils.update_single_item.move_subitem_down(context.item, context.subitem_index)
    except Exception as e:
        return noop_response('illegal operation')
    return generic_response(cache, context, new_item_subitem_id=new_item_subitem_id)


@app.post('/indent')
def indent(db):
    global cache
    context = get_request_context(request, cache)
    try:
        utils.update_single_item.indent(context.item, context.subitem_index)
    except Exception as e:
        return noop_response('illegal operation')
    return generic_response(cache, context, new_item_subitem_id=context.item_subitem_id)


@app.post('/outdent')
def outdent(db):
    global cache
    context = get_request_context(request, cache)
    try:
        utils.update_single_item.outdent(context.item, context.subitem_index)
    except Exception as e:
        return noop_response('illegal operation')
    return generic_response(cache, context, new_item_subitem_id=context.item_subitem_id)


@app.post('/search')
def search(db):
    global cache
    search_filter = request.json['searchFilter']
    # TODO: this is dumb
    context = Context(None, None, None, None, search_filter, None, None, None)
    print('generic response to /search')
    return generic_response(cache, context)


@app.post('/add-item-sibling')
def add_item_sibling(db):
    global cache
    context = get_request_context(request, cache)
    new_item_subitem_id = utils.update_multiple_items.add_item_sibling(cache, context.item, context.search_filter)
    return generic_response(cache, context, new_item_subitem_id=new_item_subitem_id)


@app.post('/add-subitem-sibling')
def add_subitem_sibling(db):
    global cache
    context = get_request_context(request, cache)
    new_item_subitem_id = utils.update_single_item.add_subitem_sibling(context.item, context.subitem_index)
    return generic_response(cache, context, new_item_subitem_id=new_item_subitem_id)


@app.post('/add-subitem-child')
def add_subitem_child(db):
    global cache
    context = get_request_context(request, cache)
    new_item_subitem_id = utils.update_single_item.add_subitem_child(context.item, context.subitem_index)
    return generic_response(cache, context, new_item_subitem_id=new_item_subitem_id)


@app.post('/add-item-top')
def add_item_top(db):
    global cache
    context = get_request_context(request, cache)
    # TODO: move this logic to client
    if len(context.search_filter['texts']) > 0 or context.search_filter['partial_text'] is not None:
        return error_response('Cannot add new items when using a text based search filter.')
    new_item_subitem_id = utils.update_multiple_items.add_item_top(cache, context.search_filter)
    return generic_response(cache, context, new_item_subitem_id=new_item_subitem_id)


@app.post('/paste-sibling')
def paste_sibling(db):
    global cache
    context = get_request_context(request, cache)
    assert context.clipboard is not None, 'missing clipboard from request'
    new_item_subitem_id = utils.update_multiple_items.paste_sibling(cache, context)
    return generic_response(cache, context, new_item_subitem_id=new_item_subitem_id)


@app.post('/paste-child')
def paste_child(db):
    global cache
    context = get_request_context(request, cache)
    assert context.clipboard is not None, 'missing clipboard from request'
    new_item_subitem_id = utils.update_single_item.paste_child(context.item, context.subitem_index, context.clipboard)
    return generic_response(cache, context, new_item_subitem_id=new_item_subitem_id)


@app.post('/pagination-update')
def pagination_update(db):
    global cache
    context = get_request_context(request, cache)
    return pagination_response(cache, context)


if __name__ == '__main__':
    initialize_cache(cache)
    run(app)
