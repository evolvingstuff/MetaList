# Documentation Index

## Start Here
- Project overview: `docs/AI-SUMMARY.md`
- Repo README: `README.md`

## Design
- Differential view (diff/snapshot payload): `docs/design/differential-view-protocol.md`
- In-memory store + read guard: `docs/design/in_memory_store.md`
- Ontology (long-term reference): `docs/design/ontology.md`
- Ontology rules (implemented v1 DSL): `docs/design/ontology-rules-v1.md`

## UI
- Keyboard + mouse controls: `docs/ui/controls.md`
- UUID note/file references (`![[UUID]]`, `[[UUID]]`): `docs/ui/references.md`
- External HTML paste sanitization: `docs/ui/paste-sanitization.md`
- Note content meta-tag formatting: `docs/ui/content-formatting.md`
- Search query syntax (verifier): `docs/ui/search-syntax.md`
- Search semantics (server behavior): `docs/ui/search-semantics.md`
- Tag bar grammar (tags/comments/wrappers): `docs/ui/tag-bar.md`
- Reminders: `docs/ui/reminders.md`
- Ollama/OpenAI chat: `docs/ui/ai-chat.md`
- Modal architecture pattern: `docs/ui/modals.md`
- Client state-handling philosophy: `docs/ui/state-handling.md`

## Security
- Auth + encryption design/notes: `docs/security/README.md`

- [Recovery runbook](security/recovery.md)
- [Supply-chain controls and audit](security/supply-chain.md)

## Testing
- Current testing status: `docs/testing/harness.md`

- [Current implementation/test/doc map](testing/coverage-map.md)

## Diagrams
- Mermaid sources: `docs/diagrams/`
- Render to PNG: `npm run render-diagrams` (outputs to `docs/diagrams/png/`)

## Project Tracking
- Known bugs: `docs/BUGS.md`
- Refactor notes: `docs/REFACTORS.md`
- TODO list: `docs/TODO.md`
- Future UI plan (toolbar): `docs/future-plans/PLAN.toolbar.md`

## Clients
- Electron packaging notes (planning doc): `docs/clients/electron.md`
