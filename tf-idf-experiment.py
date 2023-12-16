import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from utils.initialize import *

inherit_parent_context = True
tags_only = False
binary = True


def main():
    print('main()')
    cache = {}
    initialize_cache(cache)
    t1 = time.time()
    documents = []
    documents_to_subitems = []
    for item in cache['id_to_item'].values():
        decorate_item(item)
        for subitem in item['subitems']:
            if inherit_parent_context:
                if tags_only:
                    text = ' '.join(subitem['_tags'])
                else:
                    text = subitem['_soup_full']
            else:
                if tags_only:
                    text = subitem['tags']
                else:
                    text = subitem['_soup']
            text = text.strip()
            if text == '':
                continue
            documents.append(text)
            documents_to_subitems.append(subitem)
            indent = '\t' * subitem['indent']
            print(f'{indent}{text}')
    t2 = time.time()
    print(f'Beautiful soup took {(t2 - t1):.4f} seconds to process')
    print(f'{len(documents)} total "documents"')
    t1 = time.time()

    def custom_tokenizer(text):
        assert isinstance(text, str)
        return text.split()

    vectorizer = TfidfVectorizer(tokenizer=custom_tokenizer, binary=binary)

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

    from sklearn.metrics.pairwise import cosine_similarity

    while True:
        print('-------------------------------------')
        k = 1000
        threshold = 0.01  # 0.361  # TODO
        item_subitem_id = input('Enter item/subitem id: ')
        item_id = int(item_subitem_id.split(':')[0])
        subitem_index = int(item_subitem_id.split(':')[1])
        required = input('required tags: ')
        if required != '':
            required_tags = required.split()
        else:
            required_tags = []
        chosen_subitem = cache['id_to_item'][item_id]['subitems'][subitem_index]
        if inherit_parent_context:
            new_document = chosen_subitem['_soup_full']
        else:
            new_document = chosen_subitem['_soup']
        new_document_vector = vectorizer.transform([new_document])
        assert new_document_vector.shape[1] == tfidf_matrix.shape[1]
        similarity_scores = cosine_similarity(new_document_vector, tfidf_matrix).flatten()
        closest_documents_indices = np.argpartition(-similarity_scores, k - 1)[:k]
        sorted_indices = closest_documents_indices[np.argsort(-similarity_scores[closest_documents_indices])]

        weighted_votes_per_tag = {}

        print(f"Top {k} closest documents:")
        for indx in sorted_indices:
            subitem = documents_to_subitems[indx]
            match = True
            for tag in required_tags:
                if tag not in subitem['_tags']:
                    match = False
                    break
            if not match:
                continue
            if similarity_scores[indx] < threshold:
                continue
            print(f"\t- Document {indx + 1}, Similarity Score: {similarity_scores[indx]}")
            print(documents[indx])
            for tag in documents_to_subitems[indx]['_tags']:
                if tag.startswith('@'):
                    continue
                if tag not in weighted_votes_per_tag:
                    weighted_votes_per_tag[tag] = 0
                weighted_votes_per_tag[tag] += similarity_scores[indx]
        print('')
        print('weighted suggestions:')
        sorted_tags = sorted(weighted_votes_per_tag, key=lambda tag: weighted_votes_per_tag[tag], reverse=True)
        for i, tag in enumerate(sorted_tags[:25]):
            if tag in chosen_subitem['_tags']:
                # print(f'\t... already has tag {tag}')
                continue
            print(f'\t[{i+1}] {tag} -> {weighted_votes_per_tag[tag]:.4f}')


if __name__ == '__main__':
    main()
