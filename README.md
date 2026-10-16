# Wet Check

A mobile-first installable web app (PWA) for irrigation wet checks. Everything is stored on the device in IndexedDB, so it works offline.

Done so far:
- Folder manager for properties: create, rename, delete and nest folders.
- Wet check reports inside folders, each with a name and date.
- Findings in a report: a main photo (camera or library, compressed to 1600px JPEG on save) plus up to 6 more photos (findings saved earlier with up to 8 keep them), an issue, a zone and an optional note. Extra photos print in rows of three under the finding in the PDF.
- Location box under the note on each finding: GPS coordinates with Map and Copy buttons, plus city, accuracy and time (looked up via BigDataCloud when online, filled in later if taken offline). Camera photos use the phone's location; library photos use what the photo itself recorded.
- Coordinates list for a report (report menu): every finding's coordinates, with Map, Copy and Copy all.
- Zone-by-zone workflow: each report has a current zone (bottom bar, with next/previous buttons) that new findings go into, and findings are grouped by zone.

- Company logo, name and PDF accent color (Settings, via the gear on the home screen; blue by default) and a property photo (top-level property folders) for the PDF cover page.
- Export PDF (report screen): a cover page, then property, date, findings by zone with photo, issue, zone, note and location (underlined coordinates open Google Maps on any device), plus a coordinates list. Built on the device with jsPDF (js/vendor), so it works offline.
- Settings (gear on the home screen): company logo, name and report color; issues and prices; backup and restore. The home screen keeps a backup reminder card.
- Folding zones: in a report, only the zone you're working in is open; other zones fold to a heading with their findings listed and a check or X if marked. Tap a heading to open or close it; zones refold when you change zones.
- Zone status marks: in a report, the green check and red X beside **Add finding** add a finding for the current zone in one tap, with a check or X image in place of a photo. The check is "No issues found" (not counted as a finding or in the estimate); the X is "Valve not opening" at its list price. The check also moves on to the next zone. Both save the location and can be edited like any finding; replacing the image with a photo makes it a normal finding.
- Technician signature: set up a default in **Settings → Technician signature** (draw it with your finger, or type your name and pick one of three handwriting styles, plus name and optional title) and turn it on. Each time you export a report it asks you to confirm the signature: keep the default, re-sign, change the name, title or date, or leave the signature off, for that report only. The report remembers what it was signed with. The PDF ends with a signature block (signature, name, title, date). Backups include the signature.
- Search: the magnifying glass at the top of the home screen and every folder opens Search. It finds properties and folders (and a property's contact), controllers and subdivisions, reports (name or date) and findings (issue, zone, note or city). Every word you type must match. From inside a folder it searches that folder first, with an **Everywhere** button. Tapping a finding opens its report scrolled to that finding, and back returns to the results.
- Controllers: starting a wet check asks which of the property's controllers it covers (or **Whole property**). Reports are listed in a section per controller (A to Z) below the folder's other reports; tap a heading to fold it away and the app remembers which are folded. The report's PDF shows that controller under the property name and in its controller summary. Older reports that had a subdivision keep it and are grouped under it; the subdivision box only appears when editing one of those.
- Backup and restore: **Back up everything** (or one property from its ⋮ menu) makes a .zip that opens in the Files app as a `Wet Check` folder: `Settings/` (logo, settings, issues and prices as a spreadsheet), a folder per property and its folders, a subfolder per controller (or subdivision on older reports), and for each report its PDF and a `Photos/` folder. `App data/` holds what Restore reads, so the same .zip restores everything (older .json backups still restore too). Restore adds to what's on the phone (the newer copy of anything wins) or, for a full backup, replaces everything after a confirmation.

## Issues and prices

Tap the gear on the home screen, then **Issues and prices**, to turn issues on or off, rename them, add your own issues or groups, and set a price for each. Renaming an issue also renames it on findings already saved. Your list is saved on the phone and included in backups; **Reset to the starting list** goes back to the original.

The starting list is `data/issues.json`, as named groups (Broken heads, Valve issues, ...). An issue can be a plain name or `{ "name": "Broken 6\" pop-up", "price": 45 }` to give it a starting price. Changes to this file only show on phones that haven't edited their list (or after a reset).

## Property profiles

Each top-level property has a **Property profile** (card on the property's screen, or its ⋮ menu) with:

- a property contact (name, phone, email, address), printed on the cover of its reports;
- its controllers, as many as the property has: a photo, name or area covered, GPS location (typed, or **Use my location**), make and model, number of zones, water source (municipal, pump well, pump canal or pump lake), rain sensor, master valve, the point of connection's GPS location, and notes on the pump or backflow. Exported reports start with a quick summary of them ahead of the findings. Backups list them in the property's `Controllers.txt`, with photos in `Controller photos/`;
- its own troubleshooting disclaimer, used instead of the main one, or the disclaimer turned on or off for just that property;
- its own issues and prices: change a price or turn an issue off (marked **Custom**), or add issues only this property uses. Anything not changed keeps following the main list in Settings. Issue names can only be changed in Settings.

Folders and subdivisions inside a property use its profile. **Reset this property to the main settings** removes its contact, disclaimer and custom issues and prices; controllers stay.

## Repair estimates

Each report has an optional **Include a repair estimate** checkbox (also in the report's ⋮ menu). With it on, each finding is priced from the prices in effect when the report was created (main list plus the property's profile), or a price typed on that finding. Later price changes don't change existing reports; use **Use current prices** in the report's ⋮ menu or the estimate to update one, the report shows a running total, and the PDF adds the total to the cover and a Repair estimate page with quantity, unit price and amount per repair. Findings whose issue has no price are listed but left out of the total. Tap **+ Add a discount** in the estimate to take a dollar amount or a percentage off the total, with an optional label; the PDF shows the subtotal, the discount and the total after it.

## Troubleshooting disclaimer

Each finding has an optional checkbox that adds a troubleshooting disclaimer, shown on the finding and in the PDF. The wording defaults to "*Troubleshooting required. Additional proposals may be required to complete this repair." and can be edited and saved from the finding form.

The disclaimer can be turned off entirely in **Settings → Troubleshooting disclaimer**, where its wording can also be edited. When it is off, new findings don't offer it; findings that already have a disclaimer keep it. A property profile can turn it on or off for that property alone, overriding Settings.

## Run locally

No build step. Serve the folder over http, for example:

```
python3 -m http.server 8000
```

then open http://localhost:8000.

When you change any app file, bump `VERSION` in `sw.js` and `APP_VERSION` in `js/app.js` (shown on the home screen) so installed copies update.

The handwriting fonts for typed signatures (Great Vibes, Dancing Script, Homemade Apple) are in `fonts/` under the SIL Open Font License; each has its license file beside it.
