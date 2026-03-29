# Project Log

## Purpose

This file is the running handoff log for the repo. Keep short, high-signal notes here:

- local environment quirks
- decisions made during implementation
- small plan adjustments
- blockers and workarounds
- current status and next steps

If the product direction or implementation plan changes in a major way, update [SPEC.md](E:/city game/SPEC.md) and/or [PLAN.md](E:/city game/PLAN.md) directly as the source of truth.

---

## Current Snapshot

- Repo: `E:\city game`
- WSL repo path: `/mnt/e/city game`
- Remote: `origin -> https://github.com/Saamoz/city-game.git`
- Current local branch: `master`
- Date of latest update: 2026-03-29
- Product goal: location-based multiplayer game platform, with Territory as the first mode
- Current implementation stage: Phase 1 scaffold complete and verified from WSL

---

## What Has Been Done

- Replaced the original single-package TypeScript stub with an npm workspace monorepo
- Created workspace packages:
  - `client/` for React + Vite + Tailwind
  - `server/` for Fastify + Vitest
  - `shared/` for common TypeScript exports
- Added root workspace config:
  - `package.json`
  - `pnpm-workspace.yaml`
  - `tsconfig.base.json`
  - root `tsconfig.json` with project references
- Added `.env.example` based on spec env vars
- Added minimal Phase 1 implementations:
  - client renders a Territory scaffold page
  - server exposes `GET /health`
  - server has a working Vitest test for `/health`
  - shared exports placeholder constants/types/errors/events/resources
- Installed workspace dependencies and generated `pnpm-lock.yaml`
- Converted the repo to a WSL-first workflow:
  - installed Linux `nvm`
  - installed Linux `node v20.20.2`
  - enabled `pnpm v10.33.0`
  - reinstalled workspace dependencies from WSL
  - updated WebStorm run configs to launch via `wsl.exe` into the `Ubuntu` distro
- Added shared WebStorm run configurations under `.idea/runConfigurations/` for:
  - `Dev All`
  - `Dev Client`
  - `Dev Server`
  - `Typecheck`
  - `Server Tests`
  - `Build`

---

## Validation Completed

Verified successfully from WSL:

```bash
pnpm -r typecheck
pnpm --filter @city-game/server test
pnpm -r build
```

Results:

- Workspace typecheck passed
- Server test passed
- Full workspace build passed

---

## Environment Quirks

### WSL / Node / Package Manager

- Development should now be treated as WSL-first, not Windows-first
- `Ubuntu` is now running as **WSL 2**
- The original Linux `node` on this distro was unusable (`Exec format error`)
- Installed `nvm` in `/home/saamo/.nvm`
- Installed Linux `node v20.20.2`
- Installed `npm v10.8.2`
- Enabled `pnpm v10.33.0` through Corepack
- Updated shell startup so login shells load `nvm` automatically
- WebStorm run configurations now call into WSL directly and no longer depend on PowerShell or the Windows Node install

Practical rule for now:

- from WSL, use plain `pnpm ...`
- from WebStorm on Windows, use the shared WSL-backed run configurations
- avoid using the old Windows `npm` / `pnpm` path for this repo

### Tooling Available

- Docker is installed on Windows: `Docker version 24.0.2`
- Docker emitted a warning reading `C:\Users\saamo\.docker\config.json` due to access denial when checked from Windows earlier
- `psql` is installed on Windows: `PostgreSQL 10.18`

### Repo / Workspace Notes

- There is still a top-level `src/` directory left over from the original stub, but the old `src/index.ts` file was removed
- `.DS_Store` exists in the repo and is currently tracked in git status
- local IDE files under `.idea/` also exist from earlier setup

---

## Small Plan Adjustments / Decisions

- Chose `pnpm` for workspace management
- Added `concurrently` so root `dev` can run client and server together
- Added a Vite proxy rewrite so `/api/*` maps to server routes correctly during development
- Kept Phase 1 database scripts as placeholders rather than faking database setup before Phase 2
- Moved the preferred development environment from Windows PowerShell to WSL

These are implementation-level decisions, not product/spec changes.

---

## Known Gaps

- Phase 1 test DB lifecycle scripts are placeholders only:
  - `server/src/db/scripts/create-test-db.ts`
  - `server/src/db/scripts/drop-test-db.ts`
- No real Postgres/PostGIS integration yet
- No monorepo README yet
- Remote is configured, but the repo has not been pushed from this session
- Local branch is still `master`; rename to `main` later if desired

---

## Recommended Next Steps

1. Decide whether to rename local branch `master` to `main` before first push.
2. Set up local Postgres/PostGIS strategy for development and tests.
3. Start Phase 2:
   - Drizzle setup
   - schema definition
   - migrations
   - test database automation
4. Once Phase 2 begins, replace placeholder DB scripts with real creation/teardown logic.

---

## Handoff Notes For The Next Agent

- Read `SPEC.md`, `PLAN.md`, and this file first.
- The monorepo scaffold is already in place and healthy in WSL.
- Use WSL as the source of truth for repo work.
- Use the Linux Node install from `nvm`, not the Windows Node install.
- If a shell does not see the Linux Node install, check `~/.profile` and `~/.bashrc`.
- The next highest-value work is local database setup and Phase 2 schema/migration implementation.
