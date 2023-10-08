from utils.utils import filter_item

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


def test_filter_item_empty():
    mock_item = {
        'subitems': []
    }
    res = filter_item(mock_item, blank_search_filter)
    assert res is False
