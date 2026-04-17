import mapboxgl from 'mapbox-gl';
import type { Team, TeamLocation } from '@city-game/shared';

export function syncTeamLocationMarkers(
  map: mapboxgl.Map,
  markers: Map<string, mapboxgl.Marker>,
  teams: Team[],
  teamLocations: TeamLocation[],
): void {
  const activeTeamIds = new Set(teamLocations.map((entry) => entry.teamId));
  const teamById = new Map(teams.map((team) => [team.id, team]));

  for (const location of teamLocations) {
    const team = teamById.get(location.teamId);
    if (!team) {
      continue;
    }
    const existingMarker = markers.get(location.teamId);
    if (existingMarker) {
      existingMarker.setLngLat([location.lng, location.lat]);
      continue;
    }

    const marker = new mapboxgl.Marker({
      element: createTeamLocationMarkerElement(team.color),
      anchor: 'bottom',
    })
      .setLngLat([location.lng, location.lat])
      .addTo(map);

    markers.set(location.teamId, marker);
  }

  for (const [teamId, marker] of markers) {
    if (activeTeamIds.has(teamId)) {
      continue;
    }

    marker.remove();
    markers.delete(teamId);
  }
}

export function clearTeamLocationMarkers(markers: Map<string, mapboxgl.Marker>): void {
  for (const marker of markers.values()) {
    marker.remove();
  }
  markers.clear();
}

function createTeamLocationMarkerElement(teamColor: string): HTMLDivElement {
  const root = document.createElement('div');
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.style.alignItems = 'center';
  root.style.pointerEvents = 'none';

  const pin = document.createElement('div');
  pin.style.width = '18px';
  pin.style.height = '18px';
  pin.style.borderRadius = '9999px';
  pin.style.border = '3px solid #f3ecd8';
  pin.style.background = teamColor;
  pin.style.boxShadow = '0 0 0 6px ' + withAlpha(teamColor, 0.22) + ', 0 10px 22px rgba(14, 24, 29, 0.2)';

  const stem = document.createElement('div');
  stem.style.width = '2px';
  stem.style.height = '12px';
  stem.style.borderRadius = '9999px';
  stem.style.background = 'rgba(36, 52, 58, 0.55)';
  stem.style.marginTop = '-4px';

  const colorDot = document.createElement('div');
  colorDot.style.position = 'absolute';
  colorDot.style.width = '8px';
  colorDot.style.height = '8px';
  colorDot.style.borderRadius = '9999px';
  colorDot.style.border = '1px solid #f3ecd8';
  colorDot.style.background = teamColor;
  colorDot.style.transform = 'translate(7px, -2px)';
  colorDot.style.boxShadow = '0 4px 10px rgba(14, 24, 29, 0.18)';

  root.style.position = 'relative';
  root.append(pin, stem, colorDot);
  return root;
}

function withAlpha(color: string, alpha: number): string {
  const normalized = color.trim().replace('#', '');
  const expanded = normalized.length === 3
    ? normalized.split('').map((part) => part + part).join('')
    : normalized;

  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    return 'rgba(36, 52, 58, ' + alpha + ')';
  }

  const r = Number.parseInt(expanded.slice(0, 2), 16);
  const g = Number.parseInt(expanded.slice(2, 4), 16);
  const b = Number.parseInt(expanded.slice(4, 6), 16);
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
}
