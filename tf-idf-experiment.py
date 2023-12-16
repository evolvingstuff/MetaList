import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from utils.initialize import *


def main():
    print('main()')
    cache = {}
    initialize_cache(cache)
    t1 = time.time()
    documents = []
    for item in cache['id_to_item'].values():
        decorate_item(item)
        for subitem in item['subitems']:
            text = subitem['_soup']
            if text == '':
                continue
            text_full = subitem['_soup_full']
            clean_text = subitem['_clean_text']
            documents.append(text_full)
            indent = '\t' * subitem['indent']
            print(f'{indent}{text_full}')
            print(f'{indent}{clean_text}')
    t2 = time.time()
    print(f'Beautiful soup took {(t2 - t1):.4f} seconds to process')
    print(f'{len(documents)} total "documents"')
    t1 = time.time()

    def custom_tokenizer(text):
        return text.split()

    vectorizer = TfidfVectorizer(tokenizer=custom_tokenizer, binary=True)  # TODO
    tfidf_matrix = vectorizer.fit_transform(documents)
    feature_names = vectorizer.get_feature_names_out()

    tf_idf_map = {}

    top_n = 10000
    summed_tfidf = np.sum(tfidf_matrix, axis=0)
    summed_tfidf = np.squeeze(np.asarray(summed_tfidf))
    sorted_indices = np.argsort(summed_tfidf)[::-1]
    top_features = [(feature_names[i], summed_tfidf[i]) for i in sorted_indices[:top_n]]
    for feature, score in top_features:
        print(f" - {feature}: {score}")
        tf_idf_map[feature] = score

    t2 = time.time()
    print(f'tfidf vectorizer took {(t2 - t1):.4f} seconds to process')

    for item in cache['id_to_item'].values():
        # print('todo')
        pass

    # maybe use fast-text
    # maybe use faiss

    while True:
        print('-------------------------------------')
        query = input('Enter an item/subitem combo: ')
        item_id, subitem_index = query.split(':')
        item_id, subitem_index = int(item_id), int(subitem_index)
        print(f'{item_id} : {subitem_index}')
        if item_id not in cache['id_to_item']:
            print('item not in cache')
            continue
        item = cache['id_to_item'][item_id]
        subitem = item['subitems'][subitem_index]
        print(subitem['_soup_full'])


if __name__ == '__main__':
    main()
