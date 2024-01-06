import time
from metalist import config


def calculate_search_suggestions(cache, context):
    t1 = time.time()
    current_search = context.search_text
    if config.development_mode:
        print(f'current_search: `{current_search}`')

    if context.search_filter['partial_text'] is not None or context.search_filter['negated_partial_text'] is not None:
        if config.development_mode:
            print('text completion mode... no suggestions')
        return []

    if context.search_filter['negated_partial_tag'] is not None:
        if config.development_mode:
            print('negated partial tag... no suggestions... for now (TODO)')
        return []

    word_completion_mode = False
    if context.search_filter['partial_tag']:
        word_completion_mode = True

    search_tags = set(context.search_filter['tags'])
    search_texts = context.search_filter['texts']
    search_partial_tag = context.search_filter['partial_tag']
    search_negated_tags = set(context.search_filter['negated_tags'])
    search_negated_texts = context.search_filter['negated_texts']
    # search_negated_partial_tag = context.search_filter['negated_partial_tag']

    candidate_item_ids = cache['search_index'].calculate_candidate_item_ids(context.search_filter)

    votes = {}
    for item in cache['id_to_item'].values():
        if item['id'] not in candidate_item_ids:
            continue
        for indx, subitem in enumerate(item['subitems']):
            subitem_tags = set(subitem['_tags'])
            if not search_tags.issubset(subitem_tags):
                continue
            if not search_negated_tags.isdisjoint(subitem_tags):
                continue
            if search_partial_tag is not None:
                one_match = False
                for tag in subitem_tags:
                    if tag.startswith(search_partial_tag):
                        one_match = True
                        break
                if not one_match:
                    continue

            # TODO: not sure if I want to include this or not...
            # if search_negated_partial_tag is not None:
            #     no_matches = True
            #     for tag in subitem_tags:
            #         if tag.startswith(search_negated_partial_tag):
            #             no_matches = False
            #             break
            #     if not no_matches:
            #         continue

            subitem_text = subitem['_searchable_text_full']
            match_all = True
            for text in search_texts:
                if text.lower() not in subitem_text:
                    match_all = False
                    break
            if not match_all:
                continue
            match_none = True
            for text in search_negated_texts:
                if text.lower() in subitem_text:
                    match_none = False
                    break
            if not match_none:
                continue

            for tag in subitem_tags:
                if tag not in votes:
                    votes[tag] = 0
                votes[tag] += 1.
    sorted_votes = sorted(votes.items(), key=lambda itm: itm[1], reverse=True)
    sorted_tags = [tag for tag, vote in sorted_votes]
    combined_sorted_tags = sorted_tags
    full_suggestions = []

    if word_completion_mode:
        last_chunk = current_search.split()[-1]
        prefix = current_search[:-len(last_chunk)].rstrip() + ' '
    else:
        prefix = current_search.rstrip() + ' '
    already_suggested = set(search_tags)
    for tag in combined_sorted_tags:
        if tag in already_suggested:
            continue
        if not word_completion_mode and tag.startswith('@'):
            continue
        if word_completion_mode and not tag.startswith(search_partial_tag):
            continue
        already_suggested.add(tag)
        full_suggestion = prefix + tag + ' '
        full_suggestions.append(full_suggestion)
        if len(full_suggestions) >= config.max_search_suggestions:
            break
    t2 = time.time()
    if config.development_mode:
        print(f'search suggestions took {(t2-t1)*1000:.4f} ms to calculate')
    return full_suggestions
