from typing import List
from metalist import config
from metalist.utils.reporting import analyze_cache


class SnapshotFragment:
    def __init__(self, cache: dict, item_subitem_id: str):
        self.item_hashes = set()
        for item in cache['id_to_item'].values():
            self.item_hashes.add(item['_hash'])
        self.item_subitem_id = item_subitem_id


class Snapshot:
    def __init__(self, op_name: str, pre: SnapshotFragment, post: SnapshotFragment, item_subitem_id: str):
        self.op_name = op_name
        self.pre = pre
        self.post = post
        self.item_subitem_id = item_subitem_id


class Snapshots:
    def __init__(self):
        self.stack: List[Snapshot] = list()
        self.stack_pointer: int = -1

    def test(self):
        if not config.development_mode:
            return
        try:
            for i in range(len(self.stack)-1):
                assert self.stack[i].post.item_hashes == self.stack[i+1].pre.item_hashes, 'inconsistent history stack'
            print('consistent history (passed test)')
        except Exception as e:
            print(e)

    def undo(self) -> Snapshot:
        result = None
        if self.stack_pointer < 0:
            # print('no stack')
            pass
        else:
            result = self.stack[self.stack_pointer]
            self.stack_pointer -= 1
        if config.development_mode:
            self.show()
        return result

    def redo(self) -> Snapshot:
        result = None
        if self.stack_pointer < len(self.stack) - 1:
            self.stack_pointer += 1
            result = self.stack[self.stack_pointer]
        else:
            if config.development_mode:
                print('end of stack')
        if config.development_mode:
            self.show()
        return result

    def reset(self):
        self.stack = []
        self.stack_pointer = -1
        if config.development_mode:
            self.show()

    def push(self, snapshot: Snapshot):
        self.stack = self.stack[:self.stack_pointer+1]
        self.stack.append(snapshot)
        self.stack_pointer += 1
        if config.development_mode:
            self.show()

    def show(self):
        if len(self.stack) == 0:
            print('No snapshots')
            return
        print('snapshot stack:')
        if self.stack_pointer == -1:
            print(f'\t[ ] >> ')
        else:
            print(f'\t[ ]')
        for s, snapshot in enumerate(self.stack):
            if s == self.stack_pointer:
                print(f'\t[{s}] >> {snapshot.op_name}')
            else:
                print(f'\t[{s}]    {snapshot.op_name}')


def clean_up_memory(merged_snapshot: Snapshot, starting_nodes: List[Snapshot], cache: dict):
    keep_hashes = set()
    keep_hashes.update(merged_snapshot.pre.item_hashes)
    maybe_remove_hashes = set()
    maybe_remove_hashes.update(starting_nodes[0].post.item_hashes)
    for node in starting_nodes[1:-1]:
        maybe_remove_hashes.update(node.pre.item_hashes)  # technically redundant
        maybe_remove_hashes.update(node.post.item_hashes)
    maybe_remove_hashes.update(starting_nodes[-1].pre.item_hashes)
    definitely_remove_hashes = maybe_remove_hashes - keep_hashes
    for remove_this_hash in definitely_remove_hashes:
        assert remove_this_hash in cache['hash_to_item'], 'data integrity problem'
        del cache['hash_to_item'][remove_this_hash]


def double_merge(op1, op2, cache, snapshots):
    if snapshots.stack_pointer < 1:
        return False
    a, b = snapshots.stack[snapshots.stack_pointer - 1], \
        snapshots.stack[snapshots.stack_pointer]
    if a.item_subitem_id != b.item_subitem_id:
        return False
    if a.op_name == op1 and b.op_name == op2:
        if config.development_mode:
            snapshots.show()
        merged_snapshot = Snapshot(op1, a.pre, b.post, b.item_subitem_id)
        # point at new desired location
        snapshots.stack_pointer -= 1
        # remove a and b
        snapshots.stack.pop(snapshots.stack_pointer)
        snapshots.stack.pop(snapshots.stack_pointer)
        # add merged_snapshot
        snapshots.stack.insert(snapshots.stack_pointer, merged_snapshot)
        clean_up_memory(merged_snapshot, [a, b], cache)
        return True
    return False


def triple_merge(op1, op2, op3, cache, snapshots):
    if snapshots.stack_pointer < 2:
        return False
    a, b, c = snapshots.stack[snapshots.stack_pointer - 2], \
        snapshots.stack[snapshots.stack_pointer - 1], \
        snapshots.stack[snapshots.stack_pointer]
    if a.item_subitem_id != b.item_subitem_id or a.item_subitem_id != c.item_subitem_id:
        return False
    if a.op_name == op1 and b.op_name == op2 and c.op_name == op3:
        merged_snapshot = Snapshot(op1, a.pre, c.post, c.item_subitem_id)
        # point at new desired location
        snapshots.stack_pointer -= 2
        # remove a, b, and c
        snapshots.stack.pop(snapshots.stack_pointer)
        snapshots.stack.pop(snapshots.stack_pointer)
        snapshots.stack.pop(snapshots.stack_pointer)
        # add merged_snapshot
        snapshots.stack.insert(snapshots.stack_pointer, merged_snapshot)
        clean_up_memory(merged_snapshot, [a, b, c], cache)
        return True
    return False


def quad_merge(op1, op2, op3, op4, cache, snapshots):
    if snapshots.stack_pointer < 3:
        return False
    a, b, c, d = snapshots.stack[snapshots.stack_pointer - 3], \
        snapshots.stack[snapshots.stack_pointer - 2], \
        snapshots.stack[snapshots.stack_pointer - 1], \
        snapshots.stack[snapshots.stack_pointer]
    if a.item_subitem_id != b.item_subitem_id or \
            a.item_subitem_id != c.item_subitem_id or \
            a.item_subitem_id != d.item_subitem_id:
        return False
    if a.op_name == op1 and b.op_name == op2 and c.op_name == op3 and d.op_name == op4:
        merged_snapshot = Snapshot(op2, b.pre, d.post, d.item_subitem_id)
        # point at new desired location
        snapshots.stack_pointer -= 2
        # remove b, c, and d
        snapshots.stack.pop(snapshots.stack_pointer)
        snapshots.stack.pop(snapshots.stack_pointer)
        snapshots.stack.pop(snapshots.stack_pointer)
        # add merged_snapshots
        snapshots.stack.insert(snapshots.stack_pointer, merged_snapshot)
        clean_up_memory(merged_snapshot, [a, b, c, d], cache)
        return True
    return False


double_patterns = [
    ['/update-tags', '/update-tags'],
    ['/update-subitem-content', '/update-subitem-content'],
    ['/open-to', '/open-to']
]

triple_patterns = [
    ['/todo', '/done', '/todo'],
    ['/done', '/todo', '/done'],
    ['/expand', '/collapse', '/expand'],
    ['/collapse', '/expand', '/collapse'],
    ['/indent', '/outdent', '/indent'],
    ['/outdent', '/indent', '/outdent'],
    ['/move-item-up', '/move-item-down', '/move-item-up'],
    ['/move-item-down', '/move-item-up', '/move-item-down'],
    ['/move-subitem-up', '/move-subitem-down', '/move-subitem-up'],
    ['/move-subitem-down', '/move-subitem-up', '/move-subitem-down']
]

quad_patterns = [
    ['/todo', '/done', '/todo', '/done'],
    ['/done', '/todo', '/done', '/todo'],
    ['/expand', '/collapse', '/expand', '/collapse'],
    ['/collapse', '/expand', '/collapse', '/expand'],
    ['/indent', '/outdent', '/indent', '/outdent'],
    ['/outdent', '/indent', '/outdent', '/indent'],
    ['/move-item-up', '/move-item-down', '/move-item-up', '/move-item-down'],
    ['/move-item-down', '/move-item-up', '/move-item-down', '/move-item-up'],
    ['/move-subitem-up', '/move-subitem-down', '/move-subitem-up', '/move-subitem-down'],
    ['/move-subitem-down', '/move-subitem-up', '/move-subitem-down', '/move-subitem-up']
]


def compress_snapshots(cache: dict, snapshots: Snapshots):
    if config.development_mode:
        print('compress_snapshots()')
        analyze_cache(cache)
        snapshots.test()
    matches = 0
    while True:
        for pattern in double_patterns:
            if double_merge(pattern[0], pattern[1], cache, snapshots):
                matches += 1
                continue
        # for pattern in triple_patterns:
        #     if triple_merge(pattern[0], pattern[1], pattern[2], cache, snapshots):
        #         matches += 1
        #         continue
        for pattern in quad_patterns:
            if quad_merge(pattern[0], pattern[1], pattern[2], pattern[3], cache, snapshots):
                matches += 1
                continue
        if matches == 0:
            if config.development_mode:
                print('no compression matches found')
        else:
            if config.development_mode:
                snapshots.show()
        if config.development_mode:
            snapshots.test()
            analyze_cache(cache)
        return
