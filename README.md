# Wet Check

A mobile-first installable web app (PWA) for irrigation wet checks. Everything is stored on the device in IndexedDB, so it works offline.

Stage 1 (current): folder manager for properties. Create, rename, delete and nest folders.

Coming next: wet check reports inside folders, findings with photos, and PDF export.

## Run locally

No build step. Serve the folder over http, for example:

```
python3 -m http.server 8000
```

then open http://localhost:8000.

When you change any app file, bump `VERSION` in `sw.js` so installed copies update.
