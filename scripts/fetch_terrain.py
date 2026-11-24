#!/usr/bin/env python3
"""
Download open AWS Terrarium elevation tiles covering Mont Blanc / Vallée Blanche
around Chamonix (45.878° N, 6.887° E) and preprocess them into a fast-loading
16-bit binary heightmap + JSON metadata inside public/terrain/.

Terrarium encoding:
  elevation_meters = (R * 256 + G + B / 256) - 32768
"""

import json
import math
import os
import struct
import urllib.request
from io import BytesIO
from pathlib import Path
from PIL import Image

CENTER_LAT = 45.878
CENTER_LON = 6.887
ZOOM = 13
GRID_SIZE = 512  # Output heightmap resolution (512x512 uint16 = 524 KB)
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

# Real Mont Blanc massif landmarks for orientation & optional reference
LANDMARKS = [
    {"name": "Aiguille du Midi", "lat": 45.8786, "lon": 6.8875},
    {"name": "Vallée Blanche (Upper)", "lat": 45.8695, "lon": 6.8990},
    {"name": "Mont Blanc du Tacul", "lat": 45.8565, "lon": 6.8878},
    {"name": "Pointe Helbronner", "lat": 45.8453, "lon": 6.9325},
    {"name": "Glacier du Géant", "lat": 45.8680, "lon": 6.9220},
    {"name": "Mer de Glace", "lat": 45.9030, "lon": 6.9350},
    {"name": "Mont Blanc", "lat": 45.8326, "lon": 6.8652},
]


def latlon_to_tile_float(lat: float, lon: float, zoom: int) -> tuple[float, float]:
    n = 2.0 ** zoom
    x = (lon + 180.0) / 360.0 * n
    lat_rad = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n
    return x, y


def tile_to_latlon(tx: float, ty: float, zoom: int) -> tuple[float, float]:
    n = 2.0 ** zoom
    lon = tx / n * 360.0 - 180.0
    lat_rad = math.atan(math.sinh(math.pi * (1.0 - 2.0 * ty / n)))
    lat = math.degrees(lat_rad)
    return lat, lon


def fetch_tile(z: int, x: int, y: int) -> Image.Image:
    url = TILE_URL.format(z=z, x=x, y=y)
    req = urllib.request.Request(url, headers={"User-Agent": "chamonix-ski-sim/1.0"})
    print(f"Fetching {url} ...")
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = resp.read()
    return Image.open(BytesIO(data)).convert("RGB")


def decode_terrarium_grid(img: Image.Image) -> list[list[float]]:
    w, h = img.size
    px = img.load()
    grid = [[0.0] * w for _ in range(h)]
    for j in range(h):
        row = grid[j]
        for i in range(w):
            r, g, b = px[i, j]
            row[i] = (r * 256.0 + g + b / 256.0) - 32768.0
    return grid


def resample_bilinear(src: list[list[float]], dst_w: int, dst_h: int) -> list[list[float]]:
    src_h = len(src)
    src_w = len(src[0])
    out = [[0.0] * dst_w for _ in range(dst_h)]
    for j in range(dst_h):
        fy = j * (src_h - 1) / (dst_h - 1)
        y0 = int(fy)
        y1 = min(y0 + 1, src_h - 1)
        ty = fy - y0
        row0 = src[y0]
        row1 = src[y1]
        out_row = out[j]
        for i in range(dst_w):
            fx = i * (src_w - 1) / (dst_w - 1)
            x0 = int(fx)
            x1 = min(x0 + 1, src_w - 1)
            tx = fx - x0
            v00 = row0[x0]
            v10 = row0[x1]
            v01 = row1[x0]
            v11 = row1[x1]
            v0 = v00 + (v10 - v00) * tx
            v1 = v01 + (v11 - v01) * tx
            out_row[i] = v0 + (v1 - v0) * ty
    return out


def light_gaussian_smooth(grid: list[list[float]], passes: int = 1) -> list[list[float]]:
    """Very light 3x3 binomial smoothing to remove DEM stepping artifacts while preserving peaks."""
    h = len(grid)
    w = len(grid[0])
    cur = grid
    for _ in range(passes):
        nxt = [[0.0] * w for _ in range(h)]
        for j in range(h):
            jm = max(0, j - 1)
            jp = min(h - 1, j + 1)
            for i in range(w):
                im = max(0, i - 1)
                ip = min(w - 1, i + 1)
                val = (
                    cur[jm][im] + 2.0 * cur[jm][i] + cur[jm][ip]
                    + 2.0 * cur[j][im] + 4.0 * cur[j][i] + 2.0 * cur[j][ip]
                    + cur[jp][im] + 2.0 * cur[jp][i] + cur[jp][ip]
                ) / 16.0
                nxt[j][i] = val
        cur = nxt
    return cur


def trace_ski_run(
    grid: list[list[float]],
    start_x: int,
    start_z: int,
    dx_m: float,
    dz_m: float,
) -> tuple[float, float, float, float]:
    """
    Simulate following the downhill fall line from (start_x, start_z) to score
    how long, smooth, and dramatic a natural ski run is.
    Returns (vertical_drop, distance_m, avg_slope_deg, initial_yaw).
    """
    h = len(grid)
    w = len(grid[0])
    x = float(start_x)
    z = float(start_z)
    start_elev = grid[start_z][start_x]
    cur_elev = start_elev
    total_dist = 0.0
    slope_sum = 0.0
    steps = 0
    initial_yaw = 0.0

    vx, vz = 0.0, 0.0
    for step in range(260):
        ix = int(round(x))
        iz = int(round(z))
        if ix < 12 or ix >= w - 12 or iz < 12 or iz >= h - 12:
            break
        gx = (grid[iz][ix + 1] - grid[iz][ix - 1]) / (2.0 * dx_m)
        gz = (grid[iz + 1][ix] - grid[iz - 1][ix]) / (2.0 * dz_m)
        grad_mag = math.hypot(gx, gz)
        slope_deg = math.degrees(math.atan(grad_mag))

        # Stop if flat or impossibly vertical cliff right at start
        if step < 8 and (slope_deg < 12.0 or slope_deg > 42.0):
            return (0.0, 0.0, 0.0, 0.0)
        if grad_mag < 0.04:
            break

        # Downhill direction is (-gx, -gz)
        dir_x = -gx / grad_mag
        dir_z = -gz / grad_mag
        if step == 0:
            vx, vz = dir_x, dir_z
            initial_yaw = math.atan2(dir_x, -dir_z)
        else:
            vx = vx * 0.72 + dir_x * 0.28
            vz = vz * 0.72 + dir_z * 0.28
            vm = math.hypot(vx, vz) or 1.0
            vx /= vm
            vz /= vm

        step_cells = 1.25
        nx = x + vx * step_cells
        nz = z + vz * step_cells
        nix = int(round(nx))
        niz = int(round(nz))
        if nix < 10 or nix >= w - 10 or niz < 10 or niz >= h - 10:
            break
        next_elev = grid[niz][nix]
        if next_elev > cur_elev + 1.5:
            break

        total_dist += math.hypot((nx - x) * dx_m, (nz - z) * dz_m)
        cur_elev = next_elev
        slope_sum += slope_deg
        steps += 1
        x, z = nx, nz

    drop = start_elev - cur_elev
    avg_slope = slope_sum / max(steps, 1)
    return (drop, total_dist, avg_slope, initial_yaw)


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    out_dir = repo_root / "public" / "terrain"
    out_dir.mkdir(parents=True, exist_ok=True)

    # Center coordinates in fractional tile space at zoom 13
    # Shift slightly SE toward Vallée Blanche / Glacier du Géant so Aiguille du Midi,
    # Mont Blanc du Tacul, Vallée Blanche, and Mer de Glace all fit richly inside the 3x3 mosaic.
    cx_f, cy_f = latlon_to_tile_float(CENTER_LAT, CENTER_LON, ZOOM)
    cx_tile = int(math.floor(cx_f))
    cy_tile = int(math.floor(cy_f))

    # Fetch 3x3 tiles around (cx_tile, cy_tile) -> 768x768 covering ~10.2 km x 10.2 km
    tile_span = 3
    half = tile_span // 2
    mosaic = Image.new("RGB", (256 * tile_span, 256 * tile_span))

    x_min_tile = cx_tile - half
    y_min_tile = cy_tile - half

    for dy in range(tile_span):
        for dx in range(tile_span):
            tx = x_min_tile + dx
            ty = y_min_tile + dy
            tile_img = fetch_tile(ZOOM, tx, ty)
            mosaic.paste(tile_img, (dx * 256, dy * 256))

    # Crop a 640x640 window centered near (45.875, 6.900) so Aiguille du Midi (45.878, 6.887),
    # Vallée Blanche, Mont Blanc du Tacul, and Mer de Glace are centered in an ~8.5 km square.
    focus_lat = 45.878
    focus_lon = 6.900
    fx_f, fy_f = latlon_to_tile_float(focus_lat, focus_lon, ZOOM)
    focus_px = int(round((fx_f - x_min_tile) * 256))
    focus_py = int(round((fy_f - y_min_tile) * 256))

    crop_px = 640
    left = max(0, min(mosaic.width - crop_px, focus_px - crop_px // 2))
    top = max(0, min(mosaic.height - crop_px, focus_py - crop_px // 2))
    cropped = mosaic.crop((left, top, left + crop_px, top + crop_px))

    # Compute exact geographic bounds of cropped region
    tx0 = x_min_tile + left / 256.0
    ty0 = y_min_tile + top / 256.0
    tx1 = x_min_tile + (left + crop_px) / 256.0
    ty1 = y_min_tile + (top + crop_px) / 256.0

    north_lat, west_lon = tile_to_latlon(tx0, ty0, ZOOM)
    south_lat, east_lon = tile_to_latlon(tx1, ty1, ZOOM)
    mid_lat = 0.5 * (north_lat + south_lat)

    # Real-world meters across X (West->East) and Z (North->South)
    meters_per_deg_lat = 111132.92
    meters_per_deg_lon = 111412.84 * math.cos(math.radians(mid_lat))
    world_size_x = (east_lon - west_lon) * meters_per_deg_lon
    world_size_z = (north_lat - south_lat) * meters_per_deg_lat

    print(
        f"Bounds: N={north_lat:.5f} S={south_lat:.5f} W={west_lon:.5f} E={east_lon:.5f} "
        f"| World: {world_size_x:.1f}m x {world_size_z:.1f}m"
    )

    raw_elev = decode_terrarium_grid(cropped)
    elev_grid = resample_bilinear(raw_elev, GRID_SIZE, GRID_SIZE)
    elev_grid = light_gaussian_smooth(elev_grid, passes=1)

    min_elev = min(min(row) for row in elev_grid)
    max_elev = max(max(row) for row in elev_grid)
    print(f"Elevation range: {min_elev:.1f} m to {max_elev:.1f} m")

    dx_m = world_size_x / (GRID_SIZE - 1)
    dz_m = world_size_z / (GRID_SIZE - 1)

    # Locate Aiguille du Midi in grid coordinates
    def latlon_to_grid(lat: float, lon: float) -> tuple[float, float]:
        tx, ty = latlon_to_tile_float(lat, lon, ZOOM)
        u = (tx - tx0) / (tx1 - tx0)
        v = (ty - ty0) / (ty1 - ty0)
        return u * (GRID_SIZE - 1), v * (GRID_SIZE - 1)

    def grid_to_world(gx: float, gz: float) -> tuple[float, float]:
        wx = (gx / (GRID_SIZE - 1) - 0.5) * world_size_x
        wz = (gz / (GRID_SIZE - 1) - 0.5) * world_size_z
        return wx, wz

    # Search for an epic high-altitude summit drop-in point (>3400m) near Aiguille du Midi / Vallée Blanche
    # that yields a long, smooth, exhilarating downhill freeride run.
    best_score = -1.0
    best_spawn = None

    midi_gx, midi_gz = latlon_to_grid(CENTER_LAT, CENTER_LON)
    print(f"Aiguille du Midi (45.878, 6.887) grid pos: ({midi_gx:.1f}, {midi_gz:.1f})")

    for gz in range(64, GRID_SIZE - 64, 6):
        for gx in range(64, GRID_SIZE - 64, 6):
            elev = elev_grid[gz][gx]
            if elev < 3300.0 or elev > 3950.0:
                continue
            # Prefer candidates within ~1.8 km of Aiguille du Midi / upper Vallée Blanche
            dist_to_midi = math.hypot((gx - midi_gx) * dx_m, (gz - midi_gz) * dz_m)
            if dist_to_midi > 2400.0:
                continue
            drop, run_dist, avg_slope, yaw = trace_ski_run(elev_grid, gx, gz, dx_m, dz_m)
            if drop < 700.0 or run_dist < 1800.0:
                continue
            # Ideal freeride average slope around 18-30 deg, huge vertical drop & distance
            slope_bonus = max(0.0, 1.0 - abs(avg_slope - 24.0) / 18.0)
            proximity_bonus = max(0.0, 1.0 - dist_to_midi / 2800.0)
            score = drop * 1.4 + run_dist * 0.35 + slope_bonus * 450.0 + proximity_bonus * 350.0
            if score > best_score:
                best_score = score
                best_spawn = (gx, gz, elev, drop, run_dist, avg_slope, yaw)

    if best_spawn is None:
        # Fallback near Aiguille du Midi ridge
        gx, gz = int(midi_gx), int(midi_gz)
        best_spawn = (gx, gz, elev_grid[gz][gx], 1000.0, 2500.0, 22.0, 0.8)

    sgx, sgz, selev, sdrop, sdist, sslope, syaw = best_spawn
    swx, swz = grid_to_world(sgx, sgz)
    print(
        f"Selected optimal summit drop-in: grid=({sgx},{sgz}) world=({swx:.1f}, {swz:.1f}) "
        f"elev={selev:.1f}m | run drop={sdrop:.0f}m dist={sdist:.0f}m avgSlope={sslope:.1f}deg yaw={math.degrees(syaw):.1f}deg"
    )

    # Save 16-bit little-endian uint16 binary heightmap
    elev_span = max(max_elev - min_elev, 1.0)
    bin_path = out_dir / "chamonix-heightmap.bin"
    buf = bytearray(GRID_SIZE * GRID_SIZE * 2)
    idx = 0
    for j in range(GRID_SIZE):
        row = elev_grid[j]
        for i in range(GRID_SIZE):
            norm = (row[i] - min_elev) / elev_span
            q = max(0, min(65535, int(round(norm * 65535.0))))
            struct.pack_into("<H", buf, idx, q)
            idx += 2

    bin_path.write_bytes(buf)

    # Collect landmarks inside bounds
    resolved_landmarks = []
    for lm in LANDMARKS:
        lgx, lgz = latlon_to_grid(lm["lat"], lm["lon"])
        if 4 <= lgx <= GRID_SIZE - 5 and 4 <= lgz <= GRID_SIZE - 5:
            lwx, lwz = grid_to_world(lgx, lgz)
            lelev = elev_grid[int(round(lgz))][int(round(lgx))]
            resolved_landmarks.append({
                "name": lm["name"],
                "x": round(lwx, 1),
                "z": round(lwz, 1),
                "elevation": round(lelev, 1),
                "lat": lm["lat"],
                "lon": lm["lon"],
            })

    meta = {
        "name": "Mont Blanc / Vallée Blanche, Chamonix",
        "source": "AWS Open Elevation Tiles (Terrarium DEM / EU-DEM)",
        "width": GRID_SIZE,
        "height": GRID_SIZE,
        "worldSizeX": round(world_size_x, 2),
        "worldSizeZ": round(world_size_z, 2),
        "minElev": round(min_elev, 2),
        "maxElev": round(max_elev, 2),
        "centerLat": CENTER_LAT,
        "centerLon": CENTER_LON,
        "bounds": {
            "north": round(north_lat, 6),
            "south": round(south_lat, 6),
            "west": round(west_lon, 6),
            "east": round(east_lon, 6),
        },
        "spawn": {
            "x": round(swx, 2),
            "z": round(swz, 2),
            "elevation": round(selev, 1),
            "yaw": round(syaw, 4),
        },
        "landmarks": resolved_landmarks,
    }

    meta_path = out_dir / "chamonix-meta.json"
    meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"Saved {bin_path} ({len(buf):,} bytes) and {meta_path}")


if __name__ == "__main__":
    main()
