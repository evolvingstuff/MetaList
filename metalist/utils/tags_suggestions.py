import time
from metalist import config


def jaccard_index(tags1, tags2):
    if tags1.isdisjoint(tags2):
        return 0.
    intersection = tags1.intersection(tags2)
    union = tags1.union(tags2)
    jaccard = len(intersection) / len(union)
    return jaccard


def calculate_tags_suggestions(cache, context):
    t1 = time.time()

    # TODO: might want to remove @tags from consideration?

    selected_subitem = cache['id_to_item'][context.item_id]['subitems'][context.subitem_index]

    word_completion_mode = False
    selected_subitem_partial_tag = None
    selected_subitem_tags = set(selected_subitem['_tags'])
    # TODO: check for actual characters with regex
    if selected_subitem['tags'].strip() != '' and not selected_subitem['tags'].endswith(' '):
        word_completion_mode = True
        selected_subitem_partial_tag = selected_subitem['tags'].split()[-1]
        selected_subitem_tags.remove(selected_subitem_partial_tag)

    selected_subitem_searchable_text = selected_subitem['_searchable_text']
    tags = set(context.search_filter['tags'])
    texts = context.search_filter['texts']
    partial_tag = context.search_filter['partial_tag']
    partial_text = context.search_filter['partial_text']
    negated_tags = set(context.search_filter['negated_tags'])
    negated_texts = context.search_filter['negated_texts']
    negated_partial_tag = context.search_filter['negated_partial_tag']
    negated_partial_text = context.search_filter['negated_partial_text']

    combined_tags = set(tags)
    # TODO: not sure if we want partial included here
    if partial_tag is not None:
        combined_tags.add(partial_tag)

    combined_negated_tags = set(negated_tags)
    # TODO: not sure if we want partial included here
    if negated_partial_tag is not None:
        combined_negated_tags.add(negated_partial_tag)

    combined_texts = texts
    if partial_text is not None:
        combined_texts.append(partial_text)

    combined_negated_texts = negated_texts
    if negated_partial_text is not None:
        combined_negated_texts.append(negated_partial_text)

    specific_literal_votes = {}
    generic_literal_votes = {}
    specific_votes = {}
    generic_votes = {}
    freq_votes = {}

    candidate_item_ids = cache['search_index'].calculate_candidate_item_ids(context.search_filter)

    for item in cache['id_to_item'].values():
        if item['id'] not in candidate_item_ids:
            continue
        for indx, subitem in enumerate(item['subitems']):
            subitem_tags = set(subitem['_tags'])
            ji = jaccard_index(selected_subitem_tags, subitem_tags)
            # TODO: don't need to calculate diffs here
            diff = subitem_tags.difference(selected_subitem_tags)
            for tag in diff:
                if tag not in freq_votes:
                    freq_votes[tag] = 0
                freq_votes[tag] += ji
            if not combined_tags.issubset(subitem_tags):
                continue
            if not combined_negated_tags.isdisjoint(subitem_tags):
                continue
            # if not tags.issubset(subitem_tags):
            #     continue
            # if not negated_tags.isdisjoint(subitem_tags):
            #     continue
            # if not all([t.startswith(partial_tag) for t in subitem_tags]):
            #     continue
            # if any([t == negated_partial_tag for t in subitem_tags]):  # softer constraints here
            #     continue
            subitem_text = subitem['_searchable_text']
            match_all = True
            for text in combined_texts:
                if text.lower() not in subitem_text:
                    match_all = False
                    break
            if not match_all:
                continue
            match_none = True
            for text in combined_negated_texts:
                if text.lower() in subitem_text:
                    match_none = False
                    break
            if not match_none:
                continue

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

    sorted_specific_literal_votes = sorted(specific_literal_votes.items(), key=lambda item: item[1], reverse=True)
    sorted_specific_literal_tags = [tag for tag, vote in sorted_specific_literal_votes]
    sorted_generic_literal_votes = sorted(generic_literal_votes.items(), key=lambda item: item[1], reverse=True)
    sorted_generic_literal_tags = [tag for tag, vote in sorted_generic_literal_votes]

    sorted_specific_votes = sorted(specific_votes.items(), key=lambda item: item[1], reverse=True)
    sorted_specific_tags = [tag for tag, vote in sorted_specific_votes]
    sorted_generic_votes = sorted(generic_votes.items(), key=lambda item: item[1], reverse=True)
    sorted_generic_tags = [tag for tag, vote in sorted_generic_votes]

    sorted_freq_votes = sorted(freq_votes.items(), key=lambda item: item[1], reverse=True)
    sorted_freq_tags = [tag for tag, vote in sorted_freq_votes]

    combined_sorted_tags = sorted_specific_literal_tags + \
                    sorted_generic_literal_tags + \
                    sorted_specific_tags

    if word_completion_mode:
        combined_sorted_tags.extend(sorted_generic_tags)
        combined_sorted_tags.extend(sorted_freq_tags)

    full_suggestions = []

    if word_completion_mode:
        prefix = ' '.join(selected_subitem['tags'].split()[:-1]) + ' '
    else:
        prefix = ' '.join(selected_subitem['tags'].split()) + ' '
    if config.development_mode:
        print(f'{len(sorted_specific_tags)} specific suggestions | {len(sorted_generic_tags)} less-specific suggestions')
    already_suggested = set(selected_subitem['_tags'])
    for tag in combined_sorted_tags:
        if tag in already_suggested:
            continue
        if not word_completion_mode and tag.startswith('@'):
            continue
        if word_completion_mode and not tag.startswith(selected_subitem_partial_tag):
            continue
        already_suggested.add(tag)
        full_suggestion = prefix + tag + ' '
        full_suggestions.append(full_suggestion)
        if len(full_suggestions) >= config.max_tags_suggestions:
            break
    t2 = time.time()
    if config.development_mode:
        print(f'calculate tags suggestions took {(t2 - t1)*1000:.4f} ms')
    return full_suggestions
