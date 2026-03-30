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
- Date of latest update: 2026-03-30
- Product goal: location-based multiplayer game platform, with Territory as the first mode
- Current implementation stage: Phase 3 error system and shared types complete

---

## What Has Been Done

## Phase 3 Progress

- Replaced placeholder shared exports with spec-aligned constants, error codes, event taxonomies, resource definitions, and entity interfaces
- Added typed win conditions as an array-only discriminated union in `shared/src/types.ts`
- Added `server/src/lib/errors.ts` with a shared-code-backed `AppError` class and centralized error response builder
- Wired the Fastify error handler in `server/src/app.ts` so application and schema validation failures now return the spec error shape
- Added server tests covering thrown `AppError` responses and normalized Fastify validation errors
- Updated the client scaffold to consume the new shared constant exports

---

## Phase 2 Progress

- Added native PostgreSQL ORM support with Drizzle in `server/`
- Added `compose.yml` with a `postgis/postgis:16-3.4` database service
- Added `server/drizzle.config.ts` and database scripts for generate/migrate/test-db lifecycle
- Implemented the Phase 2 schema in `server/src/db/schema.ts`
- Generated the initial SQL migration in `server/src/db/migrations/`
- Added a real `create-test-db` / `drop-test-db` flow using `pg`
- Verified the server package typechecks with the new ORM code
- Brought up the local PostGIS container successfully and verified the live databases

---

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
  - `Validate`
  - `DB Up`
  - `DB Down`
  - `DB Logs`
  - `DB Migrate`
  - `DB Test Create`
  - `DB Generate`

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
- Server tests passed, including AppError and validation-error coverage
- Full workspace build passed
- `pnpm db:up` works against the Docker-backed local database
- `pnpm db:migrate` completed successfully
- `pnpm db:test:create` completed successfully
- `postgis_version()` verified in both `territory` and `territory_test`

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
- In this Codex desktop session, the reported cwd for the patch tool was malformed; file edits had to be done through explicit WSL shell paths instead of `apply_patch`

Practical rule for now:

- from WSL, use plain `pnpm ...`
- from WebStorm on Windows, use the shared WSL-backed run configurations
- avoid using the old Windows `npm` / `pnpm` path for this repo

### Tooling Available

- Docker is installed on Windows: `Docker version 24.0.2`
- Docker Desktop daemon is now reachable from this environment through `docker.exe`
- WSL-native `docker` is still not installed in this distro, so repo scripts use a wrapper that falls back to `docker.exe` when needed
- `psql` is installed on Windows: `PostgreSQL 10.18`

### Repo / Workspace Notes

- There is still a top-level `src/` directory left over from the original stub, but the old `src/index.ts` file was removed
- `.DS_Store` exists in the repo and is currently tracked in git status
- local IDE files under `.idea/` also exist from earlier setup

---

## Small Plan Adjustments / Decisions

- One-off `tsx` scripts hit an ENOTSUP IPC error in this WSL/filesystem setup; using `node --import tsx` for DB scripts avoids that issue
- Root Docker scripts now use `scripts/docker-compose.sh`, which prefers Linux `docker compose` and falls back to `docker.exe compose` when Docker Desktop is available
- Chose `pnpm` for workspace management
- Added `concurrently` so root `dev` can run client and server together
- Added a Vite proxy rewrite so `/api/*` maps to server routes correctly during development
- Kept Phase 1 database scripts as placeholders rather than faking database setup before Phase 2
- Moved the preferred development environment from Windows PowerShell to WSL
- Added `GAME_RESUMED` and `game_resumed` to the shared event taxonomy to match the earlier plan decision around pause/resume lifecycle

These are implementation-level decisions, not product/spec changes.

---

## Known Gaps

- No monorepo README yet
- Local branch is still `master`; rename to `main` later if desired

---

## Recommended Next Steps

1. Proceed to Phase 4 auth middleware using the shared error codes and response contract.
2. Start attaching real route schemas so the centralized validation-error handler is exercised by application endpoints, not just tests.
3. Add migration-backed integration tests as service code starts depending on the database.

---

## Handoff Notes For The Next Agent

- Read `SPEC.md`, `PLAN.md`, and this file first.
- The monorepo scaffold is already in place and healthy in WSL.
- Use WSL as the source of truth for repo work.
- Use the Linux Node install from `nvm`, not the Windows Node install.
- If a shell does not see the Linux Node install, check `~/.profile` and `~/.bashrc`.
- The next highest-value work is Phase 4 auth middleware and the first real API surface on top of the shared contracts.
