

def calculate_tags_suggestions(cache, context):
    subitem = cache['id_to_item'][context.item_id]['subitems'][context.subitem_index]
    # TODO redo this entire algorithm
    required_positive_tags = context.search_filter['tags']
    if context.search_filter['partial_tag'] is not None:
        required_positive_tags.append(context.search_filter['partial_tag'])
    print(f'debug: tag_suggestions required_positive_tags: {required_positive_tags}')
    suggestions = ['1234', '5678', 'abcd']
    full_suggestions = []
    # TODO: different logic depending on if 'tags' ends with a space or not
    prefix = ' '.join(subitem['tags'].split()) + ' '
    for suggestion in suggestions:
        if suggestion in subitem['_tags']:
            continue
        full_suggestion = prefix + suggestion + ' '
        print(f'\t{full_suggestion}')
        full_suggestions.append(full_suggestion)
    return full_suggestions
