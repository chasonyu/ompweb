# Session management changes

Branch: `feat/session-management`. Official source remains the `upstream` remote.

## Titles

OMP's RPC UI disables native automatic title generation. After a completed turn,
the web client asks the existing auto-name endpoint to name an untitled session.
The endpoint preserves existing titles, otherwise scans complete JSONL records
until the first non-synthetic user message with text. Long system/initialization
records before the user message no longer exhaust the 4 KiB list-preview window.
The normal session-list scan remains bounded for performance.

Titles use the first user-message line, capped at 60 Unicode code points. This
is a deterministic fallback, not an additional AI request. A live OMP process
persists through `set_session_name`; file-only sessions update their title slot.
Files beyond the existing 1 GiB load ceiling return 413. Failed automatic naming
can be retried with the existing title button.

## Pins

Use the session action menu to pin/unpin. A Pinned section provides shortcuts
above the workspaces, newest pin first, while the original project/fork tree
remains intact. Search, running filters and hidden projects also apply to pins.

Preferences are written atomically to `web-session-pins.json` in the configured
OMP agent directory (normally `~/.omp/agent`). They survive page/server restarts
and are shared by browsers of this server; other browsers see changes on refresh.
Deleted/archived sessions are excluded from the visible pins; restoring an
archived session restores its pin. A corrupt preferences file is not overwritten.
This is a single-user server preference, not a per-browser or per-account list.

## Validation

Run `npm run typecheck`, `npm run lint`, and `npm test`.
Focused tests: `lib/session-auto-name.test.mjs`, `lib/session-pins.test.mjs`,
`lib/session-title.test.mjs`, and `components/SessionSidebar-pins.test.mjs`.
Use `npm run dev` for previews; do not run a production build during development.

To incorporate upstream changes, commit local work, then run:

```sh
git fetch upstream
git merge upstream/main
```
