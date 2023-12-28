from typing import List


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

    def undo(self) -> Snapshot:
        result = None
        if self.stack_pointer < 0:
            # print('no stack')
            pass
        else:
            result = self.stack[self.stack_pointer]
            self.stack_pointer -= 1
        self.show()
        return result

    def redo(self) -> Snapshot:
        result = None
        if self.stack_pointer < len(self.stack) - 1:
            self.stack_pointer += 1
            result = self.stack[self.stack_pointer]
        else:
            print('end of stack')
        self.show()
        return result

    def reset(self):
        self.stack = []
        self.stack_pointer = -1
        self.show()

    def push(self, snapshot: Snapshot):
        self.stack = self.stack[:self.stack_pointer+1]
        self.stack.append(snapshot)
        self.stack_pointer += 1
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


def double_merge(op1, op2, snapshots):
    if snapshots.stack_pointer < 1:
        return False
    a, b = snapshots.stack[snapshots.stack_pointer - 1], \
        snapshots.stack[snapshots.stack_pointer]
    if a.item_subitem_id != b.item_subitem_id:
        return False
    if a.op_name == op1 and b.op_name == op2:
        print('=============================================')
        print(f'match on {op1} {op2}')
        print('pre:')
        snapshots.show()
        merged_snapshot = Snapshot(op1, a.pre, b.post, b.item_subitem_id)
        # point at new desired location
        snapshots.stack_pointer -= 1
        # remove a and b
        snapshots.stack.pop(snapshots.stack_pointer)
        snapshots.stack.pop(snapshots.stack_pointer)
        # add merged_snapshot
        snapshots.stack.insert(snapshots.stack_pointer, merged_snapshot)
        print('post')
        snapshots.show()
        print('=============================================')
        return True
    return False


def triple_merge(op1, op2, op3, snapshots):
    if snapshots.stack_pointer < 2:
        return False
    a, b, c = snapshots.stack[snapshots.stack_pointer - 2], \
        snapshots.stack[snapshots.stack_pointer - 1], \
        snapshots.stack[snapshots.stack_pointer]
    if a.item_subitem_id != b.item_subitem_id or a.item_subitem_id != c.item_subitem_id:
        return False
    if a.op_name == op1 and b.op_name == op2 and c.op_name == op3:
        print(f'match on {op1} {op2} {op3}')
        merged_snapshot = Snapshot(op1, a.pre, c.post, c.item_subitem_id)
        # point at new desired location
        snapshots.stack_pointer -= 2
        # remove a, b, and c
        snapshots.stack.pop(snapshots.stack_pointer)
        snapshots.stack.pop(snapshots.stack_pointer)
        snapshots.stack.pop(snapshots.stack_pointer)
        # add merged_snapshot
        snapshots.stack.insert(snapshots.stack_pointer, merged_snapshot)
        return True
    return False


double_patterns = [
    ['/update-tags', '/update-tags'],
    ['/update-subitem-content', '/update-subitem-content']
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


def compress_snapshots(snapshots: Snapshots):
    print('compress_snapshots()')
    matches = 0
    while True:
        for pattern in double_patterns:
            if double_merge(pattern[0], pattern[1], snapshots):
                matches += 1
                continue
        for pattern in triple_patterns:
            if triple_merge(pattern[0], pattern[1], pattern[2], snapshots):
                matches += 1
                continue
        if matches == 0:
            print('no compression matches found')
        else:
            snapshots.show()
        return
