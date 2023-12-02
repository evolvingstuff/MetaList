from dataclasses import dataclass, field
from typing import List


@dataclass
class Snapshot:
    op_name: str
    pre_app_state: dict
    pre_op_selected_item_subitem_id: str = None
    post_op_selected_item_subitem_id: str = None
    pre_op_items: list = field(default_factory=list)
    post_op_items: list = field(default_factory=list)


class Snapshots:
    def __init__(self):
        self.stack: List[Snapshot] = list()
        self.stack_pointer: int = -1

    def undo(self):
        result = None
        if self.stack_pointer < 0:
            print('no stack')
        else:
            result = self.stack[self.stack_pointer]
            self.stack_pointer -= 1
        return result

    def redo(self):
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
            pre_op_ids = [item["id"] for item in snapshot.pre_op_items]
            post_op_ids = [item["id"] for item in snapshot.post_op_items]
            print(f'\t\tpre-op:  {pre_op_ids}')
            print(f'\t\tpost-op: {post_op_ids}')