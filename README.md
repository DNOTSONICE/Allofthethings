# Wet Check

A mobile-first installable web app (PWA) for irrigation wet checks. Everything is stored on the device in IndexedDB, so it works offline.

Done so far:
- Folder manager for properties: create, rename, delete and nest folders.
- Wet check reports inside folders, each with a name and date.
- Findings in a report: a photo (camera or library, compressed to 1600px JPEG on save), an issue, a zone and an optional note.
- Location box under the note on each finding: GPS coordinates with Map and Copy buttons, plus city, accuracy and time (looked up via BigDataCloud when online, filled in later if taken offline). Camera photos use the phone's location; library photos use what the photo itself recorded.
- Coordinates list for a report (report menu): every finding's coordinates, with Map, Copy and Copy all.
- Zone-by-zone workflow: each report has a current zone (bottom bar, with next/previous buttons) that new findings go into, and findings are grouped by zone.

- Company logo, name and PDF accent color (home screen; blue by default) and a property photo (top-level property folders) for the PDF cover page.
- Export PDF (report screen): a cover page, then property, date, findings by zone with photo, issue, zone, note and location (links open the map), plus a coordinates list. Built on the device with jsPDF (js/vendor), so it works offline.

## Editing the issue list

The Issue dropdown comes from `data/issues.json`, as named groups (Broken heads, Valve issues, ...), each with its list of issues. Edit the groups there, keeping the quotes, commas and brackets. Findings that used an issue you remove keep it.

## Troubleshooting disclaimer

Each finding has an optional checkbox that adds a troubleshooting disclaimer, shown on the finding and in the PDF. The wording defaults to "*Troubleshooting required. Additional proposals may be required to complete this repair." and can be edited and saved from the finding form.

## Run locally

No build step. Serve the folder over http, for example:

```
python3 -m http.server 8000
```

then open http://localhost:8000.

When you change any app file, bump `VERSION` in `sw.js` and `APP_VERSION` in `js/app.js` (shown on the home screen) so installed copies update.
