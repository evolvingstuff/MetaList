import json
import os
import sqlite3
import requests
import subprocess
import time
from metalist import config
from metalist.utils.crud import get_database_path


def main():
    print('run integration tests')
    test1()
    print('done')


def setup_clean_test_db():
    config.db_name = 'test.db'
    test_db_path = get_database_path()
    if os.path.exists(test_db_path):
        print(f'removing {test_db_path}')
        os.remove(test_db_path)
    db = sqlite3.connect(test_db_path)
    sql = 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);'
    db.execute(sql)
    print(f'created new items table for empty test database: {test_db_path}')


def remove_test_db():
    config.db_name = 'test.db'
    test_db_path = get_database_path()
    if os.path.exists(test_db_path):
        print(f'removing {test_db_path}')
        os.remove(test_db_path)


def test_environment(func):
    def wrapper(*args, **kwargs):
        # Set up test database
        setup_clean_test_db()

        # Start the server
        server = subprocess.Popen(["python", "../metalist/app.py"])
        time.sleep(2)  # Give the server time to start

        try:
            # Run the test function
            result = func(*args, **kwargs)
        finally:
            # Terminate the server and remove test database
            server.terminate()
            remove_test_db()

        return result

    return wrapper


@test_environment
def test1():

    data = {'appState':
        {
            'clipboard': None,
            'selectedItemSubitemId': None,
            'updatedContent': None,
            'updatedTags': None,
            'totalItemsToReturn': 50,
            'searchText': '',
            'searchFilter': {
                'tags': [],
                'negated_tags': [],
                'texts': [],
                'negated_texts': [],
                'partial_tag': None,
                'negated_partial_tag': None,
                'partial_text': None,
                'negated_partial_text': None
            },
            'reachedScrollEnd': False,
            'modeEditing': False,
            'modeMetaChat': False,
            'chatUserMessage': None,
            'openAiApiKey': None
        }
    }

    json_data = json.dumps(data)
    print(json_data)

    # Headers to specify that the request contains JSON
    headers = {'Content-Type': 'application/json'}
    url = 'http://127.0.0.1:8080/search'

    # Send POST request with JSON data
    response = requests.post(url, data=json_data, headers=headers)
    response_data = response.content
    decoded_data = response_data.decode('utf-8')
    python_object = json.loads(decoded_data)
    print(python_object)


if __name__ == '__main__':
    main()
