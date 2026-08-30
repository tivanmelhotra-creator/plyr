# Pending workflow — one command to activate

`.github/workflows/ci.yml` **is now active on `main`** (an earlier PR delivered
it by hand). The copy in this folder is a **superset** of it: same build and
artifact steps, plus a second job that installs a real Chromium and runs the
browser test tier. That extra job is the part that is not running yet.

## Why it is parked here

The automation account that opens these pull requests is a GitHub App without
the `workflows` permission, so GitHub refuses any push that touches the live
workflow file — even a modification to one already on `main`:

```
refusing to allow a GitHub App to create or update workflow
`.github/workflows/ci.yml` without `workflows` permission
```

So the live file is left byte-identical to `main` and the improved version is
parked here, reviewable in the PR instead of silently dropped.

## Is CI red without it?

**No.** The active workflow runs `npm ci → npm run check → npm run build →
artifact verify → npm test`, and `npm test` is green (113 files, 3025 tests).
`npm test` no longer launches a browser at all — the suites that need one were
moved to `tests/browser/**` and are excluded from it — so the active workflow
needs no browser to pass.

Activating the copy here **adds** coverage (it runs `npm run test:browser`,
34 tests against a real Chromium); it does not repair anything.

## Activate it

```bash
git mv .github/workflows-pending/ci.yml .github/workflows/ci.yml
rmdir .github/workflows-pending 2>/dev/null || true   # after also moving/removing this README
git commit -m "ci: activate the build + extension-artifact workflow"
git push
```

(Or in the GitHub web UI: **Add file → Create new file**, name it
`.github/workflows/ci.yml`, and paste the contents of `ci.yml`.)

## What it does once active

On every push to `main` / `genspark_ai_developer`, on PRs into `main`, and on
manual dispatch — **job `build`** (already live on `main`):

1. `npm ci` — strictly from the lockfile, proving a clean checkout is enough
2. `npm run check` — typecheck
3. `npm run build` — server + Chrome extension
4. verifies the artifact is installable (15 required files, MV3 manifest, no
   leaked `bootstrap.config.js`)
5. `npm test` — the unit + integration tier, no browser
6. uploads **`element-inspector-extension`** as a downloadable workflow
   artifact — so the extension can be installed via
   `chrome://extensions → Developer mode → Load unpacked` with no local
   toolchain at all

…and **job `browser`** (the new part, only in this copy):

7. installs Chromium, caching it under a key read from the *installed*
   Playwright version rather than a hard-coded one — a stale key is worse than
   no cache, because it restores browsers built for a different Playwright
8. `--with-deps` on a cache miss, `install-deps` on a hit: apt state is never
   cached, so the system libraries must be installed either way while the
   ~400 MB download is skipped
9. **verifies Chromium actually launches.** `tests/browser/real-browser.ts`
   skips *honestly* when no browser is available, so without this check a
   broken install would show up as a fully green run that tested nothing
10. `npm run test:browser`

It carries no `needs:`, deliberately: it runs in parallel with `build`, so a
browser-infrastructure hiccup can never stop the extension artifact from being
produced.

Until it is activated, the same result is available locally with:

```bash
npm ci && npm run build      # -> artifacts/element-inspector-extension/
```
