# Handoff 23 — workflow file (export/import) + NDV review

## Decisions (and why)
- **One module, two readers** (`public/js/workflow-exchange.js`): the page and the server run the same
  file, so the preview the user confirms is what the server stores. Same pattern as the catalogs.
- **Imported workflow is saved inactive, Code nodes disabled, no webhook.** A file somebody else wrote
  must not run, fire on a schedule or post results elsewhere until the operator has read it.
- **Secrets are blanked on export and listed**, not silently kept; the dialog tells the importer which
  ones to re-enter.
- **`disabled` as a persisted step flag.** The old serialiser dropped disabled nodes on save, so
  "disable a node" lost the node on the next autosave. Run path still skips; document path keeps.
- **No n8n importer**, by brief.

## NDV vs n8n
| Item | Before | Now |
|---|---|---|
| INPUT / Parameters / OUTPUT | present | unchanged |
| Drag a field into a parameter | only worked if already in Expression mode | drop on a Fixed field flips it to Expression (generic + designed fields) |
| Unexecuted node | text only | text + Run button (guarded runner); "ran, no output" is a different message |
| RTL | grid inherited rtl: INPUT/OUTPUT swapped, hairlines on wrong edges | order pinned to data flow; text still RTL |

## Not done
- Output "Table" view for items is still JSON (pre-existing).
- Bulk import of several files at once.
