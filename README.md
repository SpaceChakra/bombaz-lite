# BOMBAZ (Lite Edition)

Drop bombs, climb a collapsing tower and outrun the Void. The tower behind you is being deleted, and the only way through each Gate is to bomb every glowing core on it.

**This is the Lite Edition**, an earlier build of BOMBAZ with full TypeScript source. It's a complete game: solo, a local daily seed, 2-player co-op and versus, a chassis bay and power-ups. The current full game adds more on top (see below).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/, drop it on itch.io / GitHub Pages
```

## Controls

One movement input and **one button**. That's the whole control design.

| | Move | Action (bomb / tool) | Pause |
|---|---|---|---|
| Gamepad | Stick / D-pad | Any face button | Start |
| Keyboard P1 | `WASD` / arrows | `Space` | `Esc` |
| Keyboard P2 | `IJKL` | `Right Shift` | `Esc` |
| Touch | left half steers | right half | — |

## How it plays

1. **Climb.** The Void eats the tower behind you. Up is the only direction that exists.
2. **Bomb.** Blast bricks for power-ups and take out patrolling enemies.
3. **Cores.** Every Gate wall has glowing reactor cores. The wall holds until the last one goes down.
4. **Break through.** Clear a Gate and the wall detonates and shoves the Void back down.

Power-ups include Kick, Slide and Lift (move, slide and throw bombs), Pierce, Freeze, Shield, Magnet and more.

## Architecture (a good TypeScript game codebase to study)

```
src/
  core/      rng.ts (seeded, deterministic) · loop.ts (fixed-timestep loop) · audio.ts (synthesized)
  input/     input.ts: one abstraction over gamepad / keyboard / touch
  game/      constants · types · world · entities · game   (pure simulation)
  render/    palette · fx · renderer   (all presentation, zero simulation)
  ui/        screens.ts: DOM menus with one navigation model for stick, keys and touch
```

- The simulation is **deterministic**: seeded RNG and a fixed timestep, with no rendering or wall-clock time in the sim. That's what makes daily seeds and replays possible.
- **Rendering never writes simulation state**, so visuals can change without changing how the game plays.

## What the full game adds

Fire Walk and the BOMBAZ streak system, verified online leaderboards and daily boards, the synthesized FM soundtrack that reacts to the climb, cosmetics, an interactive tutorial coach, split-screen that follows each runner, and a lot of tuning and polish. Play it free on [itch.io](https://spacechakra.itch.io). The **full source** is on [Patreon](https://patreon.com/spacechakra).

## License

Code: MIT (see [LICENSE](LICENSE)). The name "BOMBAZ", its logo and the SpaceChakra brand aren't covered, so please give your remix its own name. Fonts are loaded from Google Fonts under their own licenses.

Made by [SpaceChakra](https://patreon.com/spacechakra)
