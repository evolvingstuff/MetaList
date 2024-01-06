from metalist.utils.find import find_subtree_bounds, find_sibling_index_above, find_sibling_index_below
from metalist.utils.update_single_item import _swap_subtrees
from metalist.utils.decorate_single_item import calculate_matches_per_item

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
    res = calculate_matches_per_item(mock_item, blank_search_filter)
    assert res is False


def test_subtree_bounds():
    mock_item = {
        'subitems': [
            {'indent': 0},
            {'indent': 1},
            {'indent': 2},
            {'indent': 1}
        ]
    }
    upper_bound, lower_bound = find_subtree_bounds(mock_item, 0)
    assert upper_bound == 0 and lower_bound == 3
    upper_bound, lower_bound = find_subtree_bounds(mock_item, 1)
    assert upper_bound == 1 and lower_bound == 2
    upper_bound, lower_bound = find_subtree_bounds(mock_item, 2)
    assert upper_bound == 2 and lower_bound == 2
    upper_bound, lower_bound = find_subtree_bounds(mock_item, 3)
    assert upper_bound == 3 and lower_bound == 3


def test_find_sibling_index_above():
    mock_item = {
        'subitems': [
            {'indent': 0},
            {'indent': 1},
            {'indent': 2},
            {'indent': 1}
        ]
    }
    sibling = find_sibling_index_above(mock_item, 0)
    assert sibling is None
    sibling = find_sibling_index_above(mock_item, 1)
    assert sibling is None
    sibling = find_sibling_index_above(mock_item, 2)
    assert sibling is None
    sibling = find_sibling_index_above(mock_item, 3)
    assert sibling == 1


def test_find_sibling_index_below():
    mock_item = {
        'subitems': [
            {'indent': 0},
            {'indent': 1},
            {'indent': 2},
            {'indent': 1}
        ]
    }
    sibling = find_sibling_index_below(mock_item, 0)
    assert sibling is None
    sibling = find_sibling_index_below(mock_item, 1)
    assert sibling == 3
    sibling = find_sibling_index_below(mock_item, 2)
    assert sibling is None
    sibling = find_sibling_index_below(mock_item, 3)
    assert sibling is None


def test_swap_subtrees_w_subtree_at_end():
    mock_item = {
        'subitems': [
            {'mock_id': 1, 'indent': 0},
            {'mock_id': 2, 'indent': 1},
            {'mock_id': 3, 'indent': 2},
            {'mock_id': 4, 'indent': 1},
            {'mock_id': 5, 'indent': 1}
        ]
    }
    mock_item_goal_state = {
        'subitems': [
            {'mock_id': 1, 'indent': 0},
            {'mock_id': 4, 'indent': 1},
            {'mock_id': 2, 'indent': 1},
            {'mock_id': 3, 'indent': 2},
            {'mock_id': 5, 'indent': 1}
        ]
    }
    _swap_subtrees(mock_item, 1, 2, 3, 3)
    assert mock_item == mock_item_goal_state


def test_swap_subtrees_w_no_subtree_at_end():
    mock_item = {
        'subitems': [
            {'mock_id': 1, 'indent': 0},
            {'mock_id': 2, 'indent': 1},
            {'mock_id': 3, 'indent': 2},
            {'mock_id': 4, 'indent': 1}
        ]
    }
    mock_item_goal_state = {
        'subitems': [
            {'mock_id': 1, 'indent': 0},
            {'mock_id': 4, 'indent': 1},
            {'mock_id': 2, 'indent': 1},
            {'mock_id': 3, 'indent': 2}
        ]
    }
    _swap_subtrees(mock_item, 1, 2, 3, 3)
    assert mock_item == mock_item_goal_state


# def test_add_subitem_sibling():
#     mock_item = {
#         'subitems': [
#             {'indent': 0},
#             {'indent': 1},
#             {'indent': 2},
#             {'indent': 1}
#         ]
#     }
#     mock_item_goal_state = {
#         'subitems': [
#             {'indent': 0},
#             {'indent': 1},
#             {'indent': 2},
#             {'indent': 1},
#             {'indent': 1}
#         ]
#     }
#     add_subitem_sibling(mock_item, 1)
#     assert mock_item == mock_item_goal_state
