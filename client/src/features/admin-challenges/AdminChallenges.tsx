import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import type {
  ChallengeSet,
  ChallengeSetItem,
  ChallengeSetItemLocationMode,
  GeoJsonMultiPolygon,
  GeoJsonPoint,
  GeoJsonPolygon,
  JsonObject,
  MapDefinition,
  MapZone,
} from '@city-game/shared';
import { DEFAULT_CHALLENGE_POINTS, getChallengeArea, MAX_CHALLENGE_BONUSES, getBasePoints, getChallengeBonuses, sumBonusPoints } from '@city-game/shared';
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
import { ChallengeAreaPicker } from './ChallengeAreaPicker';
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
  mapId: string; // '' for a generic set that fits any map
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
  area: GeoJsonPolygon | GeoJsonMultiPolygon | null;
  locationHint: string;
  scoringMode: 'instant' | 'judged';
}

interface BonusFormRow {
  id: string;
  label: string;
  points: string;
  description: string;
}

// Within a point-linked set, each item is either pinned to the map or doable anywhere.
type ItemPlacement = 'pinned' | 'area' | 'anywhere';

const DIFFICULTY_OPTIONS: Array<{ value: Exclude<ChallengeSetItem['difficulty'], null> | ''; label: string }> = [
  { value: '', label: 'Unset' },
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
];

const INITIAL_SET_FORM: SetFormState = {
  locationMode: 'portable',
  mapId: '',
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
  area: null,
  locationHint: '',
  scoringMode: 'instant',
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
  const [itemQuery, setItemQuery] = useState('');
  const [itemFilter, setItemFilter] = useState<ItemFilter>('all');

  const selectedItem = useMemo(() => items.find((item) => item.id === selectedItemId) ?? null, [items, selectedItemId]);
  const sortedSets = useMemo(() => [...sets].sort((left, right) => left.name.localeCompare(right.name)), [sets]);
  const sortedMaps = useMemo(() => [...maps].sort((left, right) => left.name.localeCompare(right.name)), [maps]);
  const currentMapZones = useMemo(() => itemForm.mapId ? (zoneOptionsByMapId[itemForm.mapId] ?? []) : [], [itemForm.mapId, zoneOptionsByMapId]);
  const isAnywherePlacement = setForm.locationMode === 'portable' || (setForm.locationMode === 'point' && itemForm.placement === 'anywhere');
  const visibleItems = useMemo(() => {
    const query = itemQuery.trim().toLowerCase();
    return items.filter((item) => matchesItemFilter(item, itemFilter) && (!query || getItemSearchText(item).includes(query)));
  }, [itemFilter, itemQuery, items]);
  const mapNameById = useMemo(() => new Map(maps.map((map) => [map.id, map.name])), [maps]);
  const setMapId = currentSet?.mapId ?? '';
  // Placement and map changes must be saved first, since items are validated against the saved set.
  const hasUnsavedSetPlacement = Boolean(currentSet) && (setForm.locationMode !== currentSet?.locationMode || setForm.mapId !== setMapId);
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
        const nextForm = buildItemForm(challengeItems[0], challengeSet.mapId);
        setItemForm(nextForm);
        if (nextForm.mapId) {
          void loadZoneOptions(nextForm.mapId);
        }
      } else {
        setItemForm({ ...INITIAL_ITEM_FORM, mapId: challengeSet.mapId ?? '' });
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
      setItemForm({ ...INITIAL_ITEM_FORM, mapId: setMapId });
      if (setMapId) void loadZoneOptions(setMapId);
      return;
    }

    const nextForm = buildItemForm(selectedItem, setMapId || null);
    setItemForm(nextForm);
    if (nextForm.mapId) {
      void loadZoneOptions(nextForm.mapId);
    }
  }, [loadZoneOptions, selectedItem, setMapId]);

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
      setItemForm(INITIAL_ITEM_FORM);
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
        mapId: setForm.mapId || null,
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
    setItemForm({ ...INITIAL_ITEM_FORM, mapId: setMapId });
  };

  const handleSaveItem = async () => {
    if (!currentSet) {
      return;
    }

    if (hasUnsavedSetPlacement) {
      setNotice({ tone: 'info', message: 'Save the set placement and map before editing its challenges.' });
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

    const isPinned = setForm.locationMode === 'point' && itemForm.placement === 'pinned';
    const isArea = setForm.locationMode === 'point' && itemForm.placement === 'area';
    if ((setForm.locationMode === 'zone' || isPinned || isArea) && !itemForm.mapId) {
      setNotice({ tone: 'error', message: 'Choose a map for this set and save it before placing challenges.' });
      return;
    }
    if (setForm.locationMode === 'zone' && !itemForm.mapZoneId) {
      setNotice({ tone: 'error', message: 'Choose a zone.' });
      return;
    }
    if (isArea && !itemForm.area) {
      setNotice({ tone: 'error', message: 'Draw the challenge area.' });
      return;
    }
    if (isPinned && !itemForm.mapPoint) {
      setNotice({ tone: 'error', message: 'Place a point on the map.' });
      return;
    }

    const locationHint = itemForm.locationHint.trim();
    const isJudged = setForm.locationMode === 'point' && itemForm.scoringMode === 'judged';
    const basePoints = itemForm.pointValue.trim() === '' ? DEFAULT_CHALLENGE_POINTS : Math.max(0, Math.floor(Number(itemForm.pointValue) || 0));
    const bonuses = itemForm.bonuses
      .map((bonus) => ({ id: bonus.id, label: bonus.label.trim(), points: Math.floor(Number(bonus.points) || 0), ...(bonus.description.trim() ? { description: bonus.description.trim() } : {}) }))
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
        // The place name shown on the card: "Chinatown Library" for a pin, "Any Costco" for anywhere.
        ...(locationHint ? { location_hint: locationHint } : {}),
        ...(isArea && itemForm.area ? { area: itemForm.area as unknown as JsonObject } : {}),
        ...(bonuses.length ? { bonuses } : {}),
        // Judged challenges are yes/no: a yes earns the points (plus the bonuses the judge approves).
        ...(isJudged ? { judged: true, judging_type: 'pass_fail' } : {}),
      } satisfies JsonObject,
      scoring: { points: basePoints },
      difficulty: itemForm.difficulty || null,
      sortOrder: selectedItem ? selectedItem.sortOrder : items.length,
      metadata: ((setForm.locationMode === 'zone' || isPinned || isArea) && itemForm.mapId ? { sourceMapId: itemForm.mapId } : {}) as JsonObject,
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
        challengeSet?: { name?: string; description?: string | null; locationMode?: ChallengeSetItemLocationMode; mapId?: string | null; metadata?: JsonObject };
        items?: ChallengeSetItem[];
      };

      const importedItems = Array.isArray(parsed.items) ? parsed.items : [];
      const importedSet = parsed.challengeSet ?? {};
      const importedLocationMode = importedSet.locationMode ?? inferImportedSetLocationMode(importedItems);
      // Keep the set's map when it exists here; older exports only name it on their placed items.
      const importedMapId = [importedSet.mapId, ...importedItems.map((item) => item.metadata?.sourceMapId)]
        .find((id): id is string => typeof id === 'string' && maps.some((map) => map.id === id)) ?? null;

      let targetSet = currentSet;
      if (!targetSet) {
        targetSet = await createChallengeSetDefinition({
          name: importedSet.name?.trim() || file.name.replace(/\.json$/i, ''),
          description: importedSet.description ?? '',
          locationMode: importedLocationMode,
          mapId: importedMapId,
          metadata: importedSet.metadata ?? {},
        });
        setSets((current) => [...current, targetSet!]);
        setCurrentSet(targetSet);
        syncRoute(targetSet.id);
      } else {
        // Clear the old items first: the set's map can only change once nothing is placed on it.
        for (const item of items) {
          await deleteChallengeSetItemDefinition(item.id);
        }
        targetSet = await updateChallengeSetDefinition(targetSet.id, {
          name: importedSet.name?.trim() || targetSet.name,
          description: importedSet.description ?? targetSet.description,
          locationMode: importedLocationMode,
          mapId: importedMapId,
          metadata: importedSet.metadata ?? targetSet.metadata,
        });
        setCurrentSet(targetSet);
        setSetForm(buildSetForm(targetSet));
        setSets((current) => current.map((entry) => entry.id === targetSet!.id ? targetSet! : entry));
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

  if (status === 'loading') {
    return <Shell><StatusCard title="Loading" body="Loading reusable challenge sets." /></Shell>;
  }

  if (status === 'error') {
    return <Shell><StatusCard title="Load Failed" body={errorMessage ?? 'Failed to load challenge keeper.'} tone="error" /></Shell>;
  }

  return (
    <Shell>
      <input ref={importInputRef} className="hidden" type="file" accept="application/json" onChange={handleImportFile} />

      <div className="grid min-h-screen gap-4 p-4 lg:grid-cols-[14rem_minmax(0,1fr)_24rem] 2xl:grid-cols-[17rem_minmax(0,1fr)_27rem] lg:p-6">
        {/* Both side columns stick to the viewport and scroll on their own; the page scrolls the challenge list. */}
        <aside className="rounded-[1.75rem] border border-[#c9ae6d]/55 bg-[#f3ecd8] p-4 shadow-[0_24px_60px_rgba(46,58,62,0.14)] lg:sticky lg:top-6 lg:flex lg:max-h-[calc(100vh-3rem)] lg:flex-col lg:self-start">
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

          <div className="mt-4 space-y-2 overflow-y-auto lg:min-h-0 lg:flex-1">
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
                  <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#936718]">{challengeSet.mapId ? (mapNameById.get(challengeSet.mapId) ?? 'Unknown map') : 'Any city'}</p>
                  <p className="mt-1 text-sm text-[#5a6a70] line-clamp-2">{challengeSet.description || 'No description.'}</p>
                </button>
              );
            })}
            {!sortedSets.length ? <EmptyState body="No challenge sets yet. Create one to begin authoring." /> : null}
          </div>
        </aside>

        <main className="min-w-0 self-start rounded-[1.75rem] border border-[#c9ae6d]/55 bg-[#f7f0de] p-5 shadow-[0_24px_60px_rgba(46,58,62,0.12)]">
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

              <section className="mt-4 grid gap-3 rounded-[1.4rem] border border-[#d6c59d]/55 bg-[#fbf4e4] p-4 md:grid-cols-3">
                <Field label="Set Name">
                  <input className={compactInputClassName} value={setForm.name} onChange={(event) => setSetForm((current) => ({ ...current, name: event.target.value }))} />
                </Field>
                <Field label="Map">
                  <select className={compactInputClassName} value={setForm.mapId} onChange={(event) => setSetForm((current) => ({ ...current, mapId: event.target.value }))}>
                    <option value="">Any city (generic)</option>
                    {sortedMaps.map((map) => <option key={map.id} value={map.id}>{map.name}</option>)}
                  </select>
                </Field>
                <Field label="Set Placement">
                  <select className={compactInputClassName} value={setForm.locationMode} onChange={(event) => setSetForm((current) => ({ ...current, locationMode: event.target.value as ChallengeSetItemLocationMode }))}>
                    <option value="portable">Portable</option><option value="zone">Zone Linked</option><option value="point">Point Linked (pins, areas, anywhere)</option>
                  </select>
                </Field>
                <label className="block md:col-span-3">
                  <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7a6a48]">Description</span>
                  <textarea className={compactInputClassName + ' h-16 resize-y'} value={setForm.description} onChange={(event) => setSetForm((current) => ({ ...current, description: event.target.value }))} />
                </label>
                <p className="text-xs leading-5 text-[#6b777b] md:col-span-3">
                  {setForm.mapId ? 'Only games on this map can use the set; pins, areas and zones go on it.' : 'A generic set fits any map, but its challenges can only be "anywhere".'}{' '}
                  {setForm.locationMode === 'point' ? 'Each challenge is pinned to a spot, tied to a drawn area, or doable anywhere.' : 'Every challenge uses this placement type.'}
                </p>
                {hasUnsavedSetPlacement ? <p className="rounded-xl border border-[#d59b45]/45 bg-[#fff0ce] px-3 py-2 text-xs leading-5 text-[#765018] md:col-span-3">Save this placement or map change before creating or editing challenges.</p> : null}
              </section>

              <section className="mt-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.24em] text-[#7a6a48]">Challenges · {items.length}</p>
                    <p className="mt-1 text-sm text-[#59696f]">{currentSet.locationMode === 'point' ? countPlacements(items) : 'All items use the set placement.'} · {describePointTotals(items)}</p>
                  </div>
                  <button className="rounded-full border border-[#24343a] bg-[#24343a] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#f4ead7]" onClick={handleCreateItem} type="button">New Item</button>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input className="min-w-[12rem] flex-1 rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-2 text-sm text-[#24343a] outline-none focus:border-[#8f7446]" placeholder="Search challenges, places, bonuses" value={itemQuery} onChange={(event) => setItemQuery(event.target.value)} />
                  {ITEM_FILTERS.map((filter) => (
                    <button key={filter.key} className={['rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em]', itemFilter === filter.key ? 'border-[#24343a] bg-[#24343a] text-[#f4ead7]' : 'border-[#c8b48a]/55 bg-[#fff8eb] text-[#24343a]'].join(' ')} onClick={() => setItemFilter(filter.key)} type="button">
                      {filter.label} {items.filter((item) => matchesItemFilter(item, filter.key)).length}
                    </button>
                  ))}
                </div>

                <div className="mt-3 space-y-1.5">
                  {visibleItems.map((item) => {
                    const index = items.indexOf(item);
                    const active = item.id === selectedItemId;
                    const bonuses = getChallengeBonuses(item.config);
                    const longText = typeof item.config?.long_description === 'string' && item.config.long_description.trim() ? item.config.long_description : null;
                    return (
                      <article
                        key={item.id}
                        className={[
                          'flex items-stretch gap-2 rounded-[1rem] border px-3 py-2.5 transition',
                          active ? 'border-[#24343a] bg-[#fff8eb] shadow-[0_10px_24px_rgba(36,52,58,0.1)]' : 'border-[#d6c59d]/55 bg-white/60 hover:bg-[#fff8eb]',
                        ].join(' ')}
                      >
                        <button className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-left 2xl:grid-cols-[1.75rem_minmax(0,1fr)_minmax(9rem,13rem)_4.5rem]" onClick={() => setSelectedItemId(item.id)} type="button">
                          <span className="hidden pt-0.5 font-[Georgia,Times_New_Roman,serif] text-sm text-[#9a8a68] 2xl:block">{index + 1}</span>
                          <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className="font-semibold text-[#24343a]">{item.title}</span>
                              {item.config?.judged === true ? <Badge tone="judged">★ Judged</Badge> : null}
                              {item.difficulty ? <Badge>{item.difficulty}</Badge> : null}
                            </span>
                            <span className="mt-0.5 block text-sm leading-5 text-[#4f5f65]">{getShortDescription(item)}</span>
                            {longText && longText !== getShortDescription(item) ? <span className="mt-0.5 block text-xs leading-5 text-[#7a8589] line-clamp-2">More info: {longText}</span> : null}
                            {bonuses.length ? (
                              <span className="mt-1 flex flex-wrap gap-1">
                                {bonuses.map((bonus) => <span key={bonus.id} className="rounded-md border border-[#d9c79e] bg-[#f6ecd4] px-1.5 py-0.5 text-[11px] leading-4 text-[#5d4d33]">+{bonus.points} {bonus.label}</span>)}
                              </span>
                            ) : null}
                          </span>
                          <ItemWhere item={item} setMode={currentSet.locationMode} zoneName={item.mapZoneId ? currentMapZones.find((zone) => zone.id === item.mapZoneId)?.name ?? null : null} />
                          <span className="col-start-2 row-start-1 text-right 2xl:col-start-4">
                            <span className="font-[Georgia,Times_New_Roman,serif] text-lg font-semibold text-[#24343a]">{getBasePoints(item.scoring)}</span>
                            <span className="ml-1 text-[11px] uppercase tracking-[0.12em] text-[#7a6a48]">pt</span>
                            {bonuses.length ? <span className="block text-[11px] text-[#936718]">+{sumBonusPoints(bonuses)} bonus</span> : null}
                          </span>
                        </button>
                        <div className="flex flex-col justify-center gap-1">
                          <IconButton disabled={index === 0} label="Move up" onClick={() => void handleMoveItem(-1, item)}>↑</IconButton>
                          <IconButton disabled={index === items.length - 1} label="Move down" onClick={() => void handleMoveItem(1, item)}>↓</IconButton>
                        </div>
                      </article>
                    );
                  })}
                  {items.length && !visibleItems.length ? <EmptyState body="No challenges match." /> : null}
                  {!items.length ? <EmptyState body="No items yet. Add the reusable cards for this set here." /> : null}
                </div>
              </section>
            </>
          ) : (
            <EmptyState body="Create or import a challenge set to begin." />
          )}
        </main>

        <aside className="rounded-[1.75rem] border border-[#c9ae6d]/55 bg-[#f3ecd8] p-5 shadow-[0_24px_60px_rgba(46,58,62,0.12)] lg:sticky lg:top-6 lg:flex lg:max-h-[calc(100vh-3rem)] lg:flex-col lg:self-start">
          <div className="flex items-center justify-between gap-3 border-b border-[#d6c59d]/55 pb-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.24em] text-[#7a6a48]">Item Editor</p>
              <h2 className="mt-2 font-[Georgia,Times_New_Roman,serif] text-2xl font-semibold text-[#24343a]">{selectedItem ? 'Edit Item' : 'New Item'}</h2>
            </div>
            {selectedItem ? (
              <button className="rounded-full border border-[#b86052]/45 bg-[#f8dfd8] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#7d2d26]" disabled={isSavingItem} onClick={() => void handleDeleteItem()} type="button">Delete</button>
            ) : null}
          </div>

          <div className="-mx-1 mt-4 space-y-3 overflow-y-auto px-1 pb-1 lg:min-h-0 lg:flex-1">
            <Field label="Title">
              <input className={compactInputClassName} maxLength={CHALLENGE_CARD_TITLE_MAX_LENGTH} value={itemForm.title} onChange={(event) => setItemForm((current) => ({ ...current, title: event.target.value }))} />
              <CharacterLimit value={itemForm.title} max={CHALLENGE_CARD_TITLE_MAX_LENGTH} />
            </Field>
            <Field label="Short Description">
              <textarea className={compactInputClassName + ' h-20'} maxLength={CHALLENGE_CARD_SHORT_DESCRIPTION_MAX_LENGTH} value={itemForm.shortDescription} onChange={(event) => setItemForm((current) => ({ ...current, shortDescription: event.target.value }))} />
              <CharacterLimit value={itemForm.shortDescription} max={CHALLENGE_CARD_SHORT_DESCRIPTION_MAX_LENGTH} />
            </Field>
            <Field label="Long Description">
              <textarea className={compactInputClassName + ' h-24'} value={itemForm.longDescription} onChange={(event) => setItemForm((current) => ({ ...current, longDescription: event.target.value }))} />
            </Field>
            {setForm.locationMode === 'point' ? (
              <div>
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7a6a48]">Where</span>
                <div className="grid grid-cols-3 gap-2">
                  <button className={placementClassName(itemForm.placement === 'pinned')} onClick={() => setItemForm((current) => ({ ...current, placement: 'pinned' }))} type="button">Pinned point</button>
                  <button className={placementClassName(itemForm.placement === 'area')} onClick={() => setItemForm((current) => ({ ...current, placement: 'area' }))} type="button">Area</button>
                  <button className={placementClassName(itemForm.placement === 'anywhere')} onClick={() => setItemForm((current) => ({ ...current, placement: 'anywhere' }))} type="button">Anywhere</button>
                </div>
                <p className="mt-2 text-xs leading-5 text-[#6b777b]">{itemForm.placement === 'pinned' ? 'Players must reach this spot; it shows as a pin on the map.' : itemForm.placement === 'area' ? 'Players can do it anywhere inside an area you draw; it shows as a shaded area on the map.' : 'Players can do this wherever they are; it shows in the deck.'}</p>
              </div>
            ) : null}

            <Field label="Place Name (optional)">
              <input className={compactInputClassName} maxLength={40} placeholder={isAnywherePlacement ? 'e.g. Any Costco, Any park, A bridge' : itemForm.placement === 'area' || setForm.locationMode === 'zone' ? 'e.g. The 606, Northerly Island' : 'e.g. Chinatown Library'} value={itemForm.locationHint} onChange={(event) => setItemForm((current) => ({ ...current, locationHint: event.target.value }))} />
              <p className="mt-1 text-xs leading-5 text-[#6b777b]">{isAnywherePlacement ? 'Shown on the card so players know what sort of place works. Leave blank for truly anywhere.' : 'Shown on the card next to the distance, e.g. "Chinatown Library · 1.2 mi away". Leave blank for "Pinned spot".'}</p>
            </Field>

            {setForm.locationMode === 'point' ? (
              <div>
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7a6a48]">Scoring</span>
                <div className="grid grid-cols-2 gap-2">
                  <button className={placementClassName(itemForm.scoringMode === 'instant')} onClick={() => setItemForm((current) => ({ ...current, scoringMode: 'instant' }))} type="button">Instant points</button>
                  <button className={placementClassName(itemForm.scoringMode === 'judged')} onClick={() => setItemForm((current) => ({ ...current, scoringMode: 'judged' }))} type="button">Judged yes / no</button>
                </div>
                <p className="mt-2 text-xs leading-5 text-[#6b777b]">{itemForm.scoringMode === 'judged' ? 'A bonus every team can do once. Teams complete it like any other challenge; you mark each team yes or no on the Judging page, during or after the game. Yes earns the points.' : 'The first team to complete it takes the points, and it disappears for everyone.'}</p>
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <Field label="Points">
                <input className={compactInputClassName} min="0" onChange={(event) => setItemForm((current) => ({ ...current, pointValue: event.target.value }))} type="number" value={itemForm.pointValue} />
              </Field>
              <Field label="Difficulty">
                <select className={compactInputClassName} value={itemForm.difficulty} onChange={(event) => setItemForm((current) => ({ ...current, difficulty: event.target.value as ItemFormState['difficulty'] }))}>
                  {DIFFICULTY_OPTIONS.map((option) => <option key={option.label} value={option.value}>{option.label}</option>)}
                </select>
              </Field>
            </div>
            <p className="-mt-1 text-xs leading-5 text-[#6b777b]">{itemForm.scoringMode === 'judged' && setForm.locationMode === 'point' ? 'Points a team gets when judged a yes. Approved bonuses add on top.' : 'Base points for completing it. Bonus tasks add on top.'}</p>

            <BonusEditor
              isJudged={setForm.locationMode === 'point' && itemForm.scoringMode === 'judged'}
              rows={itemForm.bonuses}
              onChange={(bonuses) => setItemForm((current) => ({ ...current, bonuses }))}
            />

            {setForm.locationMode === 'zone' || (setForm.locationMode === 'point' && itemForm.placement !== 'anywhere') ? (
              <Field label="Map">
                {itemForm.mapId ? (
                  <p className="rounded-2xl border border-[#c8b48a]/40 bg-[#f7efdc] px-4 py-3 text-sm text-[#24343a]">{mapNameById.get(itemForm.mapId) ?? 'Unknown map'} <span className="text-[#6b777b]">· the set's map</span></p>
                ) : (
                  <p className="rounded-xl border border-[#d59b45]/45 bg-[#fff0ce] px-3 py-2 text-xs leading-5 text-[#765018]">Choose a map for this set on the left and save it, then place challenges on it.</p>
                )}
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

            {setForm.locationMode === 'point' && itemForm.placement === 'area' ? (
              <div>
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7a6a48]">Challenge Area</span>
                <ChallengeAreaPicker
                  key={(selectedItem?.id ?? 'new') + ':' + itemForm.mapId}
                  mapDefinition={selectedMap}
                  onChange={(area) => setItemForm((current) => ({ ...current, area }))}
                  value={itemForm.area}
                />
              </div>
            ) : null}

            <button className="mt-2 w-full rounded-2xl border border-[#24343a] bg-[#24343a] px-4 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-[#f4ead7] disabled:cursor-not-allowed disabled:opacity-50" disabled={isSavingItem || !currentSet || hasUnsavedSetPlacement} onClick={() => void handleSaveItem()} type="button">{selectedItem ? 'Save Item' : 'Create Item'}</button>
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
    mapId: challengeSet.mapId ?? '',
    name: challengeSet.name,
    description: challengeSet.description ?? '',
  };
}

function buildItemForm(item: ChallengeSetItem, setMapId: string | null): ItemFormState {
  const sourceMapId = setMapId || getSourceMapId(item);
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
    bonuses: getChallengeBonuses(item.config).map((bonus) => ({ id: bonus.id, label: bonus.label, points: String(bonus.points), description: bonus.description ?? '' })),
    placement: item.mapPoint ? 'pinned' : getChallengeArea(item.config) ? 'area' : 'anywhere',
    area: getChallengeArea(item.config),
    locationHint: typeof item.config?.location_hint === 'string' ? item.config.location_hint : '',
    scoringMode: item.config?.judged === true ? 'judged' : 'instant',
  };
}

function BonusEditor({ rows, isJudged, onChange }: { rows: BonusFormRow[]; isJudged: boolean; onChange(rows: BonusFormRow[]): void }) {
  const update = (id: string, patch: Partial<BonusFormRow>) => onChange(rows.map((row) => row.id === id ? { ...row, ...patch } : row));
  const inputClassName = 'rounded-xl border border-[#c8b48a]/55 bg-[#fff8eb] px-3 py-2 text-sm text-[#24343a] outline-none focus:border-[#8f7446]';
  return (
    <div>
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7a6a48]">Bonus Tasks</span>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.id} className="space-y-1.5 rounded-2xl border border-[#d6c59d]/55 bg-white/40 p-2">
            <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_auto] items-center gap-2">
              <input aria-label="Bonus task" className={inputClassName} maxLength={60} onChange={(event) => update(row.id, { label: event.target.value })} placeholder="Short, e.g. Do it in costume" value={row.label} />
              <input aria-label="Bonus points" className={inputClassName + ' text-right'} onChange={(event) => update(row.id, { points: event.target.value })} placeholder="pts" type="number" value={row.points} />
              <button aria-label="Remove bonus" className="h-9 w-9 rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] text-sm text-[#7d2d26]" onClick={() => onChange(rows.filter((entry) => entry.id !== row.id))} type="button">×</button>
            </div>
            <textarea aria-label="Bonus details" className={inputClassName + ' h-14 w-full'} maxLength={400} onChange={(event) => update(row.id, { description: event.target.value })} placeholder="Details (optional): shown behind an info button" value={row.description} />
          </div>
        ))}
      </div>
      {rows.length < MAX_CHALLENGE_BONUSES ? <button className="mt-2 rounded-full border border-dashed border-[#a88c52] bg-[#fff8eb] px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#5d4d33]" onClick={() => onChange([...rows, { id: 'bonus-' + crypto.randomUUID().slice(0, 8), label: '', points: '1', description: '' }])} type="button">+ Add bonus</button> : null}
      <p className="mt-1.5 text-xs leading-5 text-[#6b777b]">{isJudged ? 'Up to ' + MAX_CHALLENGE_BONUSES + '. Teams tick the ones they did when completing; judges approve each one.' : 'Optional extras, up to ' + MAX_CHALLENGE_BONUSES + '. Teams tick the ones they did when completing, and each adds its points.'}</p>
    </div>
  );
}

type ItemFilter = 'all' | 'pinned' | 'area' | 'anywhere' | 'judged';

const ITEM_FILTERS: Array<{ key: ItemFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pinned', label: 'Pinned' },
  { key: 'area', label: 'Area' },
  { key: 'anywhere', label: 'Anywhere' },
  { key: 'judged', label: 'Judged' },
];

const compactInputClassName = 'w-full rounded-xl border border-[#c8b48a]/55 bg-[#fff8eb] px-3 py-2 text-sm text-[#24343a] outline-none focus:border-[#8f7446]';

function matchesItemFilter(item: ChallengeSetItem, filter: ItemFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'judged') return item.config?.judged === true;
  if (filter === 'pinned') return Boolean(item.mapPoint || item.mapZoneId);
  if (filter === 'area') return Boolean(getChallengeArea(item.config));
  return !item.mapPoint && !item.mapZoneId && !getChallengeArea(item.config);
}

function getItemSearchText(item: ChallengeSetItem): string {
  const config = item.config ?? {};
  return [item.title, item.description, config.short_description, config.long_description, config.location_hint, ...getChallengeBonuses(config).map((bonus) => bonus.label)]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

// "27 pts + 14 bonus available", counting judged challenges separately.
function describePointTotals(items: ChallengeSetItem[]): string {
  const regular = items.filter((item) => item.config?.judged !== true);
  const judged = items.length - regular.length;
  const base = regular.reduce((total, item) => total + getBasePoints(item.scoring), 0);
  const bonus = regular.reduce((total, item) => total + sumBonusPoints(getChallengeBonuses(item.config)), 0);
  return base + ' pts' + (bonus ? ' + ' + bonus + ' bonus' : '') + (judged ? ', plus judged' : '');
}

function ItemWhere({ item, setMode, zoneName }: { item: ChallengeSetItem; setMode: ChallengeSetItemLocationMode; zoneName: string | null }) {
  const name = typeof item.config?.location_hint === 'string' && item.config.location_hint.trim() ? item.config.location_hint.trim() : null;
  const radius = typeof item.config?.point_radius_meters === 'number' ? item.config.point_radius_meters : null;
  const kind = item.mapZoneId ? 'Zone' : item.mapPoint ? 'Pinned' : getChallengeArea(item.config) ? 'Area' : setMode === 'portable' ? 'Portable' : 'Anywhere';
  const detail = item.mapZoneId ? zoneName : item.mapPoint ? (radius ? radius + ' m radius' : null) : null;
  const tone = kind === 'Anywhere' || kind === 'Portable' ? 'text-[#4b5d63]' : 'text-[#2f5a3a]';
  return (
    <span className="min-w-0 text-sm leading-5 2xl:col-start-3 2xl:row-start-1">
      <span className={'block text-[11px] font-semibold uppercase tracking-[0.14em] ' + tone}>{kind === 'Pinned' ? '📍 ' : kind === 'Area' ? '▧ ' : ''}{kind}{detail ? ' · ' + detail : ''}</span>
      <span className={name ? 'block truncate text-[#24343a]' : 'block text-[#9aa3a5] italic'}>{name ?? (kind === 'Anywhere' || kind === 'Portable' ? 'Anywhere' : 'No place name')}</span>
    </span>
  );
}

function countPlacements(items: ChallengeSetItem[]): string {
  const pinned = items.filter((item) => item.mapPoint).length;
  const areas = items.filter((item) => getChallengeArea(item.config)).length;
  const judged = items.filter((item) => item.config?.judged === true).length;
  return pinned + ' pinned · ' + areas + ' areas · ' + (items.length - pinned - areas) + ' anywhere' + (judged ? ' · ' + judged + ' judged' : '');
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
