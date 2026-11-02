# Contributing

Thanks for contributing to `@clagradi/effect-runtime`.

## Local setup

Use Node 22 or newer (24 LTS recommended).

```bash
npm install
```

## Validate changes

```bash
npm run check          # lint + typecheck + tests + build + package checks (publint, attw)
npm run smoke:consumer # pack the library, import it from Node (ESM + CJS + SSR), build the example app
```

Useful while developing:

```bash
npm run test:watch
npm run test:coverage
```

Tests run against React 19 by default. CI also runs them against React 18; to do that locally:

```bash
npm install --no-save react@18 react-dom@18 @types/react@18 @types/react-dom@18
npm run typecheck && npm test
npm install # restore React 19
```

## Pull request checklist

- Keep changes focused and minimal.
- Add or update tests when behavior changes (`tests/*.test.tsx`, type tests in `tests/types.test-d.ts`).
- Update `README.md` and `CHANGELOG.md` when the API or behavior changes.
- Do not commit build artifacts like `dist/` or `*.tgz`.
- Ensure CI passes before requesting review.

## Releasing

1. Add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md` (it becomes the GitHub release notes)
   and commit it: `npm version` needs a clean working tree.
2. Bump the version; this commits `package.json` / `package-lock.json` and creates the `vx.y.z` tag:

   ```bash
   npm version minor   # or patch / major / prerelease --preid rc
   ```

3. Push the commit and the tag:

   ```bash
   git push origin main --follow-tags
   ```

4. The `Publish package` workflow (`.github/workflows/publish.yml`) checks that the tag matches
   `package.json`, runs `npm run check` and the consumer smoke test, publishes to npm with
   provenance (prereleases under the `next` dist-tag), and creates the GitHub release. If a step
   fails, fix the cause and re-run it from **Actions → Publish package → Run workflow** with the
   tag selected: publishing and release creation are skipped when already done.

### One-time npm setup

The workflow authenticates with **npm trusted publishing** (OIDC), so no long-lived token is needed:

1. On npmjs.com open the package, then **Settings → Trusted publishing → GitHub Actions**.
2. Organization or user: `clagradi`, repository: `UseEffectState`, workflow filename: `publish.yml`
   (leave the environment empty).

Alternatively, store an npm granular access token with publish rights as the `NPM_TOKEN`
repository secret; the workflow uses it when trusted publishing is not configured.
