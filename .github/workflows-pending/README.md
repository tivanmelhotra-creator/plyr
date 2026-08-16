# Pending workflow — one command to activate

`ci.yml` in this folder is the project's CI. It is **not running yet**, because
it is not in `.github/workflows/`.

## Why it is parked here

The automation account that opened the pull request is a GitHub App without the
`workflows` permission, so GitHub refuses the push outright:

```
refusing to allow a GitHub App to create or update workflow
`.github/workflows/ci.yml` without `workflows` permission
```

The file itself is complete and unmodified — it just could not be delivered to
its final path. Parking it here keeps the work reviewable in the PR instead of
silently dropping it.

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
manual dispatch:

1. `npm ci` — strictly from the lockfile, proving a clean checkout is enough
2. `npm run check` — typecheck
3. `npm run build` — server + Chrome extension
4. verifies the artifact is installable (15 required files, MV3 manifest, no
   leaked `bootstrap.config.js`)
5. `npm test`
6. uploads **`element-inspector-extension`** as a downloadable workflow
   artifact — so the extension can be installed via
   `chrome://extensions → Developer mode → Load unpacked` with no local
   toolchain at all

Until it is activated, the same result is available locally with:

```bash
npm ci && npm run build      # -> artifacts/element-inspector-extension/
```
