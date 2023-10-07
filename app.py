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
    item_subitem_id, item_id, subitem_index, search_filter = get_context(request)
    item = cache['id_to_item'][item_id]
    if '@todo' in item['subitems'][subitem_index]['tags']:
        item['subitems'][subitem_index]['tags'] = item['subitems'][subitem_index]['tags'].replace('@todo', '@done')
    elif '@done' in item['subitems'][subitem_index]['tags']:
        item['subitems'][subitem_index]['tags'] = item['subitems'][subitem_index]['tags'].replace('@done', '@todo')
    decorate_item(item)  # TODO do we need this?
    # TODO: update db
    return generic_response(cache, search_filter)


@app.post('/toggle-outline')
def toggle_outline(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_context(request)
    item = cache['id_to_item'][item_id]
    if 'collapse' in item['subitems'][subitem_index]:
        del item['subitems'][subitem_index]['collapse']
    else:
        item['subitems'][subitem_index]['collapse'] = True
    decorate_item(item)  # TODO do we need this?
    # TODO: update db
    return generic_response(cache, search_filter)


@app.post('/delete-subitem')
def delete_subitem(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_context(request)
    item = cache['id_to_item'][item_id]
    if subitem_index == 0:
        remove_item(cache, item)
        # TODO: update db
        return generic_response(cache, search_filter)
    else:
        indent = item['subitems'][subitem_index]['indent']
        subitems_ = item['subitems'][:]
        del subitems_[subitem_index]
        while subitem_index < len(subitems_) and subitems_[subitem_index]['indent'] > indent:
            del subitems_[subitem_index]
        item['subitems'] = subitems_
        decorate_item(item)  # TODO do we need this?
        # TODO: update db
        return generic_response(cache, search_filter)


@app.post('/update-subitem-content')
def update_subitem_content(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_context(request)
    updated_content = request.json['updatedContent']
    item = cache['id_to_item'][item_id]
    item['subitems'][subitem_index]['data'] = updated_content
    decorate_item(item)  # TODO do we need this?
    return {}  # TODO


@app.post('/move-up')
def move_up(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_context(request)
    item = cache['id_to_item'][item_id]
    print(f'move-up: {item["subitems"][0]["data"]}')
    if subitem_index == 0:
        above = prev_visible(cache, item)
        if above is not None:
            remove_item(cache, item)
            insert_above_item(cache, item, above)
        # TODO update db
        return generic_response(cache, search_filter)
    raise NotImplementedError('cannot yet move subitems')  # TODO


@app.post('/move-down')
def move_down(db):
    global cache
    item_subitem_id, item_id, subitem_index, search_filter = get_context(request)
    item = cache['id_to_item'][item_id]

    print(f'move-down: {item["subitems"][0]["data"]}')
    if subitem_index == 0:
        below = next_visible(cache, item)
        if below is not None:
            remove_item(cache, item)
            insert_below_item(cache, item, below)
        # TODO update db
        return generic_response(cache, search_filter)
    raise NotImplementedError('cannot yet move subitems')  # TODO


@app.post('/indent')
def indent(db):
    global cache
    print('indent todo')
    item_subitem_id, item_id, subitem_index, search_filter = get_context(request)
    # TODO: add logic
    return generic_response(cache, search_filter)


@app.post('/outdent')
def outdent(db):
    global cache
    print('outdent todo')
    item_subitem_id, item_id, subitem_index, search_filter = get_context(request)
    # TODO add logic
    return generic_response(cache, search_filter)


@app.post('/search')
def search(db):
    global cache
    search_filter = request.json['searchFilter']
    return generic_response(cache, search_filter)


@app.post('/add-subitem-next')
def add_subitem_next(db):
    global cache
    print('add-subitem-next todo')
    item_subitem_id, item_id, subitem_index, search_filter = get_context(request)
    # TODO add logic
    return generic_response(cache, search_filter)


@app.post('/add-item-top')
def add_item_top(db):
    global cache
    print('add-item-top todo')
    search_filter = request.json['searchFilter']
    if len(search_filter['texts']) > 0 or search_filter['partial_text'] is not None:
        return error_response('Cannot add new items when using a text based search filter.')
    generate_new_item(cache, search_filter)
    # TODO update db
    return generic_response(cache, search_filter)


if __name__ == '__main__':
    initialize_cache(cache)
    run(app)
