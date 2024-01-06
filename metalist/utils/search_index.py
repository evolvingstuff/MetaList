

class SearchIndex:
    def __init__(self):
        self.tag_to_item_ids = dict()
        self.item_id_to_tags = dict()
        # TODO: extend with text search as well?

    def remove_item(self, item):
        if item['id'] in self.item_id_to_tags:
            for tag in self.item_id_to_tags[item['id']]:
                self.tag_to_item_ids[tag].discard(item['id'])
            del self.item_id_to_tags[item['id']]

    def add_item(self, item):
        for tag in item['_tags']:
            if tag not in self.tag_to_item_ids:
                self.tag_to_item_ids[tag] = set()
            self.tag_to_item_ids[tag].add(item['id'])
            self.item_id_to_tags[item['id']] = set(item['_tags'])

    def possible_tag_continuations(self, partial_tag):
        result = set()
        if partial_tag is None or partial_tag == '':
            return result
        for tag in self.tag_to_item_ids.keys():
            if tag.startswith(partial_tag):
                result.add(tag)
        return result

    def calculate_candidate_item_ids(self, search_filter):
        # TODO: account for negative matches?
        ## one tricky part is that we cannot really tell at the item level
        ## to make it efficient, we would need to index at subitem level
        ## probably need subitem unique ids instead of just indices
        full_match_item_ids = None
        if len(search_filter['tags']) > 0:
            full_match_item_ids = set(self.item_id_to_tags.keys())
            for tag in search_filter['tags']:
                full_match_item_ids.intersection_update(self.tag_to_item_ids[tag])
            # print(f'{len(full_match_item_ids)} full match item ids')

        continuation_item_ids = None
        if search_filter['partial_tag'] is not None:
            continuations = self.possible_tag_continuations(search_filter['partial_tag'])
            # print(continuations)
            continuation_item_ids = set()
            for tag in continuations:
                continuation_item_ids.update(self.tag_to_item_ids[tag])
            # print(f'{len(continuation_item_ids)} continuation item ids')

        candidate_item_ids = set(self.item_id_to_tags.keys())
        if continuation_item_ids is not None:
            candidate_item_ids.intersection_update(continuation_item_ids)
        if full_match_item_ids is not None:
            candidate_item_ids.intersection_update(full_match_item_ids)
        # print(f'{len(candidate_item_ids)} candidate item ids')

        return candidate_item_ids

    def show(self):
        print(f'tag index contains {len(self.tag_to_item_ids)} keys')