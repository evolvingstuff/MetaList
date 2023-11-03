

def swap_subtrees(item, a, b, c, d):
    """
    Rearrange the subitems based on swapping two subtrees
    """
    subitems = item['subitems']
    assert a > 0
    assert a <= b
    assert b + 1 == c
    assert c <= d
    assert d < len(subitems)
    rearranged_subitems = list()
    rearranged_subitems.extend(subitems[0:a])
    rearranged_subitems.extend(subitems[c:d+1])
    rearranged_subitems.extend(subitems[a:b+1])
    if d < len(subitems) - 1:
        rearranged_subitems.extend(subitems[d+1:])
    print('---------------------------------------------')
    assert len(subitems) == len(rearranged_subitems), f'length mismatch: original = {len(subitems)} | swapped = {len(rearranged_subitems)}'
    item['subitems'] = rearranged_subitems
