import osmtogeojson from 'osmtogeojson';
import type { GeoJsonFeature, GeoJsonFeatureCollection, GeoJsonPolygon, JsonObject } from '@city-game/shared';
import { errorCodes } from '@city-game/shared';
import { env } from '../db/env.js';
import { AppError } from '../lib/errors.js';

export interface OsmPreviewProperties extends JsonObject {
  name: string;
  source: 'osm';
  osmType: string;
  osmId: number | null;
  adminLevel: string | null;
  metadata: JsonObject;
}

export interface OsmImportService {
  previewAdministrativeBoundaries(input: {
    city: string;
  }): Promise<GeoJsonFeatureCollection<GeoJsonPolygon, OsmPreviewProperties>>;
}

export interface CreateOsmImportServiceOptions {
  endpoint?: string;
  fetch?: typeof fetch;
  minIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface OverpassResponse {
  elements?: unknown[];
}

interface RawGeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: RawGeoJsonFeature[];
}

interface RawGeoJsonFeature {
  type: 'Feature';
  id?: string | number;
  geometry: {
    type: 'Polygon' | 'MultiPolygon' | string;
    coordinates: unknown;
  } | null;
  properties?: Record<string, unknown> | null;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_INTERVAL_MS = 1_000;

export function createOsmImportService(options: CreateOsmImportServiceOptions = {}): OsmImportService {
  const fetchImpl = options.fetch ?? fetch;
  const endpoint = options.endpoint ?? env.overpassApiUrl;
  const minIntervalMs = options.minIntervalMs ?? env.overpassMinIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? env.overpassTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let nextAllowedRequestAt = 0;
  let queue = Promise.resolve();

  async function waitForRateLimit() {
    const turn = queue.then(async () => {
      const currentTime = now();
      const waitMs = Math.max(0, nextAllowedRequestAt - currentTime);

      if (waitMs > 0) {
        await sleep(waitMs);
      }

      nextAllowedRequestAt = Math.max(nextAllowedRequestAt, now()) + minIntervalMs;
    });

    queue = turn.catch(() => undefined);
    await turn;
  }

  return {
    async previewAdministrativeBoundaries({ city }) {
      const normalizedCity = city.trim();

      if (!normalizedCity) {
        throw new AppError(errorCodes.validationError, {
          message: 'City is required for OSM preview.',
        });
      }

      const relationResult = await fetchPreviewCollection('relation', normalizedCity);

      if (relationResult.features.length > 0) {
        return relationResult;
      }

      return fetchPreviewCollection('way', normalizedCity);
    },
  };

  async function fetchPreviewCollection(
    elementType: 'relation' | 'way',
    city: string,
  ): Promise<GeoJsonFeatureCollection<GeoJsonPolygon, OsmPreviewProperties>> {
    await waitForRateLimit();

    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
      },
      body: buildOverpassQuery(city, elementType),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((cause) => {
      throw new AppError(errorCodes.internalServerError, {
        message: 'Failed to fetch OSM preview.',
        cause,
      });
    });

    if (!response.ok) {
      throw new AppError(errorCodes.internalServerError, {
        message: 'Failed to fetch OSM preview.',
        details: {
          status: response.status,
          statusText: response.statusText,
        },
      });
    }

    const payload = (await response.json()) as OverpassResponse;
    const geoJson = osmtogeojson(payload as never) as RawGeoJsonFeatureCollection;

    return normalizePreviewCollection(geoJson, city);
  }
}

export function buildOverpassQuery(city: string, elementType: 'relation' | 'way'): string {
  const escapedCity = city.replace(/\\/g, '\\\\').replace(/"/g, '\\"').trim();

  return [
    '[out:json][timeout:25];',
    `area["boundary"="administrative"]["name"="${escapedCity}"]->.searchArea;`,
    `${elementType}["boundary"="administrative"]["admin_level"~"9|10"](area.searchArea);`,
    'out geom;',
  ].join('\n');
}

function normalizePreviewCollection(
  collection: RawGeoJsonFeatureCollection,
  city: string,
): GeoJsonFeatureCollection<GeoJsonPolygon, OsmPreviewProperties> {
  const features = collection.features
    .flatMap((feature, index) => normalizeFeature(feature, city, index))
    .sort((left, right) => left.properties.name.localeCompare(right.properties.name));

  return {
    type: 'FeatureCollection',
    features,
  };
}

function normalizeFeature(
  feature: RawGeoJsonFeature,
  city: string,
  fallbackIndex: number,
): Array<GeoJsonFeature<GeoJsonPolygon, OsmPreviewProperties>> {
  if (!feature.geometry) {
    return [];
  }

  const sourceProperties = isRecord(feature.properties) ? feature.properties : {};
  const metadataTags = (isRecord(sourceProperties.tags) ? sourceProperties.tags : {}) as JsonObject;
  const name = stringValue(sourceProperties.name) ?? stringValue(metadataTags.name) ?? `OSM Zone ${fallbackIndex + 1}`;
  const osmType = stringValue(sourceProperties.type) ?? parseTypeFromFeatureId(feature.id) ?? 'unknown';
  const osmId = numberValue(sourceProperties.id) ?? parseIdFromFeatureId(feature.id);
  const adminLevel =
    stringValue(sourceProperties.admin_level) ?? stringValue(metadataTags.admin_level) ?? null;

  const baseProperties: OsmPreviewProperties = {
    name,
    source: 'osm',
    osmType,
    osmId,
    adminLevel,
    metadata: {
      source: 'osm',
      sourceCity: city,
      osmType,
      osmId,
      adminLevel,
      tags: metadataTags,
    },
  };

  if (feature.geometry.type === 'Polygon') {
    return isPolygonCoordinates(feature.geometry.coordinates)
      ? [
          {
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: feature.geometry.coordinates,
            },
            properties: baseProperties,
            ...(feature.id === undefined ? {} : { id: feature.id }),
          },
        ]
      : [];
  }

  if (feature.geometry.type === 'MultiPolygon' && isMultiPolygonCoordinates(feature.geometry.coordinates)) {
    const multiPolygonCoordinates = feature.geometry.coordinates;

    return multiPolygonCoordinates.map((coordinates, index) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'Polygon' as const,
        coordinates,
      },
      properties: {
        ...baseProperties,
        name: multiPolygonCoordinates.length > 1 ? `${name} ${index + 1}` : name,
      },
      ...(feature.id === undefined ? {} : { id: `${feature.id}-${index + 1}` }),
    }));
  }

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isPolygonCoordinates(value: unknown): value is GeoJsonPolygon['coordinates'] {
  return Array.isArray(value);
}

function isMultiPolygonCoordinates(value: unknown): value is GeoJsonPolygon['coordinates'][] {
  return Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function parseTypeFromFeatureId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const [type] = value.split('/');
  return type || null;
}

function parseIdFromFeatureId(value: unknown): number | null {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const [, rawId] = value.split('/');
  const parsed = Number(rawId);
  return Number.isFinite(parsed) ? parsed : null;
}
