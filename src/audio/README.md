# src/audio — procedural sound

One AudioContext for the whole game. No asset files: every sound is synthesized with Web Audio
oscillators, noise buffers, filters and envelopes.

| File | What |
| --- | --- |
| `index.ts` | Public API: `getAudio()` singleton, `SfxName`, `AudioState` |
| `audioSystem.ts` | Context + bus graph (sfx / ambient / music → master → compressor), unlock, mute (M), prefs, bus wiring |
| `sfx.ts` | One-shots: click, hover, toggle, build, zone, park, bulldoze, error, coin, milestone, save (rate limited) |
| `ambience.ts` | City hum + traffic whooshes that grow with population; wind + birds that fade as the city grows |
| `music.ts` | Seeded generative music (per city): pad → bass → arp → hats → kick as population grows; minor when happiness is low |
| `synth.ts` | Shared helpers (noise buffers, envelopes, tone / noise voices) |

## Integration (integrator, `src/game.ts`)

One import and one line, right after the bus is created and before the first city starts:

```ts
import { getAudio } from './audio';
// ...
getAudio().attach(this.bus);   // in dispose(): disposeAudio()
```

That's all. No per-frame `update()` is needed (audio runs on its own 25 ms lookahead timer).

## Bus events used

| Event | Sound |
| --- | --- |
| `action:applied` ok | build (road) / zone / park / bulldoze, scaled a little by tiles applied |
| `action:applied` !ok | error |
| `sim:month` net > 0 | coin |
| `notify` success | milestone |
| `save:written` (manual) | save |
| `tool:changed` | toggle |
| `stats:changed` | ambience levels + music intensity (population), mood (happiness) |
| `sim:speed` 0 | quieter traffic / hum |
| `city:loaded` | reseed + fade in music and ambience |
| `ui:modal` | ducks music and ambience while a dialog is open |

## UI contract

`src/ui/sfx.ts` forwards to `getAudio()` and only plays UI clicks (`playSfx('click')`); it must not
map bus events itself, or sounds play twice. The UI persists master volume + mute in its settings
(`SETTINGS_KEY`) and calls `setMasterVolume` / `setMuted`; it listens to `onChange` to stay in sync
with the M hotkey. Sub-volumes (music / ambient / sfx) and `musicEnabled` persist under `vcb:audio`.

All methods are safe before the first user gesture and in browsers without Web Audio.
