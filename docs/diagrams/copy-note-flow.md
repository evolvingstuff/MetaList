# Copy Note Flow

High-level flow: if the currently edited note is dirty, save first so the copied note includes the latest edits.

Related behavior: Cmd+X (cut note when no selection) uses the same copy flow and then deletes the note (undoable via delete-subtree undo).
Related behavior: Cmd+R uses the copied note UUID from this flow (`note_id` in copy response) to copy as embedded reference (`![[UUID]]`) while editing.
Related behavior: Cmd+V into a target note with no visible content and no children replaces that target with the copied root note, while preserving/merging the target's context tags with the copied root tags using case-insensitive dedupe.
Direct unresolved tag proposals are part of the internal clipboard subtree and survive copy, duplication, normal paste, and blank-target replacement. They remain separate from accepted tags and are not rendered into the system clipboard's human-readable HTML/plain-text forms.

```mermaid
sequenceDiagram
    participant U as User
    participant Browser as Browser
    participant Client as Client UI (ModeManager)
    participant API as API Client
    participant Server as FastAPI (/api2)
    participant Update as CmdUpdateContent
    participant Copy as CmdCopyNote
    participant Store as NoteStore
    participant DB as SQLite

    U->>Browser: Cmd+C while editing
    Browser->>Client: key handler

    alt Text is selected
        Client-->>Browser: allow default copy
        Browser-->>Browser: system clipboard updated
    else No text selected
        Client->>Client: treat as "copy note"
        Client->>Browser: start promised text/html + text/plain clipboard write

        alt Note is dirty
            Client->>API: PUT /api2/notes/{id} {clientId, content}
            API->>Server: PUT /api2/notes/{id}
            Server->>Update: execute()
            Update->>DB: persist encrypted content
            Update->>Store: update in-memory content
            Update-->>Server: success
            Server-->>API: 200 OK
            API-->>Client: mark clean
        end

        Client->>API: POST /api2/notes/{id}/copy {clientId}
        API->>Server: POST /api2/notes/{id}/copy
        Server->>Copy: execute()
        Copy->>Store: read subtree
        Copy-->>Server: clipboard payload + copied note_id
        Server-->>API: 200 OK
        API-->>Client: clipboard payload resolves promised system write (+ copied UUID for Cmd+R)
        Client-->>Browser: system clipboard receives rendered HTML + tab-indented plain text
    end
```

## Embedded document copy semantics

The internal subtree clipboard also snapshots directly embedded diagram payloads.
Each normal paste clones once per distinct document and rewrites the copied tokens,
including child/sibling and blank-target paste. Snapshot timing is copy time; later
source edits do not alter the copy. Cmd+R keeps original note/document identity.
Document cloning does not follow other embedded note references. Undo/redo restores
the same cloned UUIDs. See `../ui/diagram-widgets.md`.
