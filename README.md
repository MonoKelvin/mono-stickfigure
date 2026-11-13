# Mono-StickFigure

English | [简体中文](README.zh.md)

A tiny stick figure that turns your webpage into a playground.

It finds real page elements to stand on, follows them as the page scrolls or they move, and falls naturally when its platform disappears. Your page stays interactive. Buttons still click, and scrolling still works.

## Try the preview

```sh
npm install
npm run build
npm run dev
```

Open [the playground](http://127.0.0.1:5173/examples/), make the figure jump, move its platform, or hide the ground beneath it.

## What works today

- Standing on visible, solid element borders.
- Following page scrolling and moving platforms.
- Jumping, falling, and landing with a small, drawn-on-the-fly figure.
- Configurable size, color, line width, and head shape.
- Pausing, resuming, and removing the figure without blocking the page.

Everything runs locally. The core takes no screenshots and uploads no page content.

This is an early preview, not the complete release. Text platforms, the full set of actions and triggers, and adapters for complex drawings are still being built. The package is not yet published to npm.

## License

[MIT](LICENSE) © 2026 MonoKelvin
