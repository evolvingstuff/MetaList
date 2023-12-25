from typing import List


class SnapshotFragment:
    def __init__(self, cache: dict, item_subitem_id: str):
        self.item_hashes = set()
        for item in cache['id_to_item'].values():
            self.item_hashes.add(item['_hash'])
        self.item_subitem_id = item_subitem_id


class Snapshot:
    def __init__(self, op_name: str, pre: SnapshotFragment, post: SnapshotFragment):
        self.op_name = op_name
        self.pre = pre
        self.post = post


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
        # self.show()

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
