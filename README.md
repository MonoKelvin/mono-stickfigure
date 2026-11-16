# Mono-StickFigure

English | [简体中文](README.zh.md)

A tiny stick figure that turns your webpage into a playground.

A framework-independent TypeScript toolkit with no runtime dependencies. The figure finds painted DOM surfaces, walks and jumps between reachable targets, follows scrolling platforms, and falls when its support disappears. Its small Canvas does not block clicks, text selection, or scrolling.

## Try locally

Use Node.js `^22.18.0 || ^24.11.0 || >=26.0.0` and npm:

```sh
npm ci
npm run build
npm run dev
```

Open [the playground](http://127.0.0.1:5173/examples/). Use [manual mode](http://127.0.0.1:5173/examples/?mode=manual) to inspect actions without autonomous decisions.

The example imports `dist/index.mjs`. After editing library code, rebuild it or run `npm run build:watch` in another terminal. The dev server uses a fixed port and does not switch ports if 5173 is occupied.

The version is maintained in [package.json](package.json); the exported `VERSION` and example display reference that field. Run `npm pack --json` and install the local tarball named by its `filename`. Query `npm view mono-stickfigure version` for the actual public-registry release, then use `npm install mono-stickfigure`; the local version does not establish publication.

## What works today

- Visible solid horizontal borders (top first, bottom as a fallback) and distinguishable solid-color fills, including borderless buttons.
- Bounded, resumable hit-test discovery prioritizes unseen nearby DOM candidates and caret-adjacent words in long paragraphs. Discovery, global scanning and refresh share the existing perception budget; nearby surfaces receive cache-capacity priority. This requires neither per-frame whole-document rescanning nor site-specific selectors.
- Ordinary text ink-top estimates and local top-contour approximations for large, horizontal, left-to-right text.
- A single-color, side-facing figure, 16 CSS px tall by default.
- Walking, running, sprinting, turning, greeting, crouching, resting, lying down, standing up, sitting with hands behind the body, wondering with one hand rubbing the head, and running in place.
- Gravity-driven jumps, run-jumps, running long jumps, falls, landing recovery, and immediate shoulder/back rolling after high landings when there is room.
- Climbing real vertical edges and long steep edges above 80°: reach with both hands in flight, settle the grip and place the feet in sequence, then climb slowly while retaining three contact points, with jumps back to real platforms.
- Element, surface, or page-coordinate movement targets; cancellable requests and bounded route planning.
- Platform-relative contact through scrolling and supported translations, dynamic support invalidation, pause/resume, and resource cleanup.

The core takes no page screenshots, performs no network recognition, and uploads no page content. Large-text approximation redraws glyphs locally; it is not a screenshot of the page. The example itself loads web fonts.

## Basic use

Start after the document and your target elements are mounted. `#runway` must have an actual, visible, sufficiently wide border, fill, or text surface.

```ts
import { createStickFigure, VERSION } from 'mono-stickfigure';

console.log(VERSION);

const figure = createStickFigure({
  autonomous: false,
  appearance: { height: 16, color: '#181818', lineWidth: 1.2 },
  recognition: { colorTolerance: 0.01 },
});

await document.fonts.ready;
const started = await figure.start();
const runway = document.querySelector<HTMLElement>('#runway');

if (started.status !== 'paused' && runway) {
  const placed = await figure.place(runway);
  if (placed.status === 'placed') {
    const result = await figure.requestAction('run-jump', { direction: 1 });
    console.log(result);
  }
}
```

`place()` explicitly repositions the figure after measuring the target. Use `moveTo()` for physical travel, not repeated `place()` calls.

## Targets and cancellation

```ts
const destination = document.querySelector<HTMLElement>('#destination');
const controller = new AbortController();

if (destination) {
  const moving = figure.moveTo(destination, {
    pace: 'run',
    signal: controller.signal,
  });
  const cancelButton = document.querySelector<HTMLButtonElement>('#cancel');
  const cancel = () => controller.abort();
  cancelButton?.addEventListener('click', cancel, { once: true });
  const result = await moving;
  cancelButton?.removeEventListener('click', cancel);
  console.log(result);
}
```

For an already discovered platform, pass `{ surfaceId, u }`; `u` is a normalized position along its top line. Surface IDs belong to one instance and are not persistent element IDs.

For page coordinates:

```ts
const result = await figure.moveTo(
  { position: { x: 640, y: 900 }, coordinateSpace: 'document' },
  { pace: 'walk' },
);
```

Coordinate targets select a nearby standing point on a known valid surface; they never create ground. Omitted `coordinateSpace` means client/viewport CSS pixels. `pace` controls travel along a platform; crossing a gap may still require a faster run-up.

Cancellation returns `interrupted / aborted`. It does not freeze or teleport an airborne figure; physics continues until contact. Grounded movement brakes, and a roll recovers from its current pose. `autonomous: false` only disables automatic decisions, not the follow-up running phase of a run-jump; request `idle` after landing to settle to a stop.

## Public API

| Method | Behavior |
| --- | --- |
| `start()` | Returns `ready`, `empty`, or `paused` plus `supportedActions`; repeated calls reuse the startup Promise. |
| `place(target)` | Returns `placed` or `rejected`; a valid placement cancels existing requests. Works while user-paused without resuming it. |
| `moveTo(target, { pace, signal }?)` | Plans physical travel; `pace` is `walk`, `run`, or `sprint`. |
| `requestAction(id, { target, direction, duration, signal }?)` | Requests a supported action; direction is `1` (right) or `-1` (left). |
| `setAutonomous(enabled)` | Enables/disables automatic decisions, without stopping airborne physics. |
| `pause()` / `resume()` | Adds/removes the user pause reason; other pause reasons remain independent. |
| `on(event, listener)` | Returns an unsubscribe function. |
| `getSnapshot()` | Returns value copies of state; `surfaces` is populated only with `debug: true`. |
| `destroy()` | Idempotently releases resources and interrupts requests; create a new instance to restart. |

Movement/action results are `{ status: 'completed' | 'rejected' | 'interrupted', reason?: string }`. Check the result instead of assuming a resolved Promise means success. Reasons include `unreachable`, `target-invalid`, `support-invalid`, `insufficient-space`, `obstructed`, `edge`, `boundary`, `replaced`, and `aborted`. Invalid creation options throw; `start()` can reject when the browser or mount is unavailable.

The 20 requestable actions are:

```text
idle, walk, run, sprint, turn,
wave, crouch, rest, prone, stand-up,
jump, run-jump, running-long-jump, fall, land-soft, roll,
sit, question, run-in-place, climb
```

`anticipate` and `brake` are internal transition states visible in snapshots/events, not requestable actions. Reverse jumps brake and turn before takeoff. A target jump requests one jump, possibly with a run-up; use `moveTo()` for multi-step routes.

`duration` is in seconds and applies to timed movement/pose phases, not the total Promise duration. It must be 0.1–10, or 0.65–10 for rolling. Jump/fall completion depends on physics. Transitions and landing recovery add time; run-jump/long-jump may resume movement after completion.

Events are `ready`, `statechange`, `actionchange`, `surfacechange`, `targetchange`, `navigationchange`, `boundary`, and `error`:

```ts
const unsubscribe = figure.on('actionchange', ({ action }) => {
  console.log(action);
});

figure.setAutonomous(true);
figure.pause();
figure.resume();
unsubscribe();
figure.destroy();
```

## Gravity, climbing and autonomous goals

`physics.gravity` is actual acceleration in m/s², defaults to `9.8`, and accepts any finite value from `4` to `20` without tiers, quantization or silent clamping. Internally, a fixed `100 CSS px/m` conversion keeps gravity independent of figure size; `jumpHeight` remains in CSS px. `maxFallSpeed` is a finite positive value in CSS px/s, defaulting to `600` independently of figure size.

```ts
const tunedFigure = createStickFigure({
  physics: { gravity: 12.255, jumpHeight: 52, maxFallSpeed: 600 },
  performance: { navigationBudgetMs: 1, scanBudgetMs: 2 },
});
tunedFigure.destroy();
```

Here, `g` is the converted internal acceleration in CSS px/s². Without horizontal forces, flight follows `x = x0 + vx × t` and `y = y0 + vy0 × t + ½g × t²`: constant horizontal speed plus vertical acceleration produces a parabola, not constant overall speed. Very long descents switch to piecewise terminal-speed integration. Planning and runtime use the same model; the capped segment is not an infinite parabola.

`requestAction('climb', { target, signal })` accepts a real steep-edge element or `{ surfaceId, u }`; once attached, it completes the climb on that edge rather than hopping back to a platform as a shortcut. After grabbing, it settles for about 0.65 seconds and climbs at no more than 0.4 figure heights per second; `pace` does not accelerate climbing into running. Without a target it only tries nearby valid edges. `moveTo()` can combine grabbing, climbing and jumping away. `place()` still only explicitly positions the figure on horizontal support. Snapshots distinguish `climb` from `support`. Stopping or cancelling climbing retains valid contact, while an invalid edge releases it into a fall. Airborne cancellation does not freeze velocity.

Autonomy chooses a random destination on a known, visible, usable surface interval before planning a route in frame slices. Arrival immediately selects another destination, optionally followed by a short rest or local wandering. Low-probability mid-trip changes never instantly redirect flight. Unreachable goals allow bounded exploration, throttled replanning and reselection rather than invented ground or per-frame whole-page search.

Snapshot `navigation` records the goal ID, straight-line distance, planning state/reason, cumulative planning time, candidate/expanded/checked-edge counts and replans. A bounded `history` is returned only in debug mode; `navigationchange` reports decision changes, not every frame. Neither records DOM references nor page content. The example displays these values every 250 ms.

Creation defaults include gravity `9.8` m/s², jump height `52` CSS px, scan budget `2` ms, navigation budget `1` ms, at most `1500` surfaces, DPR cap `2`, autonomous decisions enabled, and reduced-motion preferences respected. Change appearance/physics/recognition by destroying and creating an instance; there is no runtime setter yet.

## Boundaries

- Color evidence compares locally reconstructed composited colors in OKLab, with `colorTolerance: 0.01` by default. Same-colored foreground/background does not establish a surface; unsupported compositing can remain unknown.
- Horizontal borders/text are one-way top supports. Fills additionally provide conservative solid bounds for side and head collisions. Rolling still uses full-height collision clearance.
- Text estimates are not exact page pixels. Image interiors, arbitrary SVG paths, filters, masks, and complex clipping are not automatically recognized.
- Steep-edge recognition is limited to real HTML solid borders, distinguishable solid-fill sides, and reliably reconstructed simple self-rotated 2D solid borders. Angles must be strictly above 80°, with a usable segment at least twice the figure height. Complex ancestor transforms, 3D/perspective, masks and clip paths remain unsupported or unknown. A rotated bounding rectangle is not a real slope or solid body.
- Climbing exits require a reachable real platform. Validated jumps can reach a ledge or an outside platform; pulling over a bare wall without an outside ledge is not implemented.
- Navigation is bounded Dijkstra over known candidates, not A* or an exhaustive whole-page search. `navigationBudgetMs` is a per-frame soft search budget; a non-preemptible operation can exceed it. Exhausting a slice means pending, not unreachable. Targets can be unreachable, and a platform moving after takeoff is not guaranteed to be hit.
- Scroll-induced offscreen support keeps its anchor and hides/pauses the figure. Unknown support waits for verification; removed or invisible support releases contact.
- Default boundary wrapping interrupts the current request when airborne motion exits the sides or falls below the viewport. Upward jumps do not wrap to the bottom. Disabling wrapping waits offscreen rather than inventing a floor.
- Imports and instance creation are SSR-safe; only `start()` needs a browser. `/core` currently creates the same controller as the default entry.
- Provider/action/trigger registration, automatic Shadow DOM traversal, SVG surface extraction, and `/presets` are not implemented. An explicit `ShadowRoot` scan root is supported. The planned 24 actions, 20 trigger types, and complete five-scenario acceptance are still first-release goals.

## Development and documentation

```sh
npm run typecheck
npm test -- tests/unit/motion.test.ts
npm run test:browser
```

Type checking includes library, example, tests, and root configuration. Browser checks consume a prior build and use locally installed Microsoft Edge. Existing tests are not proof that every new preview behavior is covered.

See [the current API and design boundaries](docs/02-详细设计.md#11-公共-api-与扩展契约), [implementation and verification records](docs/03-实施与验收计划.md), and [development architecture](CLAUDE.md). The design documents distinguish current APIs from planned extension contracts; simulated phone dimensions and small rendering samples are not real-device or complete performance acceptance.

## License

[MIT](LICENSE) © 2026 MonoKelvin
