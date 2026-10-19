import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminClueStatus, Game } from '@city-game/shared';
import { deleteClueImage, getAdminClueStatus, setClueRevealed, uploadClueImage } from '../../lib/api';
import { cutClueImage } from '../../lib/clue-image';

interface AdminClueProps {
  game: Game;
  onGameChange(game: Game): void;
}

const REFRESH_MS = 20_000;
const buttonClassName = 'rounded-full border border-[#20323a] px-3.5 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-[#20323a] disabled:cursor-not-allowed disabled:border-[#b5c0c6] disabled:text-[#88969d]';

// The final clue. Before the game the admin drops in a few candidate pictures, each cut into one
// fragment per challenge in the game's set (a game without a set has no clue); starting the game
// picks one at random, and nothing here ever says which, so the admin can play along. Each
// completed challenge hands its team one of the picture's fragments. "Reveal" shows every team's
// fragments to everyone, for piecing the picture together at the end.
export function AdminClue({ game, onGameChange }: AdminClueProps) {
  const [status, setStatus] = useState<AdminClueStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isSetup = game.status === 'setup';

  const load = useCallback(async () => {
    try {
      setStatus(await getAdminClueStatus(game.id));
      setError(null);
    } catch (reason) {
      setError(getErrorMessage(reason));
    }
  }, [game.id]);

  useEffect(() => {
    setStatus(null);
    void load();
    // The set (and so the fragment count) can change while the game is in setup.
  }, [load, game.challengeSetId]);

  useEffect(() => {
    if (game.status !== 'active') return;
    const timer = window.setInterval(() => { void load(); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, game.status]);

  const handleFiles = async (files: FileList | null) => {
    const fragmentCount = status?.fragmentCount;
    if (!files?.length || !fragmentCount) return;
    setError(null);
    try {
      for (const [position, file] of [...files].entries()) {
        setBusy(`Cutting picture ${position + 1} of ${files.length}…`);
        await uploadClueImage(game.id, await cutClueImage(file, fragmentCount));
      }
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await load();
    }
  };

  const handleDelete = async (imageId: string) => {
    setBusy('Removing…');
    try {
      await deleteClueImage(imageId);
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setBusy(null);
      await load();
    }
  };

  const handleReveal = async (revealed: boolean) => {
    if (revealed && !window.confirm('Show every team all the fragments found so far? Players see the whole board straight away.')) return;
    setBusy(revealed ? 'Revealing…' : 'Hiding…');
    try {
      onGameChange(await setClueRevealed(game.id, revealed));
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setBusy(null);
      await load();
    }
  };

  const images = status?.images ?? [];
  const revealedAt = status?.revealedAt ?? game.clueRevealedAt;
  const fragmentCount = status?.fragmentCount ?? null;
  const mismatchedCount = isSetup && fragmentCount ? images.filter((image) => image.fragmentCount !== fragmentCount).length : 0;
  const playFragmentCount = images[0]?.fragmentCount ?? fragmentCount ?? 0;

  return (
    <section className="rounded-[1.75rem] border border-[#d6c79f] bg-white p-5 shadow-[0_20px_50px_rgba(21,31,37,0.08)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold text-[#182126]">🧩 Final clue</h2>
          <p className="mt-1 text-sm text-[#5b6870]">
            {!isSetup
              ? 'Each team only sees the fragments it found until you reveal them all.'
              : fragmentCount
                ? `Add a few candidate pictures. Each is cut into ${fragmentCount} fragments, one per challenge in the set. Starting the game secretly picks one; each completed challenge gives its team a fragment.`
                : status
                  ? 'Choose a challenge set for this game first: each picture is cut into one fragment per challenge.'
                  : null}
          </p>
        </div>
        {!isSetup && status?.isChosen ? (
          revealedAt ? (
            <button type="button" className={buttonClassName} disabled={Boolean(busy)} onClick={() => { void handleReveal(false); }}>Hide again</button>
          ) : (
            <button type="button" className="rounded-full bg-[#7a5a16] px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white disabled:cursor-not-allowed disabled:bg-[#b5a37c]" disabled={Boolean(busy)} onClick={() => { void handleReveal(true); }}>
              Reveal to everyone
            </button>
          )
        ) : null}
      </div>

      <div className="mt-4 space-y-3">
        {!isSetup ? (
          <p className="text-sm text-[#182126]">
            {status?.isChosen
              ? <>One of {images.length} {images.length === 1 ? 'picture' : 'pictures'} is in play. <strong>{status.foundFragmentCount}</strong> of {playFragmentCount} fragments found{revealedAt ? ' — revealed to everyone.' : '.'}</>
              : 'No clue pictures were added before the game started, so there is no clue this game.'}
          </p>
        ) : null}

        {images.length ? (
          <div className="flex flex-wrap gap-2">
            {images.map((image) => (
              <figure key={image.id} className="relative overflow-hidden rounded-xl border border-[#dbe2e7] bg-[#f6f2e6]">
                <img src={image.thumbnail} alt="" className="h-20 w-auto max-w-[8rem] object-cover" />
                {isSetup && fragmentCount && image.fragmentCount !== fragmentCount ? (
                  <figcaption className="absolute inset-x-0 bottom-0 bg-[#a33a2b]/85 px-1 py-0.5 text-center text-[10px] font-semibold text-white">Cut for {image.fragmentCount}</figcaption>
                ) : null}
                {isSetup ? (
                  <button
                    type="button"
                    aria-label="Remove picture"
                    disabled={Boolean(busy)}
                    onClick={() => { void handleDelete(image.id); }}
                    className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs text-white disabled:opacity-50"
                  >
                    ×
                  </button>
                ) : null}
              </figure>
            ))}
          </div>
        ) : isSetup && fragmentCount ? (
          <p className="rounded-2xl border border-dashed border-[#cad3d9] bg-[#f8fafb] px-4 py-5 text-sm text-[#5d6a72]">No pictures yet. Add two or more so you can't tell which one gets picked.</p>
        ) : null}

        {mismatchedCount ? (
          <p className="text-sm text-[#a33a2b]">
            The set now has {fragmentCount} challenges, but {mismatchedCount === 1 ? 'one picture was' : `${mismatchedCount} pictures were`} cut for a different number. Remove and add {mismatchedCount === 1 ? 'it' : 'them'} again.
          </p>
        ) : null}

        {isSetup && fragmentCount ? (
          <div className="flex flex-wrap items-center gap-3">
            <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => { void handleFiles(event.target.files); }} />
            <button type="button" className={buttonClassName} disabled={Boolean(busy)} onClick={() => fileInputRef.current?.click()}>Add pictures</button>
          </div>
        ) : null}

        {busy ? <p className="text-sm text-[#5d6a72]">{busy}</p> : null}
        {error ? <p className="text-sm text-[#a33a2b]">{error}</p> : null}
      </div>
    </section>
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
