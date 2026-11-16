# Mono-StickFigure

English | [简体中文](README.zh.md)

A tiny stick figure that turns your webpage into a playground.

A framework-independent TypeScript toolkit with no runtime dependencies. The figure finds painted DOM surfaces, walks and jumps between reachable targets, follows scrolling platforms, and falls when its support disappears. Its small Canvas does not block clicks, text selection, or scrolling.

## Try the preview

Use Node.js `^22.18.0 || ^24.11.0 || >=26.0.0` and npm:

```sh
npm ci
npm run build
npm run dev
```

Open [the playground](http://127.0.0.1:5173/examples/). Use [manual mode](http://127.0.0.1:5173/examples/?mode=manual) to inspect actions without autonomous decisions.

The example imports `dist/index.mjs`. After editing library code, rebuild it or run `npm run build:watch` in another terminal. The dev server uses a fixed port and does not switch ports if 5173 is occupied.

Version 0.1.0 remains an early preview, not the complete planned first release. Run `npm pack` in the repository root to create a tarball, then install it with `npm install ./mono-stickfigure-0.1.0.tgz`. Once 0.1.0 is published to the public npm registry, install it with `npm install mono-stickfigure@0.1.0`.

## What works today

- Visible solid horizontal borders (top first, bottom as a fallback) and distinguishable solid-color fills, including borderless buttons.
- Bounded, resumable hit-test discovery prioritizes unseen nearby DOM candidates and caret-adjacent words in long paragraphs. Discovery, global scanning and refresh share the existing perception budget; nearby surfaces receive cache-capacity priority. This requires neither per-frame whole-document rescanning nor site-specific selectors.
- Ordinary text ink-top estimates and local top-contour approximations for large, horizontal, left-to-right text.
- A single-color, side-facing figure, 16 CSS px tall by default.
- Walking, running, sprinting, turning, greeting, crouching, resting, lying down, and standing up.
- Gravity-driven jumps, run-jumps, running long jumps, falls, landing recovery, and rolling after sufficiently hard landings when there is room.
- Element, surface, or page-coordinate movement targets; cancellable requests and bounded route planning.
- Platform-relative contact through scrolling and supported translations, dynamic support invalidation, pause/resume, and resource cleanup.

The core takes no page screenshots, performs no network recognition, and uploads no page content. Large-text approximation redraws glyphs locally; it is not a screenshot of the page. The example itself loads web fonts.

## Basic use

Start after the document and your target elements are mounted. `#runway` must have an actual, visible, sufficiently wide border, fill, or text surface.

```ts
import { createStickFigure } from 'mono-stickfigure';

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

The 16 requestable actions are:

```text
idle, walk, run, sprint, turn,
wave, crouch, rest, prone, stand-up,
jump, run-jump, running-long-jump, fall, land-soft, roll
```

`anticipate` and `brake` are internal transition states visible in snapshots/events, not requestable actions. Reverse jumps brake and turn before takeoff. A target jump requests one jump, possibly with a run-up; use `moveTo()` for multi-step routes.

`duration` is in seconds and applies to timed movement/pose phases, not the total Promise duration. It must be 0.1–10, or 0.65–10 for rolling. Jump/fall completion depends on physics. Transitions and landing recovery add time; run-jump/long-jump may resume movement after completion.

Events are `ready`, `statechange`, `actionchange`, `surfacechange`, `targetchange`, `boundary`, and `error`:

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

Creation defaults include gravity `980` CSS px/s², jump height `52` CSS px, scan budget `2` ms, at most `1500` surfaces, DPR cap `2`, autonomous decisions enabled, and reduced-motion preferences respected. Change appearance/physics/recognition by destroying and creating an instance; there is no runtime setter yet.

## Boundaries

- Color evidence compares locally reconstructed composited colors in OKLab, with `colorTolerance: 0.01` by default. Same-colored foreground/background does not establish a surface; unsupported compositing can remain unknown.
- Borders/text are one-way top supports. Fills additionally provide conservative solid bounds for side and head collisions. Rolling still uses full-height collision clearance.
- Text estimates are not exact page pixels. Image interiors, arbitrary SVG paths, filters, masks, and complex clipping are not automatically recognized.
- Navigation is bounded Dijkstra over known candidates, not A* or an exhaustive whole-page search. Targets can be unreachable, and a platform moving after takeoff is not guaranteed to be hit.
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
