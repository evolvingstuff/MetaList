import sqlite3
import json
import os


def main():
    print('conversion...')
    db1 = sqlite3.connect("metalist.cleartext.db")
    if os.path.exists('metalist.2.0.db'):
        os.remove('metalist.2.0.db')
    db2 = sqlite3.connect("metalist.2.0.db")
    # sql = 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;'
    sql = 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);'
    db2.execute(sql)
    rows = db1.execute('SELECT * from items ORDER BY key DESC').fetchall()
    count = 0
    for row in rows:
        item = json.loads(row[1])
        id = item['id']
        db2.execute('INSERT INTO items (id, value) VALUES (?, ?)', (id, row[1]))
        count += 1
    print(f'done creating {count} rows')
    db2.commit()
    rows = db2.execute('SELECT * from items ORDER BY id DESC').fetchall()
    print(f'confirm {len(rows)} rows')


if __name__ == '__main__':
    main()