# Wet Check

A mobile-first installable web app (PWA) for irrigation wet checks. Everything is stored on the device in IndexedDB, so it works offline.

Done so far:
- Folder manager for properties: create, rename, delete and nest folders.
- Wet check reports inside folders, each with a name and date.
- Findings in a report: a photo (camera or library, compressed to 1600px JPEG on save), an issue, a zone and an optional note.
- Location box under the note on each finding: GPS coordinates with Map and Copy buttons, plus city, accuracy and time (looked up via BigDataCloud when online, filled in later if taken offline). Camera photos use the phone's location; library photos use what the photo itself recorded.
- Coordinates list for a report (report menu): every finding's coordinates, with Map, Copy and Copy all.
- Zone-by-zone workflow: each report has a current zone (bottom bar, with next/previous buttons) that new findings go into, and findings are grouped by zone.

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
