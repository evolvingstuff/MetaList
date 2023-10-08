from utils.utils import annotate_item_match

blank_search_filter = {
    'tags': [],
    'texts': [],
    'partial_text': '',
    'partial_tag': '',
    'negated_tags': [],
    'negated_texts': [],
    'negated_partial_text': '',
    'negated_partial_tag': ''
}


def test_annotate_item_match_empty():
    mock_item = {
        'subitems': []
    }
    res = annotate_item_match(mock_item, blank_search_filter)
    assert res is False
