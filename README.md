# Allmaps IIIF Tiler

Static browser app for creating IIIF Image API Level 0 tile pyramids.

## Static hosting

The app is built with `@sveltejs/adapter-static` and writes static files to
`build/`.

## Render

This repo includes a `render.yaml` Blueprint for Render Static Sites:

- Build command: `pnpm install --frozen-lockfile && pnpm build`
- Publish directory: `./build`
- Static-site headers for cross-origin isolation

If you create the Render Static Site manually instead of from the Blueprint, add
these custom response headers in the Render Dashboard with path `/*`:

```http
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

wasm-vips requires `SharedArrayBuffer`, so the site must be served with these
headers on every document, script, worker, and WASM response:

```http
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

Local development and preview should use the project scripts:

```sh
pnpm dev
pnpm build
pnpm preview
```

Opening `build/index.html` directly or serving `build/` with a generic static
file server will not work unless that server also sends the two headers above.
