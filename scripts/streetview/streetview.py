# Renders a high-resolution Street View picture of a place, e.g. for a final-clue image.
# Uses Google's Map Tiles API (full panoramas, typically 16384x8192) instead of the Street View
# Static API, which stops at 640x640. The view is re-projected from the panorama tiles, so any size
# and field of view works; at the default 80° a 3000px picture is about native resolution.
#
#   GOOGLE_MAPS_API_KEY=... python3 scripts/streetview/streetview.py --place "Alliance Bakery, 1736 W Division St, Chicago" -o alliance.jpg
#   GOOGLE_MAPS_API_KEY=... python3 scripts/streetview/streetview.py --lat 41.90343 --lng -87.67143 --heading 10 -o spot.jpg
#
# The key needs the Map Tiles API (and the Places API for --place). Needs numpy and Pillow.
# Without --heading the camera points from the chosen panorama at the place.
import argparse, concurrent.futures, io, json, math, os, sys, urllib.parse, urllib.request
import numpy as np
from PIL import Image

TILES = "https://tile.googleapis.com/v1"


def request_json(url, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(req) as res:
        return json.load(res)


def find_place(key, query):
    found = request_json("https://places.googleapis.com/v1/places:searchText", {"textQuery": query, "pageSize": 1},
                         {"X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location"})
    places = found.get("places") or []
    if not places:
        sys.exit(f"No place found for {query!r}.")
    place = places[0]
    print(f"Place: {place['displayName']['text']}, {place['formattedAddress']}", file=sys.stderr)
    return place["location"]["latitude"], place["location"]["longitude"]


def bearing(lat1, lng1, lat2, lng2):
    la1, lo1, la2, lo2 = map(math.radians, (lat1, lng1, lat2, lng2))
    y = math.sin(lo2 - lo1) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(lo2 - lo1)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def newest_pano(auth, lat, lng, radius):
    # The single nearest panorama is often years old (an alley, a sidewalk shot), so look around a
    # grid of points and take the most recent one, nearest first among equals.
    step = max(10, radius // 3)
    points = [{"lat": lat + dy / 111111, "lng": lng + dx / (111111 * math.cos(math.radians(lat)))}
              for dy in range(-radius, radius + 1, step) for dx in range(-radius, radius + 1, step)]
    found = request_json(f"{TILES}/streetview/panoIds?{auth}", {"locations": points, "radius": step}).get("panoIds") or []
    candidates = []
    for pano in dict.fromkeys(p for p in found if p):
        meta = request_json(f"{TILES}/streetview/metadata?{auth}&panoId={urllib.parse.quote(pano)}")
        distance = math.hypot((meta["lat"] - lat) * 111111, (meta["lng"] - lng) * 111111 * math.cos(math.radians(lat)))
        candidates.append((meta.get("date", ""), -distance, pano))
    if not candidates:
        sys.exit(f"No Street View panorama within {radius} m.")
    return max(candidates)[2]


def render(key, session, pano, meta, heading, pitch, fov, size):
    # The highest zoom level: the full panorama is imageWidth wide, in tileWidth tiles.
    tile = meta["tileWidth"]
    width, height = meta["imageWidth"], meta["imageHeight"]
    zoom = round(math.log2(width / tile))

    # A ray per output pixel, turned to the view's pitch, then mapped onto the panorama
    # (its centre column faces the panorama's own heading).
    focal = (size / 2) / math.tan(math.radians(fov / 2))
    xs, ys = np.meshgrid(np.arange(size) - size / 2 + 0.5, np.arange(size) - size / 2 + 0.5)
    dx, dy, dz = xs, -ys, np.full_like(xs, focal)
    p = math.radians(pitch)
    dy, dz = dy * math.cos(p) + dz * math.sin(p), -dy * math.sin(p) + dz * math.cos(p)
    yaw = np.degrees(np.arctan2(dx, dz)) + heading
    elevation = np.degrees(np.arctan2(dy, np.hypot(dx, dz)))
    u = (((yaw - meta["heading"]) / 360 + 0.5) % 1) * width
    v = np.clip((0.5 - elevation / 180) * height, 0, height - 1.001)

    # Only the tiles the view touches.
    cols = sorted({int(c) for c in np.unique(u // tile)} | {int(c) % (width // tile) for c in np.unique(u // tile + 1)})
    rows = sorted({int(r) for r in np.unique(v // tile)} | {min(int(r), height // tile - 1) for r in np.unique(v // tile + 1)})
    canvas = np.zeros((height, width, 3), dtype=np.uint8)

    def fetch(cr):
        c, r = cr
        url = f"{TILES}/streetview/tiles/{zoom}/{c}/{r}?" + urllib.parse.urlencode({"session": session, "key": key, "panoId": pano})
        with urllib.request.urlopen(url) as res:
            return c, r, Image.open(io.BytesIO(res.read())).convert("RGB").resize((tile, tile))

    with concurrent.futures.ThreadPoolExecutor(12) as pool:
        for c, r, img in pool.map(fetch, [(c, r) for c in cols for r in rows]):
            canvas[r * tile:(r + 1) * tile, c * tile:(c + 1) * tile] = np.asarray(img)

    # Bilinear sampling, wrapping around the panorama's seam.
    u0, v0 = np.floor(u).astype(int), np.floor(v).astype(int)
    fu, fv = (u - u0)[..., None], (v - v0)[..., None]
    u1, u0 = (u0 + 1) % width, u0 % width
    out = (canvas[v0, u0] * (1 - fu) * (1 - fv) + canvas[v0, u1] * fu * (1 - fv)
           + canvas[v0 + 1, u0] * (1 - fu) * fv + canvas[v0 + 1, u1] * fu * fv)
    return Image.fromarray(out.astype(np.uint8))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    where = parser.add_mutually_exclusive_group(required=True)
    where.add_argument("--place", help="Search text for the place, e.g. a business name and address.")
    where.add_argument("--lat", type=float)
    parser.add_argument("--lng", type=float)
    parser.add_argument("--pano", help="Use this panorama id instead of the nearest one.")
    parser.add_argument("--radius", type=int, default=50, help="Metres to search for a panorama (default 50).")
    parser.add_argument("--heading", type=float, help="Compass direction to face. Default: towards the place.")
    parser.add_argument("--pitch", type=float, default=8)
    parser.add_argument("--fov", type=float, default=80, help="Field of view in degrees; smaller zooms in.")
    parser.add_argument("--size", type=int, default=3000, help="Output width and height in pixels.")
    parser.add_argument("-o", "--output", required=True)
    args = parser.parse_args()

    key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not key:
        sys.exit("Set GOOGLE_MAPS_API_KEY.")
    if args.lat is not None and args.lng is None:
        sys.exit("--lat needs --lng.")
    lat, lng = find_place(key, args.place) if args.place else (args.lat, args.lng)

    session = request_json(f"{TILES}/createSession?key={key}", {"mapType": "streetview", "language": "en-US", "region": "US"})["session"]
    auth = urllib.parse.urlencode({"session": session, "key": key})
    pano = args.pano or newest_pano(auth, lat, lng, args.radius)
    meta = request_json(f"{TILES}/streetview/metadata?{auth}&panoId={urllib.parse.quote(pano)}")
    heading = args.heading if args.heading is not None else bearing(meta["lat"], meta["lng"], lat, lng)
    print(f"Panorama {pano} from {meta.get('date', '?')}, {meta['imageWidth']}x{meta['imageHeight']}, facing {heading:.0f}°", file=sys.stderr)

    render(key, session, pano, meta, heading, args.pitch, args.fov, args.size).save(args.output, quality=93)
    print(args.output)


if __name__ == "__main__":
    main()
