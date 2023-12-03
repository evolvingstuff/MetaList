import copy
import time
from typing import List


class SnapshotFragment:
    def __init__(self, cache: dict, item_subitem_id: str, app_state: dict = None):
        self.item_hashes = set()
        for item in cache['id_to_item'].values():
            self.item_hashes.add(item['_hash'])
        self.item_subitem_id = item_subitem_id
        self.app_state = copy.deepcopy(app_state)


class Snapshot:
    def __init__(self, op_name: str, pre: SnapshotFragment, post: SnapshotFragment):
        self.op_name = op_name
        self.pre = pre
        self.post = post
        t1 = time.time()
        only_pre = self.pre.item_hashes - self.post.item_hashes
        only_post = self.post.item_hashes - self.pre.item_hashes
        t2 = time.time()
        print(f'\t{self.op_name} snapshot v2')
        if len(only_pre) > 0:
            for h in only_pre:
                print(f'\tpre:  {h}')
        if len(only_post) > 0:
            for h in only_post:
                print(f'\tpost: {h}')
        print(f'\tdiffs took {(t2-t1):.8f} seconds to calculate')


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
        return result

    def redo(self) -> Snapshot:
        result = None
        if self.stack_pointer < len(self.stack) - 1:
            self.stack_pointer += 1
            result = self.stack[self.stack_pointer]
        else:
            print('end of stack')
        return result

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
        for s, snapshot in enumerate(self.stack):
            if s == self.stack_pointer:
                print(f'\t>> {snapshot.op_name}')
            else:
                print(f'\t   {snapshot.op_name}')
