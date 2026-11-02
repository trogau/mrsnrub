# Planning — project stages

Staged plan for turning the APK into a web-based Springfield. Each phase is a
self-contained doc with goals, scope, design, acceptance criteria and session
start notes, executable in its own session.

| Phase | Doc | Status |
|---|---|---|
| 1 — CDN Explorer (RE workbench) | [`phase-1-cdn-explorer.md`](phase-1-cdn-explorer.md) | ✅ done 2026-10-15 (M0–M4) |
| 2 — City renderer: camera-view basis | [`phase-2-camera-view.md`](phase-2-camera-view.md) | M0–M4 delivered; M5 rewritten → 2b |
| 2b — M5: integration & game UI (Pixi viewer is the game) | [`phase-2-m5-integration.md`](phase-2-m5-integration.md) | planned (scope signed off 2026-10-29; stages M5.0–M5.6) |
| 3 — Playable core (offline) | [`phase-3-playable-core.md`](phase-3-playable-core.md) | stub — UI scope seeded 2026-10-20, rest to be written |
| 4 — Depth & polish | (to be written) | planned |

Context that spans all phases: `notes/00`–`notes/04` (orientation, binary
formats, architecture, open work, server API), `server/` (the running fan
server's source — read-only ground truth), and the decisions logged in the
2026-10-13/14 sessions (offline-standalone end goal; fan server runs the
bodnjenie14 C++ codebase in `server/`; community protocol reference is
GameServer-Reborn's `TappedOut.proto`).
