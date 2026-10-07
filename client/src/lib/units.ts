// Distances shown to players use US units: feet up close, miles beyond about a tenth of a mile.
const METERS_PER_FOOT = 0.3048;
const METERS_PER_MILE = 1609.344;

export function formatDistance(meters: number): string {
  const miles = meters / METERS_PER_MILE;
  if (miles < 0.1) return Math.max(10, Math.round(meters / METERS_PER_FOOT / 10) * 10) + ' ft';
  return (miles < 10 ? miles.toFixed(1) : Math.round(miles).toString()) + ' mi';
}

export function formatArea(squareMeters: number): string {
  const acres = squareMeters / 4046.856;
  return acres >= 640 ? (acres / 640).toFixed(2) + ' sq mi' : (acres < 10 ? acres.toFixed(1) : Math.round(acres).toString()) + ' acres';
}
