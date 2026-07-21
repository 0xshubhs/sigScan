# 0xTools Brand & Logo System

v1.0 · Jul 2026. Master files generated from the design doc (`0xTools Logo System.dc.html`).
Flat SVG throughout — no gradients, no shadows, light + dark.

## The mark — Direction B, "Selector Strip"

A 4-byte selector as a row of bytes; the lit cell is the one under inspection.
Construction: 24-unit grid, 2 px safe area, four cells 3.4×11 (rx 1.1) at
x = 2.65 / 7.75 / 12.85 / 17.95, y 6.5, stroke 1.7. Second cell lit.

## Color

| Token       | Hex       | Use                          |
| ----------- | --------- | ---------------------------- |
| Ink         | `#0B0E11` | primary on light             |
| Paper       | `#F4F4F1` | background / primary on dark |
| Accent      | `#14C08A` | the lit byte, links, CTAs    |
| Accent deep | `#0F9D72` | hover / small accent text    |
| Dark        | `#0C0F12` | dark surfaces                |
| Panel       | `#17191E` | dark UI panels               |
| Line        | `#E6E5E0` | hairlines on light           |
| Muted       | `#8A8F96` | secondary text               |

Alt accents from the system: `#2BD4A8`, `#3DA9FC` (blue), `#F5A524` (amber).

## Type

- `0x` prefix: **IBM Plex Mono Medium** (dotted zero — reads as a literal hex prefix)
- `Tools`: **Space Grotesk Medium**
- Matching cap heights (700 vs 698 units) — both faces sit on one baseline, no nudging.
- Differentiation is by typeface, not color, so the wordmark survives in one ink.

## Files (`svg/`)

| File                                  | Purpose                                  |
| ------------------------------------- | ---------------------------------------- |
| `0xtools-icon.svg`                    | mark · color / light                     |
| `0xtools-icon-mono.svg`               | mark · single ink (ships to activity bar)|
| `0xtools-icon-inverse.svg`            | mark · color / dark                      |
| `0xtools-icon-mono-inverse.svg`       | mark · mono / dark                       |
| `0xtools-wordmark.svg`                | wordmark · ink (type outlined)           |
| `0xtools-wordmark-paper.svg`          | wordmark · paper                         |
| `0xtools-lockup-horizontal(-inverse)` | gap = 0.4 × mark height · min 132 px     |
| `0xtools-lockup-stacked(-inverse)`    | gap = 0.3 × mark height · square spaces  |
| `0xtools-app-tile.svg`                | dark tile + inverse mark → `icon.png`    |
| `0xtools-explore-{a,b,c}-*.svg`       | the three explored directions            |

## Raster exports (`png/`)

The SVGs are the masters (scale to any size). `png/` carries pre-rendered
exports for places that demand fixed rasters — GitHub avatars, marketplace
tiles, socials:

- `0xtools-tile-{16,32,48,64,128,256,512}.png` — dark app tile (avatar/store use)
- `0xtools-mark-{16,32,48,64,128,256,512}.png` — bare strip on transparent
- `0xtools-lockup-1024.png` — horizontal lockup for banners/og images

Regenerate with `inkscape brand/svg/<file>.svg -w <size> -h <size> -o <out>.png`.

## Rules

- Clear space = ¼ of icon height on every side.
- Minimums: wordmark 96 px wide · horizontal lockup 132 px · icon 16 px (monochrome only).
- At 16 px (VS Code activity bar) always use the mono variants.
