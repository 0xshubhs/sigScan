# 0xTools landing page

Neo-brutalist landing site for the 0xTools VS Code extension, built on the
brand system in `../brand/` (Selector Strip mark, paper/ink/accent palette,
Space Grotesk + IBM Plex Mono).

- `npm run dev` — local dev
- `npm run build` — static production build (every route prerenders)

The downloadable VSIX lives at `public/downloads/0xtools-<version>.vsix`.
`npm run package` in the repo root refreshes it automatically: it copies the
fresh `.vsix` here, syncs `VERSION` / `VSIX_SIZE` in `app/page.tsx`, and
installs the extension into local VS Code (skip with `npm run
package:no-install`). Brand SVGs in `public/brand/` are copies of
`../brand/svg/`.
