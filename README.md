# Wet Check

A mobile-first installable web app (PWA) for irrigation wet checks. Everything is stored on the device in IndexedDB, so it works offline.

Done so far:
- Folder manager for properties: create, rename, delete and nest folders.
- Wet check reports inside folders, each with a name and date.
- Findings in a report: a photo (camera or library, compressed to 1600px JPEG on save), an issue, an optional zone and an optional note.

Coming next: PDF export.

## Editing the issue list

The Issue dropdown comes from `data/issues.json`. Edit the `issues` list there (keep the quotes and commas). Findings that used an issue you remove keep it.

## Run locally

No build step. Serve the folder over http, for example:

```
python3 -m http.server 8000
```

then open http://localhost:8000.

When you change any app file, bump `VERSION` in `sw.js` so installed copies update.
