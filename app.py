from bottle import Bottle, run, static_file, request
import bottle_sqlite
from config.config import db_path
from utils.server import get_request_context, generic_response, noop_response, error_response, Context
from utils.update_multiple_items import remove_item
from utils.initialize import initialize_cache
from utils.update_single_item import swap_subtrees
from utils.snapshots import Snapshots

import utils

app = Bottle()
plugin = bottle_sqlite.Plugin(dbfile=db_path)
app.install(plugin)

cache = {}

snapshots = Snapshots()


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

#########################################################################################


@app.post('/todo')
def todo(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    utils.update_single_item.todo(snapshots, context)
    return generic_response(snapshots, cache, context, new_item_subitem_id=context.item_subitem_id)


@app.post('/done')
def done(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    utils.update_single_item.done(snapshots, context)
    return generic_response(snapshots, cache, context, new_item_subitem_id=context.item_subitem_id)


@app.post('/expand')
def expand(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    utils.update_single_item.expand(snapshots, context)
    return generic_response(snapshots, cache, context, new_item_subitem_id=context.item_subitem_id)


@app.post('/collapse')
def collapse(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    utils.update_single_item.collapse(snapshots, context)
    return generic_response(snapshots, cache, context, new_item_subitem_id=context.item_subitem_id)


@app.post('/delete-subitem')
def delete_subitem(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    # TODO: these should be two separate API calls
    if context.subitem_index == 0:
        utils.update_multiple_items.remove_item(snapshots, cache, context)
        return generic_response(snapshots, cache, context, new_item_subitem_id=None)
    else:
        utils.update_single_item.delete_subitem(snapshots, context)
        return generic_response(snapshots, cache, context, new_item_subitem_id=None)


@app.post('/update-subitem-content')
def update_subitem_content(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    utils.update_single_item.update_subitem_content(snapshots, context)
    return {}


@app.post('/move-item-up')
def move_item_up(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    utils.update_multiple_items.move_item_up(snapshots, cache, context)
    return generic_response(snapshots, cache, context, new_item_subitem_id=context.item_subitem_id)


@app.post('/move-item-down')
def move_item_down(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    utils.update_multiple_items.move_item_down(snapshots, cache, context)
    return generic_response(snapshots, cache, context, new_item_subitem_id=context.item_subitem_id)


@app.post('/move-subitem-up')
def move_subitem_up(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    try:
        new_item_subitem_id = utils.update_single_item.move_subitem_up(snapshots, context)
    except Exception as e:
        return noop_response('illegal operation')
    return generic_response(snapshots, cache, context, new_item_subitem_id=new_item_subitem_id)


@app.post('/move-subitem-down')
def move_subitem_down(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    try:
        new_item_subitem_id = utils.update_single_item.move_subitem_down(snapshots, context)
    except Exception as e:
        return noop_response('illegal operation')
    return generic_response(snapshots, cache, context, new_item_subitem_id=new_item_subitem_id)


@app.post('/indent')
def indent(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    try:
        utils.update_single_item.indent(snapshots, context)
    except Exception as e:
        return noop_response('illegal operation')
    return generic_response(snapshots, cache, context, new_item_subitem_id=context.item_subitem_id)


@app.post('/outdent')
def outdent(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    try:
        utils.update_single_item.outdent(snapshots, context)
    except Exception as e:
        return noop_response('illegal operation')
    return generic_response(snapshots, cache, context, new_item_subitem_id=context.item_subitem_id)


@app.post('/search')
def search(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    # TODO: this is dumb
    for item in cache['items']:
        if '_computed' in item:
            del item['_computed']
    context = Context(context.app_state, search_filter=context.search_filter)
    # TODO: no snapshot?
    return generic_response(snapshots, cache, context, new_item_subitem_id=None)


@app.post('/add-item-sibling')
def add_item_sibling(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    new_item_subitem_id = utils.update_multiple_items.add_item_sibling(snapshots, cache, context)
    return generic_response(snapshots, cache, context, new_item_subitem_id=new_item_subitem_id)


@app.post('/add-subitem-sibling')
def add_subitem_sibling(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    new_item_subitem_id = utils.update_single_item.add_subitem_sibling(snapshots, context)
    return generic_response(snapshots, cache, context, new_item_subitem_id=new_item_subitem_id)


@app.post('/add-subitem-child')
def add_subitem_child(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    new_item_subitem_id = utils.update_single_item.add_subitem_child(snapshots, context)
    return generic_response(snapshots, cache, context, new_item_subitem_id=new_item_subitem_id)


@app.post('/add-item-top')
def add_item_top(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    # TODO: move this logic to client
    if len(context.search_filter['texts']) > 0 or context.search_filter['partial_text'] is not None:
        return error_response('Cannot add new items when using a text based search filter.')
    new_item_subitem_id = utils.update_multiple_items.add_item_top(snapshots, cache, context)
    return generic_response(snapshots, cache, context, new_item_subitem_id=new_item_subitem_id)


@app.post('/paste-sibling')
def paste_sibling(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    assert context.clipboard is not None, 'missing clipboard from request'
    new_item_subitem_id = utils.update_multiple_items.paste_sibling(snapshots, cache, context)
    return generic_response(snapshots, cache, context, new_item_subitem_id=new_item_subitem_id)


@app.post('/paste-child')
def paste_child(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    assert context.clipboard is not None, 'missing clipboard from request'
    new_item_subitem_id = utils.update_single_item.paste_child(snapshots, context)
    return generic_response(snapshots, cache, context, new_item_subitem_id=new_item_subitem_id)


@app.post('/pagination-update')
def pagination_update(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    # no snapshot
    return generic_response(snapshots, cache, context, new_item_subitem_id=context.item_subitem_id)


@app.post('/update-tags')
def update_tags(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    utils.update_single_item.update_tags(snapshots, context)
    return generic_response(snapshots, cache, context, new_item_subitem_id=context.item_subitem_id)


@app.post('/undo')
def undo(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    try:
        new_item_subitem_id = utils.update_multiple_items.undo(snapshots, cache)
    except Exception as e:
        return noop_response('nothing to undo')
    return generic_response(snapshots, cache, context, new_item_subitem_id=new_item_subitem_id)


@app.post('/redo')
def redo(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    try:
        new_item_subitem_id = utils.update_multiple_items.redo(snapshots, cache)
    except Exception as e:
        return noop_response('nothing to redo')
    return generic_response(snapshots, cache, context, new_item_subitem_id=new_item_subitem_id)


if __name__ == '__main__':
    initialize_cache(cache)
    run(app)
