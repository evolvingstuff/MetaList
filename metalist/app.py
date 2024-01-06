import os
from typing import List
from bottle import Bottle, run, static_file, request, response
import bottle_sqlite
import requests

from metalist import config
from metalist.utils.chat_prompts import build_initial_prompts, build_selection_prompt
from metalist.utils.crud import get_database_path
from metalist.utils.search_suggestions import calculate_search_suggestions
from metalist.utils.server import get_request_context, \
    generic_response, noop_response, error_response, filter_and_sort_items, Context, chat_response
from metalist.utils.search_index import SearchIndex
from metalist.utils.tags_suggestions import calculate_tags_suggestions
from metalist.utils.initialize import initialize_cache
from metalist.utils.snapshots import Snapshots, SnapshotFragment, Snapshot, compress_snapshots
from metalist.utils import crud
from metalist.utils import update_single_item, update_multiple_items


cache = {}
snapshots = Snapshots()
chat_history: List[dict] = list()

app = Bottle()
plugin = bottle_sqlite.Plugin(dbfile=get_database_path())
app.install(plugin)


def run_app():
    if config.development_mode:
        print('config.development_mode = True')
    initialize_cache(cache)
    run(app, port=config.port, debug=False)


@app.route("/tests/<filepath:path>", method="GET")
def get_tests(filepath):
    file_root = os.path.join(os.path.dirname(__file__), 'static', 'tests')
    return static_file(filepath, root=file_root)


@app.route("/js/<filepath:re:.*>", method="GET")
def get_js(filepath):
    # this extra logic allows imports to work better
    if not filepath.endswith('.js'):
        filepath += '.js'
    file_root = os.path.join(os.path.dirname(__file__), 'static', 'js')
    return static_file(filepath, root=file_root)


@app.route("/components/<filepath:re:.*\.js>", method="GET")
def get_components(filepath):
    file_root = os.path.join(os.path.dirname(__file__), 'static', 'components')
    return static_file(filepath, root=file_root)


@app.route("/css/<filepath:re:.*\.css>", method="GET")
def get_css(filepath):
    file_root = os.path.join(os.path.dirname(__file__), 'static', 'css')
    return static_file(filepath, root=file_root)


@app.route("/<filepath:re:.*\.html>", method="GET")
def get_html(filepath):
    html_root = os.path.join(os.path.dirname(__file__), 'static', 'html')
    return static_file(filepath, root=html_root)


@app.route('/', method="GET")
def index():
    html_root = os.path.join(os.path.dirname(__file__), 'static', 'html')
    return static_file('index.html', root=html_root)


@app.route("/img/<filepath:path>", method="GET")
def get_img(filepath):
    file_root = os.path.join(os.path.dirname(__file__), 'static', 'img')
    response = static_file(filepath, root=file_root)
    # Note: cache-control appears not to work for Chrome if in dev mode
    response.set_header("Cache-Control", "public, max-age=604800")
    return response


@app.route("/libs/<filepath:path>", method="GET")
def get_lib(filepath):
    file_root = os.path.join(os.path.dirname(__file__), 'static', 'libs')
    return static_file(filepath, root=file_root)

#########################################################################################


@app.post('/todo')
def todo(db):
    global cache, snapshots
    try:
        crud.begin(db)
        context = get_request_context(request, cache)
        snap_pre = SnapshotFragment(cache, context.item_subitem_id)
        update_single_item.todo(db, context, cache)
        filtered_items, reached_scroll_end = filter_and_sort_items(cache, context)
        snap_post = SnapshotFragment(cache, context.item_subitem_id)
        snapshot = Snapshot('/todo', snap_pre, snap_post, context.item_subitem_id)
        snapshots.push(snapshot)
        compress_snapshots(cache, snapshots)
        crud.commit(db)
        return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)
    except Exception as e:
        crud.rollback(db)
        return error_response(e)


@app.post('/done')
def done(db):
    global cache, snapshots
    try:
        crud.begin(db)
        context = get_request_context(request, cache)
        snap_pre = SnapshotFragment(cache, context.item_subitem_id)
        update_single_item.done(db, context, cache)
        filtered_items, reached_scroll_end = filter_and_sort_items(cache, context)
        snap_post = SnapshotFragment(cache, context.item_subitem_id)
        snapshot = Snapshot('/done', snap_pre, snap_post, context.item_subitem_id)
        snapshots.push(snapshot)
        compress_snapshots(cache, snapshots)
        crud.commit(db)
        return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)
    except Exception as e:
        crud.rollback(db)
        return error_response(e)


@app.post('/expand')
def expand(db):
    global cache, snapshots
    try:
        crud.begin(db)
        context = get_request_context(request, cache)
        snap_pre = SnapshotFragment(cache, context.item_subitem_id)
        update_single_item.expand(db, context, cache)
        filtered_items, reached_scroll_end = filter_and_sort_items(cache, context)
        snap_post = SnapshotFragment(cache, context.item_subitem_id)
        snapshot = Snapshot('/expand', snap_pre, snap_post, context.item_subitem_id)
        snapshots.push(snapshot)
        compress_snapshots(cache, snapshots)
        crud.commit(db)
        return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)
    except Exception as e:
        crud.rollback(db)
        return error_response(e)


@app.post('/collapse')
def collapse(db):
    global cache, snapshots
    try:
        crud.begin(db)
        context = get_request_context(request, cache)
        snap_pre = SnapshotFragment(cache, context.item_subitem_id)
        update_single_item.collapse(db, context, cache)
        filtered_items, reached_scroll_end = filter_and_sort_items(cache, context)
        snap_post = SnapshotFragment(cache, context.item_subitem_id)
        snapshot = Snapshot('/collapse', snap_pre, snap_post, context.item_subitem_id)
        snapshots.push(snapshot)
        compress_snapshots(cache, snapshots)
        crud.commit(db)
        return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)
    except Exception as e:
        crud.rollback(db)
        return error_response(e)


@app.post('/delete-subitem')
def delete_subitem(db):
    global cache, snapshots
    try:
        crud.begin(db)
        context = get_request_context(request, cache)
        snap_pre = SnapshotFragment(cache, context.item_subitem_id)
        # TODO: these should be two separate API calls
        if context.subitem_index == 0:
            must_recalculate_ontology = update_multiple_items.remove_item(db, cache, context)
            if must_recalculate_ontology:
                update_multiple_items.recalculate_ontology(db, cache, context)
            filtered_items, reached_scroll_end = filter_and_sort_items(cache, context, dirty_ranking=True)
            snap_post = SnapshotFragment(cache, None)
            snapshot = Snapshot('/delete-subitem (item)', snap_pre, snap_post, context.item_subitem_id)
            snapshots.push(snapshot)
            compress_snapshots(cache, snapshots)
            crud.commit(db)
            return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=None)
        else:
            must_recalculate_ontology = update_single_item.delete_subitem(db, context, cache)
            if must_recalculate_ontology:
                update_multiple_items.recalculate_ontology(db, cache, context)
            filtered_items, reached_scroll_end = filter_and_sort_items(cache, context)
            snap_post = SnapshotFragment(cache, None)
            snapshot = Snapshot('/delete-subitem', snap_pre, snap_post, context.item_subitem_id)
            snapshots.push(snapshot)
            compress_snapshots(cache, snapshots)
            crud.commit(db)
            return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=None)
    except Exception as e:
        crud.rollback(db)
        return error_response(e)


@app.post('/update-subitem-content')
def update_subitem_content(db):
    global cache, snapshots
    try:
        crud.begin(db)
        context = get_request_context(request, cache)
        snap_pre = SnapshotFragment(cache, context.item_subitem_id)
        must_recalculate_ontology = update_single_item.update_subitem_content(db, context, cache)
        if must_recalculate_ontology:
            update_multiple_items.recalculate_ontology(db, cache, context)
        snap_post = SnapshotFragment(cache, context.item_subitem_id)
        snapshot = Snapshot('/update-subitem-content', snap_pre, snap_post, context.item_subitem_id)
        snapshots.push(snapshot)
        compress_snapshots(cache, snapshots)
        crud.commit(db)
        return {}
    except Exception as e:
        crud.rollback(db)
        return error_response(e)


@app.post('/move-item-up')
def move_item_up(db):
    global cache, snapshots
    try:
        crud.begin(db)
        context = get_request_context(request, cache)
        snap_pre = SnapshotFragment(cache, context.item_subitem_id)
        update_multiple_items.move_item_up(db, cache, context)
        filtered_items, reached_scroll_end = filter_and_sort_items(cache, context, dirty_ranking=True)
        snap_post = SnapshotFragment(cache, context.item_subitem_id)
        snapshot = Snapshot('/move-item-up', snap_pre, snap_post, context.item_subitem_id)
        snapshots.push(snapshot)
        compress_snapshots(cache, snapshots)
        crud.commit(db)
        return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)
    except Exception as e:
        crud.rollback(db)
        return error_response(e)


@app.post('/move-item-down')
def move_item_down(db):
    global cache, snapshots
    try:
        crud.begin(db)
        context = get_request_context(request, cache)
        snap_pre = SnapshotFragment(cache, context.item_subitem_id)
        update_multiple_items.move_item_down(db, cache, context)
        filtered_items, reached_scroll_end = filter_and_sort_items(cache, context, dirty_ranking=True)
        snap_post = SnapshotFragment(cache, context.item_subitem_id)
        snapshot = Snapshot('/move-item-down', snap_pre, snap_post, context.item_subitem_id)
        snapshots.push(snapshot)
        compress_snapshots(cache, snapshots)
        crud.commit(db)
        return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)
    except Exception as e:
        crud.rollback(db)
        return error_response(e)


@app.post('/move-subitem-up')
def move_subitem_up(db):
    global cache, snapshots
    try:
        crud.begin(db)
        context = get_request_context(request, cache)
        snap_pre = SnapshotFragment(cache, context.item_subitem_id)
        new_item_subitem_id = update_single_item.move_subitem_up(db, context, cache)
        filtered_items, reached_scroll_end = filter_and_sort_items(cache, context)
        snap_post = SnapshotFragment(cache, new_item_subitem_id)
        snapshot = Snapshot('/move-subitem-up', snap_pre, snap_post, context.item_subitem_id)
        snapshots.push(snapshot)
        compress_snapshots(cache, snapshots)
        crud.commit(db)
        return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)
    except Exception as e:
        crud.rollback(db)
        return noop_response('illegal operation')


@app.post('/move-subitem-down')
def move_subitem_down(db):
    global cache, snapshots
    try:
        crud.begin(db)
        context = get_request_context(request, cache)
        snap_pre = SnapshotFragment(cache, context.item_subitem_id)
        new_item_subitem_id = update_single_item.move_subitem_down(db, context, cache)
        filtered_items, reached_scroll_end = filter_and_sort_items(cache, context)
        snap_post = SnapshotFragment(cache, new_item_subitem_id)
        snapshot = Snapshot('/move-subitem-down', snap_pre, snap_post, context.item_subitem_id)
        snapshots.push(snapshot)
        compress_snapshots(cache, snapshots)
        crud.commit(db)
        return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)
    except Exception as e:
        crud.rollback(db)
        return noop_response('illegal operation')


@app.post('/indent')
def indent(db):
    global cache, snapshots
    try:
        crud.begin(db)
        context = get_request_context(request, cache)
        snap_pre = SnapshotFragment(cache, context.item_subitem_id)
        update_single_item.indent(db, context, cache)
        filtered_items, reached_scroll_end = filter_and_sort_items(cache, context)
        snap_post = SnapshotFragment(cache, context.item_subitem_id)
        snapshot = Snapshot('/indent', snap_pre, snap_post, context.item_subitem_id)
        snapshots.push(snapshot)
        compress_snapshots(cache, snapshots)
        crud.commit(db)
        return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)
    except Exception as e:
        crud.rollback(db)
        return noop_response('illegal operation')


@app.post('/outdent')
def outdent(db):
    global cache, snapshots
    try:
        crud.begin(db)
        context = get_request_context(request, cache)
        snap_pre = SnapshotFragment(cache, context.item_subitem_id)
        update_single_item.outdent(db, context, cache)
        filtered_items, reached_scroll_end = filter_and_sort_items(cache, context)
        snap_post = SnapshotFragment(cache, context.item_subitem_id)
        snapshot = Snapshot('/outdent', snap_pre, snap_post, context.item_subitem_id)
        snapshots.push(snapshot)
        compress_snapshots(cache, snapshots)
        crud.commit(db)
        return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)
    except Exception as e:
        crud.rollback(db)
        return noop_response('illegal operation')


@app.post('/search')
def search(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    # TODO why recreate context?
    context = Context(context.app_state, search_text=context.search_text, search_filter=context.search_filter)
    filtered_items, reached_scroll_end = filter_and_sort_items(cache, context, updated_search=True, dirty_ranking=True)
    if config.reset_undo_stack_on_search:
        snapshots.reset()
    else:
        crud.rollback()
        raise NotImplementedError('snapshots for search not implemented')
    crud.commit(db)
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
    crud.begin(db)
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    new_item_subitem_id = update_multiple_items.add_item_sibling(db, cache, context)
    filtered_items, reached_scroll_end = filter_and_sort_items(cache, context, dirty_ranking=True)
    snap_post = SnapshotFragment(cache, new_item_subitem_id)
    snapshot = Snapshot('/add-item-sibling', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    crud.commit(db)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)


@app.post('/add-subitem-sibling')
def add_subitem_sibling(db):
    global cache, snapshots
    crud.begin(db)
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    new_item_subitem_id = update_single_item.add_subitem_sibling(db, context, cache)
    filtered_items, reached_scroll_end = filter_and_sort_items(cache, context)
    snap_post = SnapshotFragment(cache, new_item_subitem_id)
    snapshot = Snapshot('/add-subitem-sibling', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    crud.commit(db)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)


@app.post('/add-subitem-child')
def add_subitem_child(db):
    global cache, snapshots
    crud.begin(db)
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    new_item_subitem_id = update_single_item.add_subitem_child(db, context, cache)
    filtered_items, reached_scroll_end = filter_and_sort_items(cache, context)
    snap_post = SnapshotFragment(cache, new_item_subitem_id)
    snapshot = Snapshot('/add-subitem-child', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    crud.commit(db)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)


@app.post('/add-item-top')
def add_item_top(db):
    global cache, snapshots
    crud.begin(db)
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    # TODO: move this logic to client
    if len(context.search_filter['texts']) > 0 or context.search_filter['partial_text'] is not None:
        return error_response('Cannot add new items when using a text based search filter.')
    new_item_subitem_id = update_multiple_items.add_item_top(db, cache, context)
    filtered_items, reached_scroll_end = filter_and_sort_items(cache, context, dirty_ranking=True)
    snap_post = SnapshotFragment(cache, new_item_subitem_id)
    snapshot = Snapshot('/add-item-top', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    crud.commit(db)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)


@app.post('/paste-sibling')
def paste_sibling(db):
    global cache, snapshots
    crud.begin(db)
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    assert context.clipboard is not None, 'missing clipboard from request'
    new_item_subitem_id = update_multiple_items.paste_sibling(db, cache, context)
    filtered_items, reached_scroll_end = filter_and_sort_items(cache, context, dirty_ranking=True)
    snap_post = SnapshotFragment(cache, new_item_subitem_id)
    snapshot = Snapshot('/paste-sibling', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    crud.commit(db)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)


@app.post('/paste-child')
def paste_child(db):
    global cache, snapshots
    crud.begin(db)
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    assert context.clipboard is not None, 'missing clipboard from request'
    new_item_subitem_id = update_single_item.paste_child(db, context, cache)
    filtered_items, reached_scroll_end = filter_and_sort_items(cache, context)
    snap_post = SnapshotFragment(cache, new_item_subitem_id)
    snapshot = Snapshot('/paste-child', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    crud.commit(db)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)


@app.post('/pagination-update')
def pagination_update(db):
    global cache, snapshots
    context = get_request_context(request, cache)
    # no snapshot
    filtered_items, reached_scroll_end = filter_and_sort_items(cache, context)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)


@app.post('/update-tags')
def update_tags(db):
    global cache, snapshots
    crud.begin(db)
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    must_recalculate_ontology = update_single_item.update_tags(db, context, cache)
    if must_recalculate_ontology:
        update_multiple_items.recalculate_ontology(db, cache, context)
    filtered_items, reached_scroll_end = filter_and_sort_items(cache, context)
    snap_post = SnapshotFragment(cache, context.item_subitem_id)
    snapshot = Snapshot('/update-tags', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    crud.commit(db)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)


@app.post('/open-to')
def open_to(db):
    global cache, snapshots
    crud.begin(db)
    context = get_request_context(request, cache)
    snap_pre = SnapshotFragment(cache, context.item_subitem_id)
    update_single_item.open_to(db, context, cache)
    filtered_items, reached_scroll_end = filter_and_sort_items(cache, context)
    snap_post = SnapshotFragment(cache, context.item_subitem_id)
    snapshot = Snapshot('/open-to', snap_pre, snap_post, context.item_subitem_id)
    snapshots.push(snapshot)
    compress_snapshots(cache, snapshots)
    crud.commit(db)
    return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=context.item_subitem_id)


@app.post('/undo')
def undo(db):
    global cache, snapshots
    crud.begin(db)
    context = get_request_context(request, cache)
    # no snapshot
    try:
        new_item_subitem_id = update_multiple_items.undo(db, snapshots, cache)
        filtered_items, reached_scroll_end = filter_and_sort_items(cache, context, dirty_ranking=True)
        crud.commit(db)
        return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)
    except Exception as e:
        crud.rollback(db)
        return noop_response('nothing to undo')


@app.post('/redo')
def redo(db):
    global cache, snapshots
    crud.begin(db)
    context = get_request_context(request, cache)
    # no snapshot
    try:
        new_item_subitem_id = update_multiple_items.redo(db, snapshots, cache)
        filtered_items, reached_scroll_end = filter_and_sort_items(cache, context, dirty_ranking=True)
        crud.commit(db)
        return generic_response(filtered_items, reached_scroll_end, new_item_subitem_id=new_item_subitem_id)
    except Exception as e:
        crud.rollback(db)
        return noop_response('nothing to redo')


@app.post('/chat-open')
def chat_open(db):
    global chat_history
    chat_history = []  # reset history
    return noop_response('chat-open')


@app.post('/chat-close')
def chat_close(db):
    global chat_history
    chat_history = []  # reset history
    return noop_response('chat-close')


@app.post('/chat-select-reference')
def chat_select_reference(db):
    global chat_history, cache
    context = get_request_context(request, cache)
    system_message = build_selection_prompt(context)
    chat_history.append(system_message)
    return noop_response('chat-select-reference')


@app.post('/chat-send-message')
def chat_send_message(db):
    global chat_history, cache
    context = get_request_context(request, cache)
    assert context.open_ai_api_key is not None, "OpenAI key is None"
    if len(chat_history) == 0:
        # get relevant items based on search filter
        filtered_items, reached_scroll_end = filter_and_sort_items(cache, context, dirty_ranking=True)
        prompts = build_initial_prompts(context, filtered_items)
        for prompt in prompts:
            chat_history.append(prompt)
    else:
        assert chat_history[0]['role'] == 'system'
    user_message = {'role': 'user', 'content': context.chat_user_message}
    chat_history.append(user_message)

    # web_crawl_system_messages = process_user_message_for_urls(context.chat_user_message)
    # chat_history.extend(web_crawl_system_messages)

    ########################################################

    # Prepare the payload for the OpenAI API
    data = {
        "model": config.open_ai_model,
        "messages": chat_history
    }
    headers = {
        "Authorization": f"Bearer {context.open_ai_api_key}",
        "Content-Type": "application/json"
    }

    # Make a synchronous POST request to the OpenAI Chat API  # TODO FastAPI
    openai_response = requests.post(config.open_ai_url, json=data, headers=headers)

    # Check if the request was successful and process the response
    if openai_response.status_code == 200:
        openai_data = openai_response.json()
        assistant_message = openai_data['choices'][0]['message']
        msg = {
            'role': assistant_message['role'],
            'content': assistant_message['content']
        }
        chat_history.append(msg)
        return chat_response(chat_history)
    else:
        return error_response('bad response from open ai')


if __name__ == '__main__':
    print('setting config.development_mode = True')
    config.development_mode = True
    run_app()
