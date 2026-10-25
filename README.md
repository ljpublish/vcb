# Voxel City Builder

A 3D voxel city builder that runs in your browser. Lay roads, zone land, and watch a blocky city grow on procedurally generated terrain.

**Play now: https://ljpublish.github.io/vcb/**

> The game is in active development. The live build updates automatically every time `main` changes, so some features may be missing or rough.

Works best in a recent desktop Chrome, Edge, or Firefox with WebGL 2. A mouse with a scroll wheel is recommended; trackpads work too.

## How to play

1. **Build roads.** Pick the Road tool (`2`) and left-drag across the map. Buildings only grow next to roads.
2. **Zone land.** Drag out Residential (`3`), Commercial (`4`), and Industrial (`5`) zones along your roads.
   - Residential brings people. People need jobs.
   - Commercial and Industrial provide jobs. Industry is noisy and polluting, so keep it away from homes.
3. **Let it grow.** Construction starts on zoned tiles near roads. As demand rises, buildings level up into bigger ones.
4. **Balance the budget.** Everything costs money. Taxes bring it in. Open the Budget panel from the top bar to adjust tax rates and see your history.
5. **Make it nice.** Parks (`6`) make nearby homes more desirable. Use Bulldoze (`7`) to fix mistakes.

Press `H` in game for the full help screen. Your city can be saved in the browser (`F5` to quick save, `F9` to quick load) or exported to a file from the Save menu.

## Controls

### Mouse

| Action | Input |
| --- | --- |
| Use the current tool | Left click / left drag |
| Orbit the camera | Right drag |
| Pan the camera | Middle drag, or Shift + right drag (left drag also pans with the Select tool) |
| Zoom toward the cursor | Scroll wheel (trackpad: pinch) |
| Cancel a drag | Right click while dragging, or `Esc` |

### Keyboard

| Action | Keys |
| --- | --- |
| Pan | `W` `A` `S` `D` or arrow keys |
| Rotate | `Q` / `E` |
| Tilt | `R` / `F` |
| Zoom | `Z` / `X` or `Page Up` / `Page Down` |
| Reset camera | `Home` |
| Tools: Select, Road, Residential, Commercial, Industrial, Park, Bulldoze | `1` to `7` (Bulldoze also `B` or `Delete`) |
| Straight road while dragging | Hold `Shift` |
| Back to Select / cancel | `Esc` |
| Pause / resume | `Space` |
| Slower / faster | `[` / `]` (or `-` / `=`) |
| Quick save / quick load | `F5` / `F9` |
| Toggle grid | `G` |
| Cycle map overlays | `O` |
| Help | `H` or `F1` |
| Debug stats | `` ` `` or `F3` |

## Run it locally

You need [Node.js](https://nodejs.org/) 22 or newer.

```bash
git clone https://github.com/ljpublish/vcb.git
cd vcb
npm install
npm run dev
```

Then open the URL it prints (usually http://127.0.0.1:5173).

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run build` | Typecheck and build a production bundle into `dist/` |
| `npm run preview` | Serve the built `dist/` locally |
| `npm run typecheck` | Typecheck only |

## Deployment

Every push to `main` runs `.github/workflows/deploy.yml`, which builds the game with the `/vcb/` base path and publishes it to GitHub Pages. You can also run it by hand from the Actions tab ("Deploy to GitHub Pages" > Run workflow).

To reproduce the Pages build locally:

```bash
npm run build -- --base=/vcb/
npx vite preview --base=/vcb/
# open http://127.0.0.1:4173/vcb/
```

## Built with

TypeScript, [Three.js](https://threejs.org/), and [Vite](https://vitejs.dev/). See [ARCHITECTURE.md](ARCHITECTURE.md) for how the code is organised.
