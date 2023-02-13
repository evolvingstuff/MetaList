import time
from bottle import Bottle, run, template, static_file, post, request
import bottle_sqlite


app = Bottle()
db_path = 'metalist.cleartext.db'  # TODO from root or somewhere else
plugin = bottle_sqlite.Plugin(dbfile=db_path)
app.install(plugin)


# https://stackoverflow.com/questions/10486224/bottle-static-files/13258941#13258941
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

@app.route('/')
def show_all_items(db):
    t1 = time.time()
    rows = db.execute('SELECT * from items').fetchall()
    t2 = time.time()
    print(f'{len(rows)} rows; took {((t2-t1)*1000):.4f} ms')
    return template('templates/test.tpl', rows=rows)


@app.post('/search')
def search():
    jr = request.json
    print(f'searching for "{jr["query"]}"')
    return {'results': 'working on it'}


if __name__ == '__main__':
    run(app)
