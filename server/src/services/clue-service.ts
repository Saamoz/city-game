import { randomInt } from 'node:crypto';
import { and, asc, count, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  errorCodes,
  eventTypes,
  type AdminClueStatus,
  type ClueFragment,
  type ClueImageSummary,
  type ClueImageUpload,
  type TeamClue,
} from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { challengeClaims, challenges, challengeSetItems, clueImages, clueImageTiles, games } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { appendEvents } from './event-service.js';
import { getGameById, lockGameById, serializeGameRecord } from './game-service.js';

// The final clue. Before the game the admin uploads candidate pictures, already cut by their browser
// into one tile per challenge in the game's set (no set, no clue). Starting the game secretly picks one. The first time
// a challenge is completed it is given a random fragment nobody has yet, and every team with a
// completed (or, for judged challenges, submitted) claim on it can see that fragment. Nothing the
// admin endpoints return says which picture was picked, so the admin can play too. At the end the
// admin reveals the clue, which shows every found fragment to every team.

const FOUND_CLAIM_STATUSES = ['completed', 'submitted'];
const TILE_DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_TILE_LENGTH = 4 * 1024 * 1024;
const MAX_THUMBNAIL_LENGTH = 256 * 1024;

export async function getAdminClueStatus(db: DatabaseClient, gameId: string): Promise<AdminClueStatus> {
  const game = await getGameById(db, gameId);
  const imageRows = await db.select().from(clueImages).where(eq(clueImages.gameId, gameId)).orderBy(asc(clueImages.createdAt));
  const found = await loadFoundFragments(db, gameId);
  return {
    fragmentCount: await getSetFragmentCount(db, game.challengeSetId),
    images: imageRows.map(serializeClueImage),
    isChosen: imageRows.some((row) => row.isSelected),
    foundFragmentCount: found.size,
    revealedAt: game.clueRevealedAt?.toISOString() ?? null,
  };
}

export async function addClueImage(db: DatabaseClient, gameId: string, upload: ClueImageUpload): Promise<ClueImageSummary> {
  const game = await lockGameById(db, gameId);
  assertSetup(game.status);
  const fragmentCount = await getSetFragmentCount(db, game.challengeSetId);
  if (!fragmentCount) {
    throw new AppError(errorCodes.validationError, { message: 'Choose a challenge set with challenges before adding clue pictures.' });
  }
  if (upload.tiles.length !== fragmentCount) {
    throw new AppError(errorCodes.validationError, { message: `The challenge set has ${fragmentCount} challenges, so a clue picture needs exactly ${fragmentCount} fragments.` });
  }
  if (upload.thumbnail.length > MAX_THUMBNAIL_LENGTH || !TILE_DATA_URL.test(upload.thumbnail)) {
    throw new AppError(errorCodes.validationError, { message: 'The thumbnail must be a small JPEG, PNG or WebP data URL.' });
  }
  const tiles = upload.tiles.map((tile, index) => {
    const match = tile.length <= MAX_TILE_LENGTH ? TILE_DATA_URL.exec(tile) : null;
    if (!match) throw new AppError(errorCodes.validationError, { message: `Fragment ${index + 1} must be a JPEG, PNG or WebP data URL under 4 MB.` });
    return { tileIndex: index, contentType: match[1]!, data: match[2]! };
  });

  const [image] = await db.insert(clueImages).values({ gameId, width: upload.width, height: upload.height, fragmentCount, thumbnail: upload.thumbnail }).returning();
  await db.insert(clueImageTiles).values(tiles.map((tile) => ({ ...tile, imageId: image!.id })));
  return serializeClueImage(image!);
}

export async function deleteClueImage(db: DatabaseClient, imageId: string): Promise<string> {
  const [image] = await db.select({ gameId: clueImages.gameId }).from(clueImages).where(eq(clueImages.id, imageId)).limit(1);
  if (!image) throw new AppError(errorCodes.validationError, { message: 'Clue picture not found.' });
  const game = await lockGameById(db, image.gameId);
  assertSetup(game.status);
  await db.delete(clueImages).where(eq(clueImages.id, imageId));
  return image.gameId;
}

// Called while starting the game, after the set's challenges are copied in. Pictures cut for a
// different number of challenges (the set changed after they were added) are only a fallback.
export async function chooseClueImage(db: DatabaseClient, gameId: string): Promise<void> {
  const imageRows = await db.select({ id: clueImages.id, isSelected: clueImages.isSelected, fragmentCount: clueImages.fragmentCount }).from(clueImages).where(eq(clueImages.gameId, gameId));
  if (imageRows.length === 0 || imageRows.some((row) => row.isSelected)) return;
  const [challengeCount] = await db.select({ total: count() }).from(challenges).where(eq(challenges.gameId, gameId));
  const matching = imageRows.filter((row) => row.fragmentCount === Number(challengeCount?.total ?? 0));
  const pool = matching.length ? matching : imageRows;
  const chosen = pool[randomInt(pool.length)]!;
  await db.update(clueImages).set({ isSelected: true }).where(eq(clueImages.id, chosen.id));
}

// Called inside a completion, which already holds the game row lock, so two completions never
// hand out the same fragment. Once every fragment is out, further challenges get none.
export async function assignClueFragment(db: DatabaseClient, gameId: string, challengeId: string): Promise<number | null> {
  const [image] = await db.select({ fragmentCount: clueImages.fragmentCount }).from(clueImages).where(and(eq(clueImages.gameId, gameId), eq(clueImages.isSelected, true))).limit(1);
  if (!image) return null;
  const [challenge] = await db.select({ clueFragmentIndex: challenges.clueFragmentIndex }).from(challenges).where(eq(challenges.id, challengeId)).limit(1);
  if (!challenge) return null;
  if (challenge.clueFragmentIndex !== null) return challenge.clueFragmentIndex;

  const usedRows = await db.select({ index: challenges.clueFragmentIndex }).from(challenges).where(and(eq(challenges.gameId, gameId), isNotNull(challenges.clueFragmentIndex)));
  const used = new Set(usedRows.map((row) => row.index));
  const free = Array.from({ length: image.fragmentCount }, (_, index) => index).filter((index) => !used.has(index));
  if (free.length === 0) return null;
  const index = free[randomInt(free.length)]!;
  await db.update(challenges).set({ clueFragmentIndex: index }).where(and(eq(challenges.id, challengeId), isNull(challenges.clueFragmentIndex)));
  return index;
}

// The fragments the viewer's team found, or every found fragment once the clue is revealed.
// Null when the game has no clue.
export async function getTeamClue(db: DatabaseClient, gameId: string, teamId: string | null): Promise<TeamClue | null> {
  const game = await getGameById(db, gameId);
  const [image] = await db.select().from(clueImages).where(and(eq(clueImages.gameId, gameId), eq(clueImages.isSelected, true))).limit(1);
  if (!image) return null;

  const revealed = game.clueRevealedAt !== null;
  const fragments: ClueFragment[] = [];
  for (const [index, found] of [...(await loadFoundFragments(db, gameId)).entries()].sort(([left], [right]) => left - right)) {
    if (!revealed && (!teamId || !found.teamIds.includes(teamId))) continue;
    fragments.push({
      index,
      url: `/api/v1/game/${gameId}/clue/fragments/${index}`,
      challengeTitle: found.challengeTitle,
      teamIds: revealed ? found.teamIds : [teamId!],
    });
  }

  return {
    width: image.width,
    height: image.height,
    fragmentCount: image.fragmentCount,
    revealedAt: game.clueRevealedAt?.toISOString() ?? null,
    fragments,
  };
}

export async function getClueFragmentImage(db: DatabaseClient, gameId: string, teamId: string | null, index: number): Promise<{ contentType: string; data: Buffer }> {
  const clue = await getTeamClue(db, gameId, teamId);
  if (!clue || !clue.fragments.some((fragment) => fragment.index === index)) throw new AppError(errorCodes.clueFragmentNotFound);
  const [tile] = await db
    .select({ contentType: clueImageTiles.contentType, data: clueImageTiles.data })
    .from(clueImageTiles)
    .innerJoin(clueImages, eq(clueImages.id, clueImageTiles.imageId))
    .where(and(eq(clueImages.gameId, gameId), eq(clueImages.isSelected, true), eq(clueImageTiles.tileIndex, index)))
    .limit(1);
  if (!tile) throw new AppError(errorCodes.clueFragmentNotFound);
  return { contentType: tile.contentType, data: Buffer.from(tile.data, 'base64') };
}

export async function setClueRevealed(db: DatabaseClient, gameId: string, revealed: boolean) {
  const game = await lockGameById(db, gameId);
  if (game.status === 'setup') {
    throw new AppError(errorCodes.validationError, { message: 'The clue can only be revealed once the game has started.' });
  }
  const now = new Date();
  const [updatedGame] = await db.update(games).set({ clueRevealedAt: revealed ? now : null, updatedAt: now }).where(eq(games.id, gameId)).returning();
  const { stateVersion } = await appendEvents(db, {
    gameId,
    events: [{
      eventType: eventTypes.adminOverride,
      entityType: 'game',
      entityId: gameId,
      actorType: 'admin',
      actorId: null,
      actorTeamId: null,
      afterState: { clueRevealedAt: updatedGame!.clueRevealedAt?.toISOString() ?? null },
      meta: { action: revealed ? 'reveal_clue' : 'hide_clue' },
    }],
  });
  return { gameId, stateVersion, body: { game: { ...serializeGameRecord(updatedGame!), stateVersion }, stateVersion } };
}

async function loadFoundFragments(db: DatabaseClient, gameId: string): Promise<Map<number, { challengeTitle: string; teamIds: string[] }>> {
  const rows = await db
    .select({ index: challenges.clueFragmentIndex, title: challenges.title, teamId: challengeClaims.teamId })
    .from(challenges)
    .innerJoin(challengeClaims, eq(challengeClaims.challengeId, challenges.id))
    .where(and(eq(challenges.gameId, gameId), isNotNull(challenges.clueFragmentIndex), inArray(challengeClaims.status, FOUND_CLAIM_STATUSES)))
    .orderBy(asc(challengeClaims.completedAt));
  const found = new Map<number, { challengeTitle: string; teamIds: string[] }>();
  for (const row of rows) {
    const entry = found.get(row.index!) ?? { challengeTitle: row.title, teamIds: [] };
    if (!entry.teamIds.includes(row.teamId)) entry.teamIds.push(row.teamId);
    found.set(row.index!, entry);
  }
  return found;
}

async function getSetFragmentCount(db: DatabaseClient, challengeSetId: string | null): Promise<number | null> {
  if (!challengeSetId) return null;
  const [row] = await db.select({ total: count() }).from(challengeSetItems).where(eq(challengeSetItems.setId, challengeSetId));
  return row?.total ? Number(row.total) : null;
}

function assertSetup(status: string): void {
  if (status !== 'setup') {
    throw new AppError(errorCodes.validationError, { message: 'Clue pictures can only be changed before the game starts.' });
  }
}

function serializeClueImage(row: typeof clueImages.$inferSelect): ClueImageSummary {
  return { id: row.id, width: row.width, height: row.height, fragmentCount: row.fragmentCount, thumbnail: row.thumbnail, createdAt: row.createdAt.toISOString() };
}
