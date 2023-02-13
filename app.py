import time
from bottle import Bottle, run, template, static_file
import bottle_sqlite


app = Bottle()
db_path = 'metalist.cleartext.db'  # TODO from root or somewhere else
plugin = bottle_sqlite.Plugin(dbfile=db_path)
app.install(plugin)


# https://stackoverflow.com/questions/10486224/bottle-static-files/13258941#13258941
# <filepath:path>
@app.route("/js/<filepath:re:.*\.js>", method="GET")
def js(filepath):
    # https://stackoverflow.com/questions/24672996/python-bottle-and-cache-control
    return static_file(filepath, root='static/js/')  # slash at front?


@app.route('/')
def show(db):
    t1 = time.time()
    rows = db.execute('SELECT * from items').fetchall()
    t2 = time.time()
    print(f'{len(rows)} rows; took {((t2-t1)*1000):.4f} ms')
    return template('templates/test.tpl', rows=rows)


if __name__ == '__main__':
    run(app)
