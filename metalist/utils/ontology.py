from metalist import config


def extract_ontology(cache, item):
    for subitem in item['subitems']:
        if '@implies' in subitem['tags']:
            data = subitem["data"]
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
                parts = line.split(' ')
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
    implications = {tag: set(implications) for tag, implications in cache['ontology'].items()}
    new_implications_added = True
    total_passes = 0
    while new_implications_added:
        total_passes += 1
        new_implications_added = False
        for tag, direct_implications in cache['ontology'].items():
            current_implications = implications[tag]
            new_implications = set()
            for implied_tag in direct_implications:
                for deeper_implication in implications.get(implied_tag, set()):
                    if deeper_implication not in current_implications:
                        new_implications.add(deeper_implication)
            if new_implications:
                implications[tag].update(new_implications)
                new_implications_added = True
    if config.development_mode:
        print(f'ontology calculated in {total_passes} passes')
    cache['implications'] = implications


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