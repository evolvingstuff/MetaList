"""Iterative hierarchy checks shared by hydration and live database writes."""

MAX_HIERARCHY_DEPTH = 256


class HierarchyError(ValueError):
    pass


def hierarchy_depths(parents):
    depths = {}
    for start in parents:
        chain = []
        visiting = set()
        current = start
        while current is not None and current not in depths:
            if current in visiting:
                raise HierarchyError('Note hierarchy contains a cycle')
            if current not in parents:
                raise HierarchyError('Note hierarchy references a missing parent')
            visiting.add(current)
            chain.append(current)
            current = parents[current]
        depth = 0
        if current is not None:
            depth = depths[current]
        for note_id in reversed(chain):
            depth += 1
            if depth > MAX_HIERARCHY_DEPTH:
                raise HierarchyError(f'Notes support at most {MAX_HIERARCHY_DEPTH} hierarchy levels')
            depths[note_id] = depth
    return depths


def validate_database_parent(connection, note_id, parent_id, *, is_new):
    """Bounded topology reads before a write; never inspect or modify backups."""
    if not is_new:
        existing = connection.execute('SELECT parent_id FROM notes WHERE id=?', (note_id,)).fetchone()
        if existing is not None and existing[0] == parent_id:
            return
    parent_depth = 0
    if parent_id is not None:
        ancestors = connection.execute('''
            WITH RECURSIVE ancestors(id, parent_id, depth) AS (
                SELECT id, parent_id, 1 FROM notes WHERE id=?
                UNION ALL SELECT notes.id, notes.parent_id, ancestors.depth+1
                FROM notes JOIN ancestors ON notes.id=ancestors.parent_id
                WHERE ancestors.depth<=?
            ) SELECT id, depth FROM ancestors
        ''', (parent_id, MAX_HIERARCHY_DEPTH)).fetchall()
        if not ancestors:
            raise HierarchyError('Destination parent does not exist')
        if any(row[0] == note_id for row in ancestors):
            raise HierarchyError('A note cannot be moved inside its own subtree')
        parent_depth = max(row[1] for row in ancestors)
    height = 1
    if not is_new:
        height = connection.execute('''
            WITH RECURSIVE descendants(id, depth) AS (
                SELECT id, 1 FROM notes WHERE id=?
                UNION ALL SELECT notes.id, descendants.depth+1
                FROM notes JOIN descendants ON notes.parent_id=descendants.id
                WHERE descendants.depth<=?
            ) SELECT max(depth) FROM descendants
        ''', (note_id, MAX_HIERARCHY_DEPTH)).fetchone()[0]
        if height is None:
            raise HierarchyError('Note does not exist')
    if parent_depth + height > MAX_HIERARCHY_DEPTH:
        raise HierarchyError(f'Notes support at most {MAX_HIERARCHY_DEPTH} hierarchy levels')
