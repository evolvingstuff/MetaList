import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from utils.initialize import *
from dataclasses import dataclass
from typing import List


binary = True
k = 1000
threshold = 0.01  # 0.361  # TODO
top_n = 10000


@dataclass
class Document:
    text: str
    item_id: int
    subitem_index: int


def custom_tokenizer(text):
    assert isinstance(text, str)
    return text.split()


def calculate_tf_idf(cache, decorated=True, display=False):
    t1 = time.time()
    documents: List[Document] = list()
    for item in cache['id_to_item'].values():
        if not decorated:
            decorate_item(item)
        for index, subitem in enumerate(item['subitems']):
            text = subitem['_keyword_text_full']
            if text == '':
                continue
            document = Document(text, item['id'], index)
            documents.append(document)
            indent = '\t' * subitem['indent']
            print(f'{indent}{text}')
    t2 = time.time()
    print(f'{(t2 - t1):.4f} seconds to collect/decorate {len(documents)} total "documents"')
    t1 = time.time()
    vectorizer = TfidfVectorizer(tokenizer=custom_tokenizer, binary=binary)
    tfidf_matrix = vectorizer.fit_transform([doc.text for doc in documents])
    t2 = time.time()
    print(f'tfidf vectorizer took {(t2 - t1):.4f} seconds to fit')
    if display:
        feature_names = vectorizer.get_feature_names_out()
        summed_tfidf = np.sum(tfidf_matrix, axis=0)
        summed_tfidf = np.squeeze(np.asarray(summed_tfidf))
        sorted_indices = np.argsort(summed_tfidf)[::-1]
        top_features = [(feature_names[i], summed_tfidf[i]) for i in sorted_indices[:top_n]]
        for feature, score in top_features:
            print(f" - {feature}: {score}")
    return documents, vectorizer, tfidf_matrix


def calculate_ranked_suggestions(cache, documents, required_tags, new_document_vector, tfidf_matrix):
    # TODO: this should use standard filter operations with everything applied, instead of "required tags"
    t1 = time.time()
    similarity_scores = cosine_similarity(new_document_vector, tfidf_matrix).flatten()
    closest_documents_indices = np.argpartition(-similarity_scores, k - 1)[:k]
    sorted_indices = closest_documents_indices[np.argsort(-similarity_scores[closest_documents_indices])]
    weighted_votes_per_tag = {}
    for indx in sorted_indices:
        subitem = cache['id_to_item'][documents[indx].item_id]['subitems'][documents[indx].subitem_index]
        match = True
        for tag in required_tags:
            if tag not in subitem['_tags']:
                match = False
                break
        if not match:
            continue
        if similarity_scores[indx] < threshold:
            continue
        for tag in subitem['_tags']:
            if tag.startswith('@'):
                continue
            if tag not in weighted_votes_per_tag:
                weighted_votes_per_tag[tag] = 0
            weighted_votes_per_tag[tag] += similarity_scores[indx]
    sorted_tags = sorted(weighted_votes_per_tag, key=lambda tag: weighted_votes_per_tag[tag], reverse=True)
    suggestions = []
    for i, tag in enumerate(sorted_tags[:25]):
        suggestions.append(tag)
    t2 = time.time()
    print(f'calculating suggestions took {(t2-t1):.8f} seconds')
    return suggestions


def main():
    cache = {}
    initialize_cache(cache)
    documents, vectorizer, tfidf_matrix = calculate_tf_idf(cache, decorated=False, display=True)
    while True:
        print('-------------------------------------')
        item_subitem_id = input('Enter item/subitem id: ')
        item_id = int(item_subitem_id.split(':')[0])
        subitem_index = int(item_subitem_id.split(':')[1])
        required = input('required tags: ')
        if required != '':
            required_tags = required.split()
        else:
            required_tags = []
        chosen_subitem = cache['id_to_item'][item_id]['subitems'][subitem_index]
        new_document = chosen_subitem['_keyword_text_full']
        new_document_vector = vectorizer.transform([new_document])
        assert new_document_vector.shape[1] == tfidf_matrix.shape[1]
        suggestions = calculate_ranked_suggestions(cache, documents, required_tags, new_document_vector, tfidf_matrix)
        print('ranked suggestions:')
        for suggestion in suggestions:
            print(f'\t{suggestion}')


if __name__ == '__main__':
    main()
