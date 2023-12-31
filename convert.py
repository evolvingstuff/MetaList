import sqlite3
import json
import os
from bs4 import BeautifulSoup
from metalist.utils.crud import get_database_path


def main():
    print('conversion...')
    db1 = sqlite3.connect("metalist.cleartext.db")  # must be in local dir
    base_dir = os.path.abspath(os.path.dirname(__file__))
    db_path = get_database_path()
    if os.path.exists(db_path):
        os.remove(db_path)
    db2 = sqlite3.connect(db_path)
    sql = 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);'
    db2.execute(sql)
    rows = db1.execute('SELECT * from items ORDER BY key DESC').fetchall()
    count = 0
    for row in rows:
        item = json.loads(row[1])
        id = item['id']
        cleanup(item)
        value = json.dumps(item)
        db2.execute('INSERT INTO items (id, value) VALUES (?, ?)', (id, value))
        count += 1
    print(f'done creating {count} rows')
    db2.commit()
    rows = db2.execute('SELECT * from items ORDER BY id DESC').fetchall()
    print(f'confirm {len(rows)} rows')


def cleanup(item):
    for subitem in item['subitems']:
        html_content = subitem['data']

        # Parse the HTML content
        soup = BeautifulSoup(html_content, 'html.parser')

        # Find all <div> elements with spellcheck="false"
        divs_to_remove = soup.find_all('div', {'spellcheck': 'false'})

        # Replace each element with its contents
        for div in divs_to_remove:
            div.unwrap()

        # Convert the modified tree back to a string
        clean_html = str(soup)

        # remove trailing </br>
        if clean_html.endswith("<br/>"):
            clean_html = clean_html[:-5]  # Slice off the last 5 characters

        subitem['data'] = clean_html

    if 'timestamp' in item:
        del item['timestamp']


if __name__ == '__main__':
    main()