import mapboxgl from 'mapbox-gl';
import type { Team, TeamLocation } from '@city-game/shared';

export function syncTeamLocationMarkers(
  map: mapboxgl.Map,
  markers: Map<string, mapboxgl.Marker>,
  teams: Team[],
  teamLocations: TeamLocation[],
): void {
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const activeTeamIds = new Set(teamLocations.map((entry) => entry.teamId));

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
      element: createTeamLocationMarkerElement(team),
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

function createTeamLocationMarkerElement(team: Team): HTMLDivElement {
  const root = document.createElement('div');
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.style.alignItems = 'center';
  root.style.gap = '6px';
  root.style.pointerEvents = 'none';

  const label = document.createElement('div');
  label.textContent = team.name;
  label.style.padding = '5px 10px';
  label.style.borderRadius = '9999px';
  label.style.border = '1px solid rgba(244, 234, 215, 0.75)';
  label.style.background = 'rgba(243, 236, 216, 0.94)';
  label.style.color = '#24343a';
  label.style.fontSize = '11px';
  label.style.fontWeight = '700';
  label.style.letterSpacing = '0.08em';
  label.style.textTransform = 'uppercase';
  label.style.boxShadow = '0 10px 22px rgba(18, 28, 32, 0.16)';

  const pin = document.createElement('div');
  pin.style.width = '18px';
  pin.style.height = '18px';
  pin.style.borderRadius = '9999px';
  pin.style.border = '3px solid #f3ecd8';
  pin.style.background = team.color;
  pin.style.boxShadow = '0 0 0 6px ' + withAlpha(team.color, 0.22) + ', 0 10px 22px rgba(14, 24, 29, 0.2)';

  const stem = document.createElement('div');
  stem.style.width = '2px';
  stem.style.height = '12px';
  stem.style.borderRadius = '9999px';
  stem.style.background = 'rgba(36, 52, 58, 0.55)';
  stem.style.marginTop = '-4px';

  root.append(label, pin, stem);
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
