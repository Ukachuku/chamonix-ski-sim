# Chamonix — Vallée Blanche Freeride Ski Simulator

A playable first-person WebGL2 freeride ski simulator modeled on real **Mont Blanc / Chamonix Vallée Blanche** elevation data (`45.878° N, 6.887° E`), built with TypeScript, Vite, raw WebGL2 shaders, and procedural Web Audio synthesis.

## Features

- **Real Chamonix / Mont Blanc Terrain (`public/terrain/`)**:
  - Generated directly from open AWS Terrarium elevation tiles (EU-DEM) via [`scripts/fetch_terrain.py`](scripts/fetch_terrain.py) into a compact 16-bit binary heightmap (`512 × 512`, `524 KB`) + metadata JSON so the app loads instantly in any browser with zero external API keys.
  - Covers an `8.5 km × 8.5 km` massif spanning `1,001 m` (Chamonix valley) to `4,414 m` (Mont Blanc du Tacul ridge), dropping in from the Aiguille du Midi shoulder (`3,671 m`).
- **Custom WebGL2 Alpine Shaders**:
  - Pre-baked GPU raymarched mountain shadows, sky ambient occlusion, and ridge curvature (`ShadowBaker.ts`).
  - Procedural wind-carved snow sastrugi, pinpoint snow crystal sparkles, exposed Chamonix Protogine granite cliffs on steep faces, glacial blue-ice accents, Rayleigh/Mie alpine sky dome, and aerial perspective valley haze.
  - Real-time carved twin ski tracks laid onto the snow behind the player and two-layer blowing alpine snow + dynamic carve/hockey-stop powder spray particles.
- **First-Person View & Ski Physics**:
  - Slope-projected gravity acceleration over smooth Catmull-Rom bicubic terrain normals, responsive carving turns, speed-scrubbing hockey stops, aero tuck, and ridge jumps with ballistic flight and landing compression.
  - Procedural 3D pair of rockered freeride skis at the bottom of the screen that tilt onto their brushed-steel edges when carving and pivot sideways during hockey stops, paired with camera turn banking, speed-responsive FOV, and terrain vibration.
  - Clean translucent alpine HUD displaying speed (`km/h`), elevation (`m`), slope angle (`°`), compass heading, and vertical drop.
- **Procedural Web Audio Synthesizer**:
  - Real-time speed- and turn-modulated alpine wind rush, snow carving hiss, gritty hockey-stop edge scrape, and powder landing thump — with a HUD mute toggle (`M`).

## Controls

| Key | Action |
| --- | --- |
| `A` / `D` or `←` / `→` | Carve turns & tilt skis onto edges |
| `S` or `↓` | Hockey stop (scrub speed & throw powder spray) |
| `W` or `↑` | Aero tuck (lower stance & reduce drag) |
| `Space` | Jump off alpine ridges |
| `R` | Reset to Aiguille du Midi summit (`3,671 m`) |
| `M` | Toggle audio mute |

## Development & Build

```bash
npm install
npm run dev      # Start local Vite dev server
npm run build    # Type-check and build static bundle to dist/ (base: './' for GitHub Pages)
npm run preview  # Preview production static build locally
```

To regenerate the preprocessed terrain heightmap from AWS Terrarium tiles:

```bash
python3 scripts/fetch_terrain.py
```