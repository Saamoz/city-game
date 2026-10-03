import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import type {
  ChallengeSet,
  ChallengeSetItem,
  ChallengeSetItemLocationMode,
  GeoJsonPoint,
  JsonObject,
  MapDefinition,
  MapZone,
} from '@city-game/shared';
import { DEFAULT_CHALLENGE_POINTS, MAX_CHALLENGE_BONUSES, getBasePoints, getChallengeBonuses, getMaxBonusPoints } from '@city-game/shared';
import {
  ApiError,
  createChallengeSetDefinition,
  createChallengeSetItemDefinition,
  deleteChallengeSetDefinition,
  deleteChallengeSetItemDefinition,
  getChallengeSet,
  listChallengeSetItems,
  listChallengeSets,
  listMaps,
  listMapZones,
  updateChallengeSetDefinition,
  updateChallengeSetItemDefinition,
} from '../../lib/api';
import {
  CHALLENGE_CARD_SHORT_DESCRIPTION_MAX_LENGTH,
  CHALLENGE_CARD_TITLE_MAX_LENGTH,
  normalizeChallengeCardText,
} from '../../lib/challenge-card-limits';
import { ChallengePointPicker } from './ChallengePointPicker';

interface AdminChallengesProps {
  initialChallengeSetId: string | null;
}

type NoticeTone = 'info' | 'success' | 'error';

interface NoticeState {
  tone: NoticeTone;
  message: string;
}

interface SetFormState {
  locationMode: ChallengeSetItemLocationMode;
  name: string;
  description: string;
}

interface ItemFormState {
  title: string;
  shortDescription: string;
  longDescription: string;
  difficulty: Exclude<ChallengeSetItem['difficulty'], null> | '';
  mapId: string;
  mapZoneId: string;
  mapPoint: GeoJsonPoint | null;
  pointRadiusMeters: string;
  pointValue: string;
  bonuses: BonusFormRow[];
  placement: ItemPlacement;
  locationHint: string;
  scoringMode: 'instant' | 'judged';
  judgedMaxPoints: string;
}

interface BonusFormRow {
  id: string;
  label: string;
  points: string;
}

// Within a point-linked set, each item is either pinned to the map or doable anywhere.
type ItemPlacement = 'pinned' | 'anywhere';

const DIFFICULTY_OPTIONS: Array<{ value: Exclude<ChallengeSetItem['difficulty'], null> | ''; label: string }> = [
  { value: '', label: 'Unset' },
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
];

const INITIAL_SET_FORM: SetFormState = {
  locationMode: 'portable',
  name: '',
  description: '',
};

const INITIAL_ITEM_FORM: ItemFormState = {
  title: '',
  shortDescription: '',
  longDescription: '',
  difficulty: '',
  mapId: '',
  mapZoneId: '',
  mapPoint: null,
  pointRadiusMeters: '40',
  pointValue: '1',
  bonuses: [],
  placement: 'pinned',
  locationHint: '',
  scoringMode: 'instant',
  judgedMaxPoints: '',
};

export function AdminChallenges({ initialChallengeSetId }: AdminChallengesProps) {
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [sets, setSets] = useState<ChallengeSet[]>([]);
  const [maps, setMaps] = useState<MapDefinition[]>([]);
  const [zoneOptionsByMapId, setZoneOptionsByMapId] = useState<Record<string, MapZone[]>>({});
  const [currentSet, setCurrentSet] = useState<ChallengeSet | null>(null);
  const [setForm, setSetForm] = useState<SetFormState>(INITIAL_SET_FORM);
  const [items, setItems] = useState<ChallengeSetItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [itemForm, setItemForm] = useState<ItemFormState>(INITIAL_ITEM_FORM);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [newSetName, setNewSetName] = useState('');
  const [isSavingSet, setIsSavingSet] = useState(false);
  const [isSavingItem, setIsSavingItem] = useState(false);
  const [isDeletingSet, setIsDeletingSet] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const selectedItem = useMemo(() => items.find((item) => item.id === selectedItemId) ?? null, [items, selectedItemId]);
  const sortedSets = useMemo(() => [...sets].sort((left, right) => left.name.localeCompare(right.name)), [sets]);
  const sortedMaps = useMemo(() => [...maps].sort((left, right) => left.name.localeCompare(right.name)), [maps]);
  const currentMapZones = useMemo(() => itemForm.mapId ? (zoneOptionsByMapId[itemForm.mapId] ?? []) : [], [itemForm.mapId, zoneOptionsByMapId]);
  const selectedMap = useMemo(() => sortedMaps.find((map) => map.id === itemForm.mapId) ?? null, [itemForm.mapId, sortedMaps]);

  const loadZoneOptions = useCallback(async (mapId: string) => {
    if (!mapId) {
      return [];
    }

    const cached = zoneOptionsByMapId[mapId];
    if (cached) {
      return cached;
    }

    const zones = await listMapZones(mapId);
    setZoneOptionsByMapId((current) => ({ ...current, [mapId]: zones }));
    return zones;
  }, [zoneOptionsByMapId]);

  const syncRoute = useCallback((challengeSetId: string | null) => {
    if (typeof window === 'undefined') {
      return;
    }

    const search = challengeSetId ? '?setId=' + encodeURIComponent(challengeSetId) : '';
    window.history.replaceState({}, '', '/admin/challenges' + search);
  }, []);

  const loadBundle = useCallback(async (preferredSetId?: string | null) => {
    setStatus('loading');
    setErrorMessage(null);

    try {
      const [availableSets, availableMaps] = await Promise.all([listChallengeSets(), listMaps()]);
      setSets(availableSets);
      setMaps(availableMaps);

      const targetSetId = preferredSetId?.trim() || availableSets[0]?.id || null;
      if (!targetSetId) {
        setCurrentSet(null);
        setSetForm(INITIAL_SET_FORM);
        setItems([]);
        setSelectedItemId(null);
        setItemForm(INITIAL_ITEM_FORM);
        syncRoute(null);
        setStatus('ready');
        return;
      }

      const [challengeSet, challengeItems] = await Promise.all([
        getChallengeSet(targetSetId),
        listChallengeSetItems(targetSetId),
      ]);

      setCurrentSet(challengeSet);
      setSetForm(buildSetForm(challengeSet));
      setItems(challengeItems);
      setSelectedItemId(challengeItems[0]?.id ?? null);
      syncRoute(challengeSet.id);

      if (challengeItems[0]) {
        const nextForm = buildItemForm(challengeItems[0]);
        setItemForm(nextForm);
        if (nextForm.mapId) {
          void loadZoneOptions(nextForm.mapId);
        }
      } else {
        setItemForm(INITIAL_ITEM_FORM);
      }

      setStatus('ready');
    } catch (error) {
      setStatus('error');
      setErrorMessage(getApiErrorMessage(error));
    }
  }, [loadZoneOptions, syncRoute]);

  useEffect(() => {
    void loadBundle(initialChallengeSetId);
  }, [initialChallengeSetId, loadBundle]);

  useEffect(() => {
    if (!selectedItem) {
      setItemForm(INITIAL_ITEM_FORM);
      return;
    }

    const nextForm = buildItemForm(selectedItem);
    setItemForm(nextForm);
    if (nextForm.mapId) {
      void loadZoneOptions(nextForm.mapId);
    }
  }, [loadZoneOptions, selectedItem]);

  const handleSelectSet = async (challengeSet: ChallengeSet) => {
    setCurrentSet(challengeSet);
    setSetForm(buildSetForm(challengeSet));
    setNotice(null);

    try {
      const nextItems = await listChallengeSetItems(challengeSet.id);
      setItems(nextItems);
      setSelectedItemId(nextItems[0]?.id ?? null);
      syncRoute(challengeSet.id);
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    }
  };

  const handleCreateSet = async () => {
    const name = newSetName.trim();
    if (!name) {
      setNotice({ tone: 'error', message: 'Set name is required.' });
      return;
    }

    setIsSavingSet(true);
    try {
      const created = await createChallengeSetDefinition({ name, description: '' });
      setSets((current) => [...current, created]);
      setCurrentSet(created);
      setSetForm(buildSetForm(created));
      setItems([]);
      setSelectedItemId(null);
      setItemForm({ ...INITIAL_ITEM_FORM, mapId: sortedMaps[0]?.id ?? '' });
      setNewSetName('');
      syncRoute(created.id);
      setNotice({ tone: 'success', message: 'Challenge set created.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsSavingSet(false);
    }
  };

  const handleSaveSet = async () => {
    if (!currentSet) {
      return;
    }

    setIsSavingSet(true);
    try {
      const updated = await updateChallengeSetDefinition(currentSet.id, {
        name: setForm.name.trim(),
        description: setForm.description.trim() || null,
        locationMode: setForm.locationMode,
        metadata: currentSet.metadata,
      });
      setCurrentSet(updated);
      setSets((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
      setNotice({ tone: 'success', message: 'Challenge set saved.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsSavingSet(false);
    }
  };

  const handleDeleteSet = async () => {
    if (!currentSet) {
      return;
    }

    if (!window.confirm('Delete this challenge set?')) {
      return;
    }

    setIsDeletingSet(true);
    try {
      await deleteChallengeSetDefinition(currentSet.id);
      const nextSets = sets.filter((entry) => entry.id !== currentSet.id);
      setSets(nextSets);
      setNotice({ tone: 'success', message: 'Challenge set deleted.' });

      if (nextSets[0]) {
        await handleSelectSet(nextSets[0]);
      } else {
        setCurrentSet(null);
        setSetForm(INITIAL_SET_FORM);
        setItems([]);
        setSelectedItemId(null);
        setItemForm(INITIAL_ITEM_FORM);
        syncRoute(null);
      }
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsDeletingSet(false);
    }
  };

  const handleCreateItem = () => {
    if (!currentSet) {
      setNotice({ tone: 'info', message: 'Create a challenge set first.' });
      return;
    }

    setSelectedItemId(null);
    setItemForm({ ...INITIAL_ITEM_FORM, mapId: sortedMaps[0]?.id ?? '' });
  };

  const handleSaveItem = async () => {
    if (!currentSet) {
      return;
    }

    if (setForm.locationMode !== currentSet.locationMode) {
      setNotice({ tone: 'info', message: 'Save the set placement before editing its challenges.' });
      return;
    }

    const title = normalizeChallengeCardText(itemForm.title);
    if (!title) {
      setNotice({ tone: 'error', message: 'Item title is required.' });
      return;
    }
    if (title.length > CHALLENGE_CARD_TITLE_MAX_LENGTH) {
      setNotice({ tone: 'error', message: 'Title must be ' + CHALLENGE_CARD_TITLE_MAX_LENGTH + ' characters or fewer.' });
      return;
    }

    const shortDescription = normalizeChallengeCardText(itemForm.shortDescription);
    const longDescription = itemForm.longDescription.trim();
    const description = longDescription || shortDescription;
    if (!description) {
      setNotice({ tone: 'error', message: 'Provide a short or long description.' });
      return;
    }

    const cardDescription = shortDescription || normalizeChallengeCardText(description);
    if (cardDescription.length > CHALLENGE_CARD_SHORT_DESCRIPTION_MAX_LENGTH) {
      setNotice({ tone: 'error', message: 'Short description must be ' + CHALLENGE_CARD_SHORT_DESCRIPTION_MAX_LENGTH + ' characters or fewer.' });
      return;
    }

    if (setForm.locationMode === 'zone' && (!itemForm.mapId || !itemForm.mapZoneId)) {
      setNotice({ tone: 'error', message: 'Choose a source map and zone.' });
      return;
    }

    const isPinned = setForm.locationMode === 'point' && itemForm.placement === 'pinned';
    if (isPinned && (!itemForm.mapId || !itemForm.mapPoint)) {
      setNotice({ tone: 'error', message: 'Choose a source map and place a point.' });
      return;
    }

    const locationHint = itemForm.locationHint.trim();
    const isJudged = setForm.locationMode === 'point' && itemForm.scoringMode === 'judged';
    const judgedMaxPoints = Math.floor(Number(itemForm.judgedMaxPoints));
    const basePoints = itemForm.pointValue.trim() === '' ? DEFAULT_CHALLENGE_POINTS : Math.max(0, Math.floor(Number(itemForm.pointValue) || 0));
    const bonuses = itemForm.bonuses
      .map((bonus) => ({ id: bonus.id, label: bonus.label.trim(), points: Math.floor(Number(bonus.points) || 0) }))
      .filter((bonus) => bonus.label);
    const payload = {
      mapZoneId: setForm.locationMode === 'zone' ? itemForm.mapZoneId : null,
      mapPoint: isPinned ? itemForm.mapPoint : null,
      title,
      description,
      config: {
        ...(shortDescription ? { short_description: shortDescription } : {}),
        ...(longDescription ? { long_description: longDescription } : {}),
        ...(isPinned ? { point_radius_meters: Math.max(1, Number(itemForm.pointRadiusMeters) || 40) } : {}),
        ...(!isPinned && setForm.locationMode !== 'zone' && locationHint ? { location_hint: locationHint } : {}),
        ...(bonuses.length ? { bonuses } : {}),
        ...(isJudged ? { judged: true, ...(judgedMaxPoints > 0 ? { judged_max_points: judgedMaxPoints } : {}) } : {}),
      } satisfies JsonObject,
      scoring: !isJudged ? { points: basePoints } : {} as Record<string, number>,
      difficulty: itemForm.difficulty || null,
      sortOrder: selectedItem ? selectedItem.sortOrder : items.length,
      metadata: ((setForm.locationMode === 'zone' || isPinned) && itemForm.mapId ? { sourceMapId: itemForm.mapId } : {}) as JsonObject,
    };

    setIsSavingItem(true);
    try {
      const saved = selectedItem
        ? await updateChallengeSetItemDefinition(selectedItem.id, payload)
        : await createChallengeSetItemDefinition(currentSet.id, payload);
      const nextItems = upsertItem(items, saved);
      setItems(nextItems);
      setSelectedItemId(saved.id);
      setNotice({ tone: 'success', message: selectedItem ? 'Challenge item saved.' : 'Challenge item created.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsSavingItem(false);
    }
  };

  const handleDeleteItem = async () => {
    if (!selectedItem) {
      return;
    }

    if (!window.confirm('Delete this challenge item?')) {
      return;
    }

    setIsSavingItem(true);
    try {
      await deleteChallengeSetItemDefinition(selectedItem.id);
      const nextItems = items.filter((item) => item.id !== selectedItem.id);
      setItems(nextItems);
      setSelectedItemId(nextItems[0]?.id ?? null);
      setNotice({ tone: 'success', message: 'Challenge item deleted.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsSavingItem(false);
    }
  };

  const handleMoveItem = async (direction: -1 | 1, item: ChallengeSetItem) => {
    if (!currentSet) {
      return;
    }

    const index = items.findIndex((entry) => entry.id === item.id);
    const swapIndex = index + direction;
    if (index < 0 || swapIndex < 0 || swapIndex >= items.length) {
      return;
    }

    const target = items[swapIndex]!;
    const reordered = [...items];
    reordered[index] = { ...target, sortOrder: item.sortOrder };
    reordered[swapIndex] = { ...item, sortOrder: target.sortOrder };
    setItems(reordered);

    try {
      await Promise.all([
        updateChallengeSetItemDefinition(item.id, { sortOrder: target.sortOrder }),
        updateChallengeSetItemDefinition(target.id, { sortOrder: item.sortOrder }),
      ]);
      setNotice({ tone: 'success', message: 'Item order updated.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
      const refreshed = await listChallengeSetItems(currentSet.id);
      setItems(refreshed);
    }
  };

  const handleExport = () => {
    if (!currentSet) {
      return;
    }

    const payload = {
      challengeSet: currentSet,
      items,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = slugify(currentSet.name || 'challenge-set') + '.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleOpenImport = () => importInputRef.current?.click();

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = '';
    if (!file) {
      return;
    }

    setIsImporting(true);
    try {
      const parsed = JSON.parse(await file.text()) as {
        challengeSet?: { name?: string; description?: string | null; locationMode?: ChallengeSetItemLocationMode; metadata?: JsonObject };
        items?: ChallengeSetItem[];
      };

      const importedItems = Array.isArray(parsed.items) ? parsed.items : [];
      const importedSet = parsed.challengeSet ?? {};
      const importedLocationMode = importedSet.locationMode ?? inferImportedSetLocationMode(importedItems);

      let targetSet = currentSet;
      if (!targetSet) {
        targetSet = await createChallengeSetDefinition({
          name: importedSet.name?.trim() || file.name.replace(/\.json$/i, ''),
          description: importedSet.description ?? '',
          locationMode: importedLocationMode,
          metadata: importedSet.metadata ?? {},
        });
        setSets((current) => [...current, targetSet!]);
        setCurrentSet(targetSet);
        syncRoute(targetSet.id);
      } else {
        targetSet = await updateChallengeSetDefinition(targetSet.id, {
          name: importedSet.name?.trim() || targetSet.name,
          description: importedSet.description ?? targetSet.description,
          locationMode: importedLocationMode,
          metadata: importedSet.metadata ?? targetSet.metadata,
        });
        setCurrentSet(targetSet);
        setSets((current) => current.map((entry) => entry.id === targetSet!.id ? targetSet! : entry));
        for (const item of items) {
          await deleteChallengeSetItemDefinition(item.id);
        }
      }

      const createdItems: ChallengeSetItem[] = [];
      for (const [index, item] of importedItems.entries()) {
        const title = normalizeChallengeCardText(item.title);
        const shortDescription = getCardShortDescription(item);
        if (title.length > CHALLENGE_CARD_TITLE_MAX_LENGTH) {
          throw new Error('Imported item "' + title + '" has a title over ' + CHALLENGE_CARD_TITLE_MAX_LENGTH + ' characters.');
        }
        if (shortDescription.length > CHALLENGE_CARD_SHORT_DESCRIPTION_MAX_LENGTH) {
          throw new Error('Imported item "' + title + '" has a short description over ' + CHALLENGE_CARD_SHORT_DESCRIPTION_MAX_LENGTH + ' characters.');
        }

        const created = await createChallengeSetItemDefinition(targetSet.id, {
          mapZoneId: item.mapZoneId,
          mapPoint: item.mapPoint,
          title,
          description: item.description,
          config: normalizeImportedItemConfig(item.config),
          scoring: normalizeScoring(item.scoring),
          difficulty: item.difficulty,
          sortOrder: item.sortOrder ?? index,
          metadata: item.metadata,
        });
        createdItems.push(created);
      }

      setItems(createdItems);
      setSelectedItemId(createdItems[0]?.id ?? null);
      setNotice({ tone: 'success', message: 'Challenge set imported.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsImporting(false);
    }
  };

  const handleItemMapChange = async (mapId: string) => {
    setItemForm((current) => ({ ...current, mapId, mapZoneId: '', mapPoint: null }));
    if (mapId) {
      await loadZoneOptions(mapId);
    }
  };

  if (status === 'loading') {
    return <Shell><StatusCard title="Loading" body="Loading reusable challenge sets." /></Shell>;
  }

  if (status === 'error') {
    return <Shell><StatusCard title="Load Failed" body={errorMessage ?? 'Failed to load challenge keeper.'} tone="error" /></Shell>;
  }

  return (
    <Shell>
      <input ref={importInputRef} className="hidden" type="file" accept="application/json" onChange={handleImportFile} />

      <div className="grid min-h-screen gap-4 p-4 lg:grid-cols-[18rem_minmax(0,1fr)_26rem] lg:p-6">
        <aside className="rounded-[1.75rem] border border-[#c9ae6d]/55 bg-[#f3ecd8] p-4 shadow-[0_24px_60px_rgba(46,58,62,0.14)]">
          <div>
            <p className="text-[11px] uppercase tracking-[0.3em] text-[#936718]">Challenge Keeper</p>
            <h1 className="mt-2 font-[Georgia,Times_New_Roman,serif] text-2xl font-semibold text-[#24343a]">Sets</h1>
          </div>

          <div className="mt-4 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-2xl border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-3 text-sm text-[#24343a] outline-none transition focus:border-[#8f7446]"
              placeholder="New set name"
              value={newSetName}
              onChange={(event) => setNewSetName(event.target.value)}
            />
            <button className="rounded-2xl border border-[#24343a] bg-[#24343a] px-4 py-3 text-sm font-semibold text-[#f4ead7]" disabled={isSavingSet} onClick={handleCreateSet} type="button">New</button>
          </div>

          <div className="mt-4 space-y-2 overflow-y-auto lg:max-h-[calc(100vh-12rem)]">
            {sortedSets.map((challengeSet) => {
              const isActive = challengeSet.id === currentSet?.id;
              return (
                <button
                  key={challengeSet.id}
                  className={[
                    'w-full rounded-[1.25rem] border px-4 py-3 text-left transition',
                    isActive ? 'border-[#24343a] bg-[#fff8eb] shadow-[0_10px_28px_rgba(36,52,58,0.12)]' : 'border-[#d6c59d]/55 bg-[#f7efdc] hover:bg-[#fbf3e2]',
                  ].join(' ')}
                  onClick={() => void handleSelectSet(challengeSet)}
                  type="button"
                >
                  <p className="font-semibold text-[#24343a]">{challengeSet.name}</p>
                  <p className="mt-1 text-sm text-[#5a6a70] line-clamp-2">{challengeSet.description || 'No description.'}</p>
                </button>
              );
            })}
            {!sortedSets.length ? <EmptyState body="No challenge sets yet. Create one to begin authoring." /> : null}
          </div>
        </aside>

        <main className="rounded-[1.75rem] border border-[#c9ae6d]/55 bg-[#f7f0de] p-5 shadow-[0_24px_60px_rgba(46,58,62,0.12)]">
          {notice ? <Notice tone={notice.tone} message={notice.message} /> : null}
          {currentSet ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#d6c59d]/55 pb-4">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.3em] text-[#936718]">Reusable Set</p>
                  <h2 className="mt-2 font-[Georgia,Times_New_Roman,serif] text-3xl font-semibold text-[#24343a]">{currentSet.name}</h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#24343a]" onClick={handleExport} type="button">Export</button>
                  <button className="rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#24343a]" disabled={isImporting} onClick={handleOpenImport} type="button">Import</button>
                  <button className="rounded-full border border-[#24343a] bg-[#24343a] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#f4ead7]" disabled={isSavingSet} onClick={() => void handleSaveSet()} type="button">Save Set</button>
                  <button className="rounded-full border border-[#b86052]/45 bg-[#f8dfd8] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#7d2d26]" disabled={isDeletingSet} onClick={() => void handleDeleteSet()} type="button">Delete</button>
                </div>
              </div>

              <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]">
                <section className="space-y-3">
                  <Field label="Set Name">
                    <input className="w-full rounded-2xl border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-3 text-sm text-[#24343a]" value={setForm.name} onChange={(event) => setSetForm((current) => ({ ...current, name: event.target.value }))} />
                  </Field>
                  <Field label="Set Placement">
                    <select className="w-full rounded-2xl border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-3 text-sm text-[#24343a]" value={setForm.locationMode} onChange={(event) => setSetForm((current) => ({ ...current, locationMode: event.target.value as ChallengeSetItemLocationMode }))}>
                      <option value="portable">Portable</option><option value="zone">Zone Linked</option><option value="point">Point Linked (pins + anywhere)</option>
                    </select>
                    <p className="mt-2 text-xs leading-5 text-[#6b777b]">{setForm.locationMode === 'point' ? 'Each challenge is either pinned to a map point or doable anywhere. Pins appear on the map; anywhere challenges are dealt as a deck.' : 'Every challenge in this set uses this placement type.'} Save the set before editing its items.</p>
                    {setForm.locationMode !== currentSet.locationMode ? <p className="mt-2 rounded-xl border border-[#d59b45]/45 bg-[#fff0ce] px-3 py-2 text-xs leading-5 text-[#765018]">Save this placement change before creating or editing challenges.</p> : null}
                  </Field>
                  <Field label="Description">
                    <textarea className="h-36 w-full rounded-2xl border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-3 text-sm text-[#24343a]" value={setForm.description} onChange={(event) => setSetForm((current) => ({ ...current, description: event.target.value }))} />
                  </Field>
                </section>

                <section className="min-h-[28rem] rounded-[1.4rem] border border-[#d6c59d]/55 bg-[#fbf4e4] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.24em] text-[#7a6a48]">Items</p>
                      <p className="mt-1 text-sm text-[#59696f]">{currentSet.locationMode === 'point' ? countPlacements(items) : 'All items use the set placement selected on the left.'}</p>
                    </div>
                    <button className="rounded-full border border-[#24343a] bg-[#24343a] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#f4ead7]" onClick={handleCreateItem} type="button">New Item</button>
                  </div>

                  <div className="mt-4 space-y-2 overflow-y-auto lg:max-h-[calc(100vh-18rem)]">
                    {items.map((item, index) => {
                      const active = item.id === selectedItemId;
                      return (
                        <article
                          key={item.id}
                          className={[
                            'rounded-[1.2rem] border px-4 py-3 transition',
                            active ? 'border-[#24343a] bg-[#fff8eb] shadow-[0_12px_30px_rgba(36,52,58,0.1)]' : 'border-[#d6c59d]/55 bg-white/60 hover:bg-[#fff8eb]',
                          ].join(' ')}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <button className="min-w-0 flex-1 text-left" onClick={() => setSelectedItemId(item.id)} type="button">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="font-semibold text-[#24343a]">{item.title}</h3>
                                {item.difficulty ? <Badge>{item.difficulty}</Badge> : null}
                                <PlacementBadge item={item} setMode={currentSet.locationMode} />
                                <PointsBadge item={item} />
                              </div>
                              <p className="mt-2 text-sm leading-6 text-[#5a6a70] line-clamp-2">{getShortDescription(item)}</p>
                            </button>
                            <div className="flex gap-1">
                              <IconButton disabled={index === 0} label="Move up" onClick={() => void handleMoveItem(-1, item)}>↑</IconButton>
                              <IconButton disabled={index === items.length - 1} label="Move down" onClick={() => void handleMoveItem(1, item)}>↓</IconButton>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                    {!items.length ? <EmptyState body="No items yet. Add the reusable cards for this set here." /> : null}
                  </div>
                </section>
              </div>
            </>
          ) : (
            <EmptyState body="Create or import a challenge set to begin." />
          )}
        </main>

        <aside className="rounded-[1.75rem] border border-[#c9ae6d]/55 bg-[#f3ecd8] p-5 shadow-[0_24px_60px_rgba(46,58,62,0.12)]">
          <div className="flex items-center justify-between gap-3 border-b border-[#d6c59d]/55 pb-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.24em] text-[#7a6a48]">Item Editor</p>
              <h2 className="mt-2 font-[Georgia,Times_New_Roman,serif] text-2xl font-semibold text-[#24343a]">{selectedItem ? 'Edit Item' : 'New Item'}</h2>
            </div>
            {selectedItem ? (
              <button className="rounded-full border border-[#b86052]/45 bg-[#f8dfd8] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#7d2d26]" disabled={isSavingItem} onClick={() => void handleDeleteItem()} type="button">Delete</button>
            ) : null}
          </div>

          <div className="mt-4 space-y-3 overflow-y-auto lg:max-h-[calc(100vh-10rem)]">
            <Field label="Title">
              <input className="w-full rounded-2xl border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-3 text-sm text-[#24343a]" maxLength={CHALLENGE_CARD_TITLE_MAX_LENGTH} value={itemForm.title} onChange={(event) => setItemForm((current) => ({ ...current, title: event.target.value }))} />
              <CharacterLimit value={itemForm.title} max={CHALLENGE_CARD_TITLE_MAX_LENGTH} />
            </Field>
            <Field label="Short Description">
              <textarea className="h-24 w-full rounded-2xl border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-3 text-sm text-[#24343a]" maxLength={CHALLENGE_CARD_SHORT_DESCRIPTION_MAX_LENGTH} value={itemForm.shortDescription} onChange={(event) => setItemForm((current) => ({ ...current, shortDescription: event.target.value }))} />
              <CharacterLimit value={itemForm.shortDescription} max={CHALLENGE_CARD_SHORT_DESCRIPTION_MAX_LENGTH} />
            </Field>
            <Field label="Long Description">
              <textarea className="h-36 w-full rounded-2xl border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-3 text-sm text-[#24343a]" value={itemForm.longDescription} onChange={(event) => setItemForm((current) => ({ ...current, longDescription: event.target.value }))} />
            </Field>
            <Field label="Difficulty">
              <select className="w-full rounded-2xl border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-3 text-sm text-[#24343a]" value={itemForm.difficulty} onChange={(event) => setItemForm((current) => ({ ...current, difficulty: event.target.value as ItemFormState['difficulty'] }))}>
                {DIFFICULTY_OPTIONS.map((option) => <option key={option.label} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
            {setForm.locationMode === 'point' ? (
              <div>
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7a6a48]">Where</span>
                <div className="grid grid-cols-2 gap-2">
                  <button className={placementClassName(itemForm.placement === 'pinned')} onClick={() => setItemForm((current) => ({ ...current, placement: 'pinned' }))} type="button">Pinned point</button>
                  <button className={placementClassName(itemForm.placement === 'anywhere')} onClick={() => setItemForm((current) => ({ ...current, placement: 'anywhere' }))} type="button">Anywhere</button>
                </div>
                <p className="mt-2 text-xs leading-5 text-[#6b777b]">{itemForm.placement === 'pinned' ? 'Players must reach this spot; it shows as a pin on the map.' : 'Players can do this wherever they are; it shows in the deck.'}</p>
              </div>
            ) : null}

            {setForm.locationMode === 'point' ? (
              <div>
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7a6a48]">Scoring</span>
                <div className="grid grid-cols-2 gap-2">
                  <button className={placementClassName(itemForm.scoringMode === 'instant')} onClick={() => setItemForm((current) => ({ ...current, scoringMode: 'instant' }))} type="button">Instant points</button>
                  <button className={placementClassName(itemForm.scoringMode === 'judged')} onClick={() => setItemForm((current) => ({ ...current, scoringMode: 'judged' }))} type="button">Judged after game</button>
                </div>
                <p className="mt-2 text-xs leading-5 text-[#6b777b]">{itemForm.scoringMode === 'judged' ? 'Stays open all game. Every team can submit it once; you award points per team after the game from the admin panel.' : 'The first team to complete it takes the points, and it disappears for everyone.'}</p>
              </div>
            ) : null}

            {setForm.locationMode !== 'point' || itemForm.scoringMode === 'instant' ? (
              <Field label="Challenge Points">
                <input className="w-full rounded-2xl border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-3 text-sm text-[#24343a] outline-none focus:border-[#8f7446]" min="0" onChange={(event) => setItemForm((current) => ({ ...current, pointValue: event.target.value }))} type="number" value={itemForm.pointValue} />
                <p className="mt-1 text-xs leading-5 text-[#6b777b]">Base points the team earns for completing it. Bonus tasks add on top.</p>
              </Field>
            ) : null}

            <BonusEditor
              isJudged={setForm.locationMode === 'point' && itemForm.scoringMode === 'judged'}
              rows={itemForm.bonuses}
              onChange={(bonuses) => setItemForm((current) => ({ ...current, bonuses }))}
            />

            {setForm.locationMode === 'point' && itemForm.scoringMode === 'judged' ? (
              <Field label="Max Points (optional)">
                <input className="w-full rounded-2xl border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-3 text-sm text-[#24343a] outline-none focus:border-[#8f7446]" min="1" onChange={(event) => setItemForm((current) => ({ ...current, judgedMaxPoints: event.target.value }))} placeholder="e.g. 10" type="number" value={itemForm.judgedMaxPoints} />
                <p className="mt-1 text-xs leading-5 text-[#6b777b]">Shown to players as "up to N pts" and to judges as a guide.</p>
              </Field>
            ) : null}

            {setForm.locationMode === 'portable' || (setForm.locationMode === 'point' && itemForm.placement === 'anywhere') ? (
              <Field label="Kind of Place (optional)">
                <input className="w-full rounded-2xl border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-3 text-sm text-[#24343a] outline-none focus:border-[#8f7446]" maxLength={40} placeholder="e.g. Any café, Any park, A bridge" value={itemForm.locationHint} onChange={(event) => setItemForm((current) => ({ ...current, locationHint: event.target.value }))} />
                <p className="mt-1 text-xs leading-5 text-[#6b777b]">Shown on the card so players know what sort of place works. Leave blank for truly anywhere.</p>
              </Field>
            ) : null}

            {setForm.locationMode === 'zone' || (setForm.locationMode === 'point' && itemForm.placement === 'pinned') ? (
              <Field label="Source Map">
                <select className="w-full rounded-2xl border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-3 text-sm text-[#24343a]" value={itemForm.mapId} onChange={(event) => void handleItemMapChange(event.target.value)}>
                  <option value="">Choose a map</option>
                  {sortedMaps.map((map) => <option key={map.id} value={map.id}>{map.name}</option>)}
                </select>
              </Field>
            ) : null}

            {setForm.locationMode === 'zone' ? (
              <Field label="Source Zone">
                <select className="w-full rounded-2xl border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-3 text-sm text-[#24343a]" value={itemForm.mapZoneId} onChange={(event) => setItemForm((current) => ({ ...current, mapZoneId: event.target.value }))}>
                  <option value="">Choose a zone</option>
                  {currentMapZones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
                </select>
              </Field>
            ) : null}

            {setForm.locationMode === 'point' && itemForm.placement === 'pinned' ? (
              <div className="space-y-3">
                <Field label="Completion Radius (metres)">
                  <input className="w-full rounded-2xl border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-3 text-sm text-[#24343a] outline-none focus:border-[#8f7446]" min="1" onChange={(event) => setItemForm((current) => ({ ...current, pointRadiusMeters: event.target.value }))} type="number" value={itemForm.pointRadiusMeters} />
                </Field>
                <Field label="Source Point">
                  <ChallengePointPicker
                    mapDefinition={selectedMap}
                    zones={currentMapZones}
                    value={itemForm.mapPoint}
                    onChange={(point) => setItemForm((current) => ({ ...current, mapPoint: point }))}
                  />
                </Field>
                <div className="flex items-center justify-between rounded-[1.2rem] border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-3 text-sm text-[#4f5f65]">
                  <span>{itemForm.mapPoint ? formatPoint(itemForm.mapPoint) : 'No point placed yet.'}</span>
                  <button className="rounded-full border border-[#c8b48a]/55 bg-white/70 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-[#24343a]" onClick={() => setItemForm((current) => ({ ...current, mapPoint: null }))} type="button">Clear</button>
                </div>
              </div>
            ) : null}

            <button className="mt-2 w-full rounded-2xl border border-[#24343a] bg-[#24343a] px-4 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-[#f4ead7] disabled:cursor-not-allowed disabled:opacity-50" disabled={isSavingItem || !currentSet || setForm.locationMode !== currentSet.locationMode} onClick={() => void handleSaveItem()} type="button">{selectedItem ? 'Save Item' : 'Create Item'}</button>
          </div>
        </aside>
      </div>
    </Shell>
  );
}


function getCardShortDescription(item: Pick<ChallengeSetItem, 'config' | 'description'>): string {
  const configured = item.config?.short_description;
  if (typeof configured === 'string' && configured.trim()) {
    return normalizeChallengeCardText(configured);
  }

  return normalizeChallengeCardText(item.description);
}

function inferImportedSetLocationMode(items: ChallengeSetItem[]): ChallengeSetItemLocationMode {
  if (items.some((item) => item.mapPoint)) return 'point';
  if (items.some((item) => item.mapZoneId)) return 'zone';
  return 'portable';
}

function normalizeImportedItemConfig(config: ChallengeSetItem['config']): JsonObject {
  const next = { ...config } as JsonObject;
  if (typeof config?.short_description === 'string') {
    next.short_description = normalizeChallengeCardText(config.short_description);
  }
  return next;
}

function buildSetForm(challengeSet: ChallengeSet): SetFormState {
  return {
    locationMode: challengeSet.locationMode,
    name: challengeSet.name,
    description: challengeSet.description ?? '',
  };
}

function buildItemForm(item: ChallengeSetItem): ItemFormState {
  const sourceMapId = getSourceMapId(item);
  return {
    title: item.title,
    shortDescription: getShortDescription(item),
    longDescription: getLongDescription(item),
    difficulty: item.difficulty ?? '',
    mapId: sourceMapId,
    mapZoneId: item.mapZoneId ?? '',
    mapPoint: item.mapPoint,
    pointRadiusMeters: String(typeof item.config?.point_radius_meters === 'number' ? item.config.point_radius_meters : 40),
    pointValue: String(getBasePoints(item.scoring)),
    bonuses: getChallengeBonuses(item.config).map((bonus) => ({ id: bonus.id, label: bonus.label, points: String(bonus.points) })),
    placement: item.mapPoint ? 'pinned' : 'anywhere',
    locationHint: typeof item.config?.location_hint === 'string' ? item.config.location_hint : '',
    scoringMode: item.config?.judged === true ? 'judged' : 'instant',
    judgedMaxPoints: typeof item.config?.judged_max_points === 'number' ? String(item.config.judged_max_points) : '',
  };
}

function PointsBadge({ item }: { item: ChallengeSetItem }) {
  const base = getBasePoints(item.scoring);
  const bonusCount = getChallengeBonuses(item.config).length;
  const maxBonus = getMaxBonusPoints(item.config);
  if (!base && !bonusCount) return null;
  return <Badge>{[base ? base + (base === 1 ? ' pt' : ' pts') : null, bonusCount ? '+' + maxBonus + ' bonus (' + bonusCount + ')' : null].filter(Boolean).join(' · ')}</Badge>;
}

function BonusEditor({ rows, isJudged, onChange }: { rows: BonusFormRow[]; isJudged: boolean; onChange(rows: BonusFormRow[]): void }) {
  const update = (id: string, patch: Partial<BonusFormRow>) => onChange(rows.map((row) => row.id === id ? { ...row, ...patch } : row));
  const inputClassName = 'rounded-xl border border-[#c8b48a]/55 bg-[#fff8eb] px-3 py-2 text-sm text-[#24343a] outline-none focus:border-[#8f7446]';
  return (
    <div>
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7a6a48]">Bonus Tasks</span>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_4.5rem_auto] items-center gap-2">
            <input aria-label="Bonus task" className={inputClassName} maxLength={120} onChange={(event) => update(row.id, { label: event.target.value })} placeholder="e.g. Do it in costume" value={row.label} />
            <input aria-label="Bonus points" className={inputClassName + ' text-right'} onChange={(event) => update(row.id, { points: event.target.value })} placeholder="pts" type="number" value={row.points} />
            <button aria-label="Remove bonus" className="h-9 w-9 rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] text-sm text-[#7d2d26]" onClick={() => onChange(rows.filter((entry) => entry.id !== row.id))} type="button">×</button>
          </div>
        ))}
      </div>
      {rows.length < MAX_CHALLENGE_BONUSES ? <button className="mt-2 rounded-full border border-dashed border-[#a88c52] bg-[#fff8eb] px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#5d4d33]" onClick={() => onChange([...rows, { id: 'bonus-' + crypto.randomUUID().slice(0, 8), label: '', points: '1' }])} type="button">+ Add bonus</button> : null}
      <p className="mt-1.5 text-xs leading-5 text-[#6b777b]">{isJudged ? 'Teams tick the ones they did when submitting; judges see their picks.' : 'Optional extras, up to ' + MAX_CHALLENGE_BONUSES + '. Teams tick the ones they did when completing, and each adds its points.'}</p>
    </div>
  );
}

function countPlacements(items: ChallengeSetItem[]): string {
  const pinned = items.filter((item) => item.mapPoint).length;
  const judged = items.filter((item) => item.config?.judged === true).length;
  return pinned + ' pinned on the map · ' + (items.length - pinned) + ' doable anywhere' + (judged ? ' · ' + judged + ' judged' : '');
}

function PlacementBadge({ item, setMode }: { item: ChallengeSetItem; setMode: ChallengeSetItemLocationMode }) {
  const hint = typeof item.config?.location_hint === 'string' ? item.config.location_hint : '';
  const judged = item.config?.judged === true ? <Badge tone="judged">★ Judged</Badge> : null;
  if (setMode === 'zone') return <Badge tone="linked">Zone linked</Badge>;
  if (setMode === 'point' && item.mapPoint) return <>{judged}<Badge tone="linked">Pinned</Badge></>;
  return <>{judged}<Badge tone="portable">{hint || (setMode === 'point' ? 'Anywhere' : 'Portable')}</Badge></>;
}

function getSourceMapId(item: Pick<ChallengeSetItem, 'metadata'>): string {
  const raw = item.metadata?.sourceMapId;
  return typeof raw === 'string' ? raw : '';
}

function getShortDescription(item: ChallengeSetItem): string {
  const configured = item.config?.short_description;
  return typeof configured === 'string' && configured.trim() ? configured : item.description;
}

function getLongDescription(item: ChallengeSetItem): string {
  const configured = item.config?.long_description;
  return typeof configured === 'string' && configured.trim() ? configured : item.description;
}

function formatPoint(point: GeoJsonPoint): string {
  return point.coordinates[1].toFixed(5) + ', ' + point.coordinates[0].toFixed(5);
}

function upsertItem(items: ChallengeSetItem[], nextItem: ChallengeSetItem): ChallengeSetItem[] {
  const existingIndex = items.findIndex((item) => item.id === nextItem.id);
  if (existingIndex === -1) {
    return [...items, nextItem].sort(compareBySortOrder);
  }

  const nextItems = [...items];
  nextItems[existingIndex] = nextItem;
  return nextItems.sort(compareBySortOrder);
}

function compareBySortOrder(left: ChallengeSetItem, right: ChallengeSetItem): number {
  return left.sortOrder - right.sortOrder || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

function getApiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Request failed.';
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'challenge-set';
}

function normalizeScoring(scoring: ChallengeSetItem['scoring']): Record<string, number> {
  const entries = Object.entries(scoring).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
  return Object.fromEntries(entries);
}

function placementClassName(active: boolean): string {
  return [
    'rounded-2xl border px-4 py-3 text-sm font-semibold transition',
    active ? 'border-[#24343a] bg-[#24343a] text-[#f4ead7]' : 'border-[#c8b48a]/55 bg-[#fff8eb] text-[#24343a]',
  ].join(' ');
}

function Shell({ children }: { children: ReactNode }) {
  return <main className="min-h-screen bg-[#e6e0cf] text-[#24343a]">{children}</main>;
}

function StatusCard({ title, body, tone = 'default' }: { title: string; body: string; tone?: 'default' | 'error' }) {
  return (
    <div className={[
      'mx-auto mt-20 max-w-xl rounded-[1.8rem] border px-6 py-6 shadow-[0_24px_60px_rgba(46,58,62,0.12)]',
      tone === 'error' ? 'border-[#b86052]/45 bg-[#f8dfd8]' : 'border-[#c9ae6d]/55 bg-[#f3ecd8]',
    ].join(' ')}>
      <p className="text-[11px] uppercase tracking-[0.3em] text-[#936718]">{title}</p>
      <p className="mt-3 text-sm leading-7 text-[#4d5d63]">{body}</p>
    </div>
  );
}

function Notice({ message, tone }: NoticeState) {
  return (
    <div className={[
      'mb-4 rounded-[1.2rem] border px-4 py-3 text-sm',
      tone === 'success' ? 'border-[#7b9a73]/45 bg-[#e1ebdd] text-[#244028]' : tone === 'error' ? 'border-[#c07f6d]/45 bg-[#f3ddd7] text-[#7a3427]' : 'border-[#c8b48a]/55 bg-[#fff8eb] text-[#4e5e65]',
    ].join(' ')}>
      {message}
    </div>
  );
}


function CharacterLimit({ value, max }: { value: string; max: number }) {
  const length = normalizeChallengeCardText(value).length;
  const isAtLimit = length >= max;

  return (
    <p className={['mt-1 text-right text-[11px]', isAtLimit ? 'text-[#9f3f31]' : 'text-[#7a6a48]'].join(' ')}>
      {length}/{max}
    </p>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7a6a48]">{label}</span>
      {children}
    </label>
  );
}

function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'portable' | 'linked' | 'judged' }) {
  const className = tone === 'judged'
    ? 'border-[#8f80b8]/60 bg-[#ece6f6] text-[#3f3360]'
    : tone === 'portable'
    ? 'border-[#9aa5a7]/55 bg-[#e7ecec] text-[#34464d]'
    : tone === 'linked'
      ? 'border-[#8aa58c]/55 bg-[#dfe9dd] text-[#27412d]'
      : 'border-[#c8b48a]/55 bg-[#efe5cf] text-[#5d4d33]';
  return <span className={'rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ' + className}>{children}</span>;
}

function IconButton({ children, disabled, label, onClick }: { children: ReactNode; disabled?: boolean; label: string; onClick(): void }) {
  return <button aria-label={label} className="rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] px-3 py-2 text-sm text-[#24343a] disabled:opacity-40" disabled={disabled} onClick={onClick} type="button">{children}</button>;
}

function EmptyState({ body }: { body: string }) {
  return <div className="rounded-[1.25rem] border border-dashed border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-5 text-sm leading-6 text-[#5a6a70]">{body}</div>;
}
