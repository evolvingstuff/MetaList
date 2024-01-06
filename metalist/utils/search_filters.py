from metalist import config


def filter_subitem_negative(subitem, search_filter: str) -> bool:
    subitem_text = subitem['_searchable_text_full']
    subitem_tags = subitem['_tags']
    # TODO: for better efficiency, could order these by frequency, descending
    for negated_tag in search_filter['negated_tags']:
        if negated_tag.lower() in [t.lower() for t in subitem_tags]:
            return True
    if search_filter['negated_partial_tag'] is not None:
        # TODO: apply use_partial_tag_matches logic
        for subitem_tag in subitem_tags:
            if config.use_partial_tag_matches_negative:
                if subitem_tag.lower().startswith(search_filter['negated_partial_tag'].lower()):
                    return True
            else:
                if subitem_tag.lower() == search_filter['negated_partial_tag'].lower():
                    return True
    for negated_text in search_filter['negated_texts']:
        if negated_text.lower() in subitem_text:
            return True
    if config.use_partial_text_matches_negative and \
            search_filter['negated_partial_text'] is not None and \
            search_filter['negated_partial_text'].lower() in subitem_text:
        return True
    return False


def filter_subitem_positive(subitem, search_filter: str) -> bool:
    subitem_text = subitem['_searchable_text_full']
    subitem_tags = subitem['_tags']
    # TODO: for better efficiency, could order these by frequency, ascending
    for required_tag in search_filter['tags']:
        if required_tag.lower() not in [t.lower() for t in subitem_tags]:
            return False
    if search_filter['partial_tag'] is not None:
        one_match = False
        for subitem_tag in subitem_tags:
            if config.use_partial_tag_matches_positive:
                if subitem_tag.lower().startswith(search_filter['partial_tag'].lower()):
                    one_match = True
                    break
            else:
                if subitem_tag.lower() == search_filter['partial_tag'].lower():
                    one_match = True
                    break
        if not one_match:
            return False
    for required_text in search_filter['texts']:
        if required_text.lower() not in subitem_text:
            return False
    if config.use_partial_text_matches_positive and \
            search_filter['partial_text'] is not None and \
            search_filter['partial_text'].lower() not in subitem_text:
        return False
    return True
