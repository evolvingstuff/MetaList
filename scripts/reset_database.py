import os

from metalist.utils.crud import get_database_path


def main():
    res = input('Are you SURE you want to reset the database? y/n ')
    if res.lower() != 'y':
        return
    path = get_database_path()
    print(f'removing {path}')
    os.remove(path)
    print('done')


if __name__ == '__main__':
    main()

