from metalist import config


def extract_ontology(cache, item):
    for subitem in item['subitems']:
        if '@implies' in subitem['tags']:
            data = subitem["data"]
            # TODO should be able to use _searchable_text for this I think
            data = data.replace('&gt;', '>')
            data = data.replace(u'\xa0', ' ')
            data = data.replace('<div>', '\n')
            data = data.replace('</div>', '\n')
            data = data.replace('<br>', '\n')
            data = data.replace('<br/>', '\n')
            lines = data.split('\n')
            for line in lines:
                if line.strip() == '':
                    continue
                parts = line.split(' ')  # TODO asdfasdf
                if '=' in parts:
                    if '=>' in parts:
                        if config.development_mode:
                            print(f'weird rule (skipping): {parts}')
                        continue
                    indx = parts.index('=')
                    lhs = parts[:indx]
                    rhs = parts[indx+1:]
                    all = lhs + rhs
                    for i in range(len(all)):
                        for j in range(len(all)):
                            if i == j:
                                continue
                            left, right = all[i], all[j]
                            if left not in cache['ontology']:
                                cache['ontology'][left] = set()
                            cache['ontology'][left].add(right)
                elif '=>' in parts:
                    if '=' in parts:
                        if config.development_mode:
                            print(f'weird rule (skipping): {parts}')
                        continue
                    indx = parts.index('=>')
                    lhs = parts[:indx]
                    rhs = parts[indx + 1:]
                    for left in lhs:
                        for right in rhs:
                            if left not in cache['ontology']:
                                cache['ontology'][left] = set()
                            cache['ontology'][left].add(right)
                else:
                    print(parts)
                    print(f'WARNING: {line}')


def propagate_implications(cache):
    # TODO: better rules for identifying text vs tag implications
    implications_tags = {tag: set(local_implications) for tag, local_implications in cache['ontology'].items() if not tag.startswith('"')}
    implications_text = {tag: set(local_implications) for tag, local_implications in cache['ontology'].items() if tag.startswith('"')}
    if config.development_mode:
        for text in implications_text.keys():
            print(f'\t{text} => {implications_text[text]}')
    new_implications_added = True
    total_passes = 0
    while new_implications_added:
        total_passes += 1
        new_implications_added = False
        for tag, direct_implications in cache['ontology'].items():
            if tag in implications_tags:  # tag implications
                current_implications = implications_tags[tag]
                new_implications = set()
                for implied_tag in direct_implications:
                    for deeper_implication in implications_tags.get(implied_tag, set()):
                        if deeper_implication not in current_implications:
                            new_implications.add(deeper_implication)
                if new_implications:
                    implications_tags[tag].update(new_implications)
                    new_implications_added = True
            elif tag in implications_text:  # text implications
                # print(f'\ttag = {tag} TODO (extend implications)')
                current_implications = implications_text[tag]
                new_implications = set()
                for implied_tag in direct_implications:
                    for deeper_implication in implications_tags.get(implied_tag, set()):
                        if deeper_implication not in current_implications:
                            new_implications.add(deeper_implication)
                if new_implications:
                    implications_text[tag].update(new_implications)
                    new_implications_added = True
            else:
                raise Exception(f'tag {tag} not in implications nor implications_text')
    if config.development_mode:
        print(f'ontology calculated in {total_passes} passes')
    cache['implications'] = implications_tags
    cache['implications_text'] = implications_text
    # if config.development_mode:
    #     print('implications_text:')
    #     print(implications_text)


if __name__ == '__main__':
    # Example usage
    cache = {
        'ontology': {
            'A': {'B'},
            'B': {'C', 'D'},
            'D': {'E'},
            'E': {'F'},  # Adding deeper levels
            'F': {'G'}
        },
        'implications': {}
    }

    propagate_implications(cache)

    for tag, implication_set in cache['implications'].items():
        print(f'{tag} => {" ".join(implication_set)}')