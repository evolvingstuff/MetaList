import time, json
from bottle import Bottle, run, template, static_file, post, request
import bottle_sqlite


app = Bottle()
db_path = 'metalist.cleartext.db'  # TODO from root or somewhere else
plugin = bottle_sqlite.Plugin(dbfile=db_path)
app.install(plugin)


@app.route("/tests/<filepath:path>", method="GET")
def get_tests(filepath):
    # https://stackoverflow.com/questions/24672996/python-bottle-and-cache-control
    return static_file(filepath, root='static/tests/')


@app.route("/js/<filepath:re:.*\.js>", method="GET")
def get_js(filepath):
    # https://stackoverflow.com/questions/24672996/python-bottle-and-cache-control
    return static_file(filepath, root='static/js/')


@app.route("/components/<filepath:re:.*\.js>", method="GET")
def get_components(filepath):
    # https://stackoverflow.com/questions/24672996/python-bottle-and-cache-control
    return static_file(filepath, root='static/components/')


@app.route("/css/<filepath:re:.*\.css>", method="GET")
def get_css(filepath):
    # https://stackoverflow.com/questions/24672996/python-bottle-and-cache-control
    return static_file(filepath, root='static/css/')


@app.route("/<filepath:re:.*\.html>", method="GET")
def get_html(filepath):
    # https://stackoverflow.com/questions/24672996/python-bottle-and-cache-control
    return static_file(filepath, root='static/html/')


@app.route("/img/<filepath:path>", method="GET")
def get_html(filepath):
    # https://stackoverflow.com/questions/24672996/python-bottle-and-cache-control
    return static_file(filepath, root='static/img/')


@app.route("/libs/<filepath:path>", method="GET")
def get_lib(filepath):
    # https://stackoverflow.com/questions/24672996/python-bottle-and-cache-control
    return static_file(filepath, root='static/libs/')


@app.post('/search')
def search(db):
    max_results = 1000  # TODO make this a parameter in a config file
    t1 = time.time()
    jr = request.json
    rows = db.execute('SELECT * from items').fetchall()
    results = []
    for row in rows:
        node = json.loads(row['value'])
        for subitem in node['subitems']:
            if do_include_subitem(subitem, jr['filter']):
                results.append(subitem)
                if len(results) >= max_results:
                    break
        if len(results) >= max_results:
            break
    t2 = time.time()
    print(f'found {len(results)} results in {((t2-t1)*1000):.4f} ms')
    return {'results': results}


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

    # remove negatives first
    for negated_tag in search_filter['negated_tags']:
        if negated_tag in subitem_tags:
            return False
    for negated_text in search_filter['negated_texts']:
        if negated_text in subitem_text:
            return False
    if search_filter['negated_partial_tag'] is not None:
        for subitem_tag in subitem_tags:
            if subitem_tag.startswith(search_filter['negated_partial_tag']):
                return False
    if search_filter['negated_partial_text'] is not None and \
            search_filter['negated_partial_text'] in subitem_text:
        return False

    # then check positives
    for required_tag in search_filter['tags']:
        if required_tag not in subitem_tags:
            return False
    for required_text in search_filter['texts']:
        if required_text not in subitem_text:
            return False
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

    return True


if __name__ == '__main__':
    run(app)
