import time, json
from bottle import Bottle, run, static_file, request
import bottle_sqlite


app = Bottle()
db_path = 'metalist.cleartext.db'  # TODO from root or somewhere else
plugin = bottle_sqlite.Plugin(dbfile=db_path)
app.install(plugin)

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
    return static_file(filepath, root='static/img/')


@app.route("/libs/<filepath:path>", method="GET")
def get_lib(filepath):
    return static_file(filepath, root='static/libs/')


@app.post('/search')
def search(db):
    max_results = 100  # TODO make this a parameter in a config file
    t1 = time.time()
    jr = request.json
    rows = db.execute('SELECT * from items').fetchall()
    items = []
    for row in rows:  # TODO use a view instead of the whole table
        item = json.loads(row['value'])
        at_least_one_match = False
        for subitem in item['subitems']:
            if do_include_subitem(subitem, jr['filter']):
                at_least_one_match = True
                break
        if at_least_one_match:
            items.append(item)
            if len(items) >= max_results:
                break
    t2 = time.time()
    print(f'found {len(items)} items in {((t2-t1)*1000):.4f} ms')
    return {'items': items}


# TODO: move this logic to a separate file
def do_include_subitem(subitem, search_filter):

    if len(search_filter['tags']) == 0 and \
            len(search_filter['texts']) == 0 and \
            search_filter['partial_text'] is None and \
            search_filter['partial_tag'] is None and \
            len(search_filter['negated_tags']) == 0 and \
            len(search_filter['negated_texts']) == 0 and \
            search_filter['negated_partial_text'] is None and \
            search_filter['negated_partial_tag'] is None:
        return True

    subitem_text = subitem['data']
    subitem_tags = [t.strip() for t in subitem['tags'].split(' ')]

    # remove positives first, because this narrows down the search space fastest
    # TODO: could order these by frequency, ascending
    if search_filter['partial_text'] is not None and \
            search_filter['partial_text'] not in subitem_text:
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
        if required_text not in subitem_text:
            return False

    # then check for negatives after, because these are less likely to be true
    # TODO: could order these by frequency, descending
    if search_filter['negated_partial_tag'] is not None:
        for subitem_tag in subitem_tags:
            if subitem_tag.startswith(search_filter['negated_partial_tag']):
                return False
    if search_filter['negated_partial_text'] is not None and \
            search_filter['negated_partial_text'] in subitem_text:
        return False
    for negated_tag in search_filter['negated_tags']:
        if negated_tag in subitem_tags:
            return False
    for negated_text in search_filter['negated_texts']:
        if negated_text in subitem_text:
            return False

    return True


if __name__ == '__main__':
    run(app)
