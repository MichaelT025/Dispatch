# Dispatch logo

Original artwork supplied for Dispatch, preserved without modification:

- `dispatch-dark.png`: dark foreground for light backgrounds.
- `dispatch-light.png`: light foreground for dark backgrounds.
- `dispatch.svg`: scalable source with dark foreground and red core.

The README selects the matching PNG for its background. The CLI has no raster-logo surface; upstream extension screenshots and artwork are unchanged.

Dispatch Web derives its adaptive in-app mark, favicon, PWA icons and desktop icon from this same SVG. Its `scripts/generate-brand-assets.mjs` regenerates those assets without changing the source geometry.
