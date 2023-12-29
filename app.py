import random

from bottle import Bottle, run, static_file, request
import bottle_sqlite
from config.config import db_path
from utils.search_suggestions import calculate_search_suggestions
from utils.server import get_request_context, \
    generic_response, noop_response, error_response, filter_items
from utils.tags_suggestions import calculate_tags_suggestions
from utils.update_multiple_items import *
from utils.update_single_item import *
from utils.initialize import initialize_cache
from utils.snapshots import Snapshots, SnapshotFragment, Snapshot, compress_snapshots

import utils

app = Bottle()
plugin = bottle_sqlite.Plugin(dbfile=db_path)
app.install(plugin)

cache = {}
snapshots = Snapshots()
documents = None
vectorizer = None
tfidf_matrix = None

reset_undo_stack_on_search = True


@app.route("/tests/<filepath:path>", method="GET")
def get_tests(filepath):
    return static_file(filepath, root='static/tests/')


@app.route("/js/<filepath:re:.*>", method="GET")
def get_js(filepath):
    # this extra logic allows imports to work better
    if not filepath.endswith('.js'):
        filepath += '.js'
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
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    utils.update_single_item.todo(context)
    filtered_items, reached_scroll_end = filter_items(cache, context)
    snap_post = SnapshotFragment(cache, context.item_subitem_id)
    snapshot = Snapshot('/todo', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)


@app.post('/done')
def done(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    utils.update_single_item.done(context)
    filtered_items, reached_scroll_end = filter_items(cache, context)
    snap_post = SnapshotFragment(cache, context.item_subitem_id)
    snapshot = Snapshot('/done', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)


@app.post('/expand')
def expand(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    utils.update_single_item.expand(context)
    filtered_items, reached_scroll_end = filter_items(cache, context)
    snap_post = SnapshotFragment(cache, context.item_subitem_id)
    snapshot = Snapshot('/expand', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)


@app.post('/collapse')
def collapse(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    utils.update_single_item.collapse(context)
    filtered_items, reached_scroll_end = filter_items(cache, context)
    snap_post = SnapshotFragment(cache, context.item_subitem_id)
    snapshot = Snapshot('/collapse', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)


@app.post('/delete-subitem')
def delete_subitem(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    # TODO: these should be two separate API calls
    if context.subitem_index == 0:
        utils.update_multiple_items.remove_item(cache, context)
        filtered_items, reached_scroll_end = filter_items(cache, context, dirty_ranking=True)
        snap_post = SnapshotFragment(cache, None)
        snapshot = Snapshot('/delete-subitem (item)', snap_pre, snap_post, context.item_subitem_id)
        snapshots.push(snapshot)
        compress_snapshots(cache, snapshots)
        return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=None)
    else:
        utils.update_single_item.delete_subitem(context)
        filtered_items, reached_scroll_end = filter_items(cache, context)
        snap_post = SnapshotFragment(cache, None)
        snapshot = Snapshot('/delete-subitem', snap_pre, snap_post, context.item_subitem_id)
        snapshots.push(snapshot)
        compress_snapshots(cache, snapshots)
        return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=None)


@app.post('/update-subitem-content')
def update_subitem_content(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    utils.update_single_item.update_subitem_content(context, cache)
    snap_post = SnapshotFragment(cache, context.item_subitem_id)
    snapshot = Snapshot('/update-subitem-content', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return {}


@app.post('/move-item-up')
def move_item_up(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    utils.update_multiple_items.move_item_up(cache, context)
    filtered_items, reached_scroll_end = filter_items(cache, context, dirty_ranking=True)
    snap_post = SnapshotFragment(cache, context.item_subitem_id)
    snapshot = Snapshot('/move-item-up', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)


@app.post('/move-item-down')
def move_item_down(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    utils.update_multiple_items.move_item_down(cache, context)
    filtered_items, reached_scroll_end = filter_items(cache, context, dirty_ranking=True)
    snap_post = SnapshotFragment(cache, context.item_subitem_id)
    snapshot = Snapshot('/move-item-down', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)


@app.post('/move-subitem-up')
def move_subitem_up(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    try:
        new_item_subitem_id = utils.update_single_item.move_subitem_up(context)
    except Exception as e:
        return noop_response('illegal operation')
    filtered_items, reached_scroll_end = filter_items(cache, context)
    snap_post = SnapshotFragment(cache, new_item_subitem_id)
    snapshot = Snapshot('/move-subitem-up', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)


@app.post('/move-subitem-down')
def move_subitem_down(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    try:
        new_item_subitem_id = utils.update_single_item.move_subitem_down(context)
    except Exception as e:
        return noop_response('illegal operation')
    filtered_items, reached_scroll_end = filter_items(cache, context)
    snap_post = SnapshotFragment(cache, new_item_subitem_id)
    snapshot = Snapshot('/move-subitem-down', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)


@app.post('/indent')
def indent(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    try:
        utils.update_single_item.indent(context)
    except Exception as e:
        return noop_response('illegal operation')
    filtered_items, reached_scroll_end = filter_items(cache, context)
    snap_post = SnapshotFragment(cache, context.item_subitem_id)
    snapshot = Snapshot('/indent', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)


@app.post('/outdent')
def outdent(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    try:
        utils.update_single_item.outdent(context)
    except Exception as e:
        return noop_response('illegal operation')
    filtered_items, reached_scroll_end = filter_items(cache, context)
    snap_post = SnapshotFragment(cache, context.item_subitem_id)
    snapshot = Snapshot('/outdent', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)


@app.post('/search')
def search(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    # TODO why remake context here?
    context = Context(context.app_state, search_text=context.search_text, search_filter=context.search_filter)
    filtered_items, reached_scroll_end = filter_items(cache, context, updated_search=True, dirty_ranking=True)
    snap_post = SnapshotFragment(cache, None)
    snapshot = Snapshot('/search', snap_pre, snap_post, context.item_subitem_id)
    if reset_undo_stack_on_search:
        snapshots.reset()
    else:
        snapshots.push(snapshot)
        compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=None)


@app.post('/search-suggestions')
def search_suggestions(db):
    global cache
    context = get_request_context(request, cache)
    suggestions = calculate_search_suggestions(cache, context)
    result = {
        'searchSuggestions': suggestions
    }
    return result


@app.post('/tags-suggestions')
def tags_suggestions(db):
    global cache
    context = get_request_context(request, cache)
    suggestions = calculate_tags_suggestions(cache, context)
    result = {
        'tagsSuggestions': suggestions
    }
    return result


@app.post('/add-item-sibling')
def add_item_sibling(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    new_item_subitem_id = utils.update_multiple_items.add_item_sibling(cache, context)
    filtered_items, reached_scroll_end = filter_items(cache, context, dirty_ranking=True)
    snap_post = SnapshotFragment(cache, new_item_subitem_id)
    snapshot = Snapshot('/add-item-sibling', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)


@app.post('/add-subitem-sibling')
def add_subitem_sibling(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    new_item_subitem_id = utils.update_single_item.add_subitem_sibling(context)
    filtered_items, reached_scroll_end = filter_items(cache, context)
    snap_post = SnapshotFragment(cache, new_item_subitem_id)
    snapshot = Snapshot('/add-subitem-sibling', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)


@app.post('/add-subitem-child')
def add_subitem_child(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    new_item_subitem_id = utils.update_single_item.add_subitem_child(context)
    filtered_items, reached_scroll_end = filter_items(cache, context)
    snap_post = SnapshotFragment(cache, new_item_subitem_id)
    snapshot = Snapshot('/add-subitem-child', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)


@app.post('/add-item-top')
def add_item_top(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    # TODO: move this logic to client
    if len(context.search_filter['texts']) > 0 or context.search_filter['partial_text'] is not None:
        return error_response('Cannot add new items when using a text based search filter.')
    new_item_subitem_id = utils.update_multiple_items.add_item_top(cache, context)
    filtered_items, reached_scroll_end = filter_items(cache, context, dirty_ranking=True)
    snap_post = SnapshotFragment(cache, new_item_subitem_id)
    snapshot = Snapshot('/add-item-top', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)


@app.post('/paste-sibling')
def paste_sibling(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    assert context.clipboard is not None, 'missing clipboard from request'
    new_item_subitem_id = utils.update_multiple_items.paste_sibling(cache, context)
    filtered_items, reached_scroll_end = filter_items(cache, context, dirty_ranking=True)
    snap_post = SnapshotFragment(cache, new_item_subitem_id)
    snapshot = Snapshot('/paste-sibling', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)


@app.post('/paste-child')
def paste_child(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    assert context.clipboard is not None, 'missing clipboard from request'
    new_item_subitem_id = utils.update_single_item.paste_child(context)
    filtered_items, reached_scroll_end = filter_items(cache, context)
    snap_post = SnapshotFragment(cache, new_item_subitem_id)
    snapshot = Snapshot('/paste-child', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)


@app.post('/pagination-update')
def pagination_update(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    # no snapshot
    filtered_items, reached_scroll_end = filter_items(cache, context)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)


@app.post('/update-tags')
def update_tags(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    utils.update_single_item.update_tags(context)
    filtered_items, reached_scroll_end = filter_items(cache, context)
    snap_post = SnapshotFragment(cache, context.item_subitem_id)
    snapshot = Snapshot('/update-tags', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)


@app.post('/open-to')
def open_to(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    utils.update_single_item.open_to(context)
    filtered_items, reached_scroll_end = filter_items(cache, context)
    snap_post = SnapshotFragment(cache, context.item_subitem_id)
    snapshot = Snapshot('/open-to', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)


@app.post('/undo')
def undo(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    # no snapshot
    try:
        new_item_subitem_id = utils.update_multiple_items.undo2(snapshots, cache)
        filtered_items, reached_scroll_end = filter_items(cache, context, dirty_ranking=True)  # TODO: just in case?
        return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)
    except Exception as e:
        return noop_response('nothing to undo')


@app.post('/redo')
def redo(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    # no snapshot
    try:
        new_item_subitem_id = utils.update_multiple_items.redo2(snapshots, cache)
        filtered_items, reached_scroll_end = filter_items(cache, context, dirty_ranking=True)  # TODO: just in case?
        return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)
    except Exception as e:
        return noop_response('nothing to redo')


if __name__ == '__main__':
    initialize_cache(cache)
    run(app)
