# Changelog

## 0.1.0 — 2026-09-19

Initial release.

- `jev_ask` tool: batched Choice/Score/Noul evaluation, per-request model, question linting, probability-bar rendering.
- `/jev` command: `enable · disable · status · test · models`.
- Budget rails: session attempt cap, persisted daily caps (requests / input tokens / USD).
- One retry on transient faults; response shape validation; content-free error messages.
