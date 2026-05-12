# Allmaps IIIF Tiler

Static browser app for creating IIIF Image API Level 0 tile pyramids.

Images are decoded and rendered locally with browser Canvas APIs in a Web
Worker. The ZIP file is assembled in the browser with `fflate`.

## Static hosting

The app is built with `@sveltejs/adapter-static` and writes static files to
`build/`.

## Render

This repo includes a `render.yaml` Blueprint for Render Static Sites:

- Build command: `pnpm install --frozen-lockfile && pnpm build`
- Publish directory: `./build`

Local development and preview should use the project scripts:

```sh
pnpm dev
pnpm build
pnpm preview
```

Because the app uses the browser image decoder, supported input formats depend
on the browser. JPG, PNG, and WebP are supported in modern browsers.
