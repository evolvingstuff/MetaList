import time

from config.config import max_tags_suggestions


def jaccard_index(tags1, tags2):
    if tags1.isdisjoint(tags2):
        return 0.
    intersection = tags1.intersection(tags2)
    union = tags1.union(tags2)
    jaccard = len(intersection) / len(union)
    return jaccard


def calculate_tags_suggestions(cache, context):
    print(f'debug: updated_tags = "{context.updated_tags}"')

    selected_subitem = cache['id_to_item'][context.item_id]['subitems'][context.subitem_index]
    selected_subitem_tags = set(selected_subitem['_tags'])
    selected_subitem_searchable_text = selected_subitem['_searchable_text']

    tags = context.search_filter['tags']
    texts = context.search_filter['texts']
    partial_tag = context.search_filter['partial_tag']
    partial_text = context.search_filter['partial_text']
    negated_tags = context.search_filter['negated_tags']
    negated_texts = context.search_filter['negated_texts']
    negated_partial_tag = context.search_filter['negated_partial_tag']
    negated_partial_text = context.search_filter['negated_partial_text']

    combined_tags = set(tags)
    if partial_tag is not None:
        combined_tags.add(partial_tag)

    combined_negated_tags = set(negated_tags)
    if negated_partial_tag is not None:
        combined_negated_tags.add(negated_partial_tag)

    combined_texts = texts
    if partial_text is not None:
        combined_texts.append(partial_text)

    combined_negated_texts = negated_texts
    if negated_partial_text is not None:
        combined_negated_texts.append(negated_partial_text)

    t1 = time.time()
    # TODO could make this a LOT more efficient by having pre-calculated which items have which tags
    specific_literal_votes = {}
    generic_literal_votes = {}
    specific_votes = {}
    generic_votes = {}
    for item in cache['id_to_item'].values():
        for indx, subitem in enumerate(item['subitems']):
            subitem_tags = set(subitem['_tags'])
            if not combined_tags.issubset(subitem_tags):
                continue
            if not combined_negated_tags.isdisjoint(subitem_tags):
                continue
            subitem_text = subitem['_searchable_text']
            match_all = True
            for text in combined_texts:
                if text not in subitem_text:
                    match_all = False
                    break
            if not match_all:
                continue
            match_one = False
            for text in combined_negated_texts:
                if text in subitem_text:
                    match_one = True
                    break
            if match_one:
                continue
            ji = jaccard_index(selected_subitem_tags, subitem_tags)
            diff = subitem_tags.difference(selected_subitem_tags)
            if len(diff) > 0:
                for tag in diff:
                    if selected_subitem_tags.issubset(subitem_tags):
                        if tag not in specific_votes:
                            specific_votes[tag] = 0
                        specific_votes[tag] += ji
                        if tag.lower() in selected_subitem_searchable_text.split():
                            if tag not in specific_literal_votes:
                                specific_literal_votes[tag] = 0
                            specific_literal_votes[tag] += ji
                    else:
                        if tag not in generic_votes:
                            generic_votes[tag] = 0
                        generic_votes[tag] += ji
                        if tag.lower() in selected_subitem_searchable_text.split():
                            if tag not in generic_literal_votes:
                                generic_literal_votes[tag] = 0
                            generic_literal_votes[tag] += ji
    t2 = time.time()
    print(f'subitem matches for tags suggestions took {(t2-t1):.6f} seconds')

    sorted_specific_literal_votes = sorted(specific_literal_votes.items(), key=lambda item: item[1], reverse=True)
    sorted_specific_literal_tags = [tag for tag, vote in sorted_specific_literal_votes]
    sorted_generic_literal_votes = sorted(generic_literal_votes.items(), key=lambda item: item[1], reverse=True)
    sorted_generic_literal_tags = [tag for tag, vote in sorted_generic_literal_votes]

    sorted_specific_votes = sorted(specific_votes.items(), key=lambda item: item[1], reverse=True)
    sorted_specific_tags = [tag for tag, vote in sorted_specific_votes]
    sorted_generic_votes = sorted(generic_votes.items(), key=lambda item: item[1], reverse=True)
    sorted_generic_tags = [tag for tag, vote in sorted_generic_votes]

    combined_tags = sorted_specific_literal_tags + \
                    sorted_generic_literal_tags + \
                    sorted_specific_tags
                    # sorted_generic_tags  # seems much better without generic suggestions

    full_suggestions = []
    # TODO: different logic depending on if 'tags' ends with a space or not
    prefix = ' '.join(selected_subitem['tags'].split()) + ' '
    print(f'{len(sorted_specific_tags)} specific suggestions | {len(sorted_generic_tags)} less-specific suggestions')
    already_suggested = set(selected_subitem['_tags'])
    for tag in combined_tags:
        if tag in already_suggested:
            continue
        if tag.startswith('@'):
            continue
        already_suggested.add(tag)
        full_suggestion = prefix + tag + ' '
        full_suggestions.append(full_suggestion)
        if len(full_suggestions) >= max_tags_suggestions:
            break
    return full_suggestions
