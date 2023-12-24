

def calculate_search_suggestions(cache, context):
    current_search = context.search_text.strip()
    current_search_terms = current_search.split()
    suggestions = ['journal', 'arXiv', 'ML', '@done', '@todo']
    full_suggestions = []
    # TODO: different logic depending on if 'tags' ends with a space or not
    for suggestion in suggestions:
        if suggestion in current_search_terms:
            # TODO this needs to be fancier
            continue
        full_suggestion = current_search + ' ' + suggestion + ' '
        print(f'\t{full_suggestion}')
        full_suggestions.append(full_suggestion)
    return full_suggestions
