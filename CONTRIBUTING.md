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

1. In a pull request, bump `version` in `package.json` (`npm version minor --no-git-tag-version`,
   or `patch` / `major` / `prerelease --preid rc`) and add a `## [x.y.z] - YYYY-MM-DD` section to
   `CHANGELOG.md` (it becomes the GitHub release notes). Merge it into `main`.
2. Tag the merge commit on `main` and push the tag:

   ```bash
   git fetch origin main
   git tag v0.2.0 origin/main
   git push origin v0.2.0
   ```

3. The `Publish package` workflow (`.github/workflows/publish.yml`) then:
   - checks that the tag points at a commit on `main` and matches `package.json`,
   - runs `npm run check` and the consumer smoke test, and packs the tarball,
   - publishes that exact tarball to npm from a separate job that only runs npm (trusted
     publishing with provenance; prereleases go to the `next` dist-tag),
   - creates the GitHub release with the CHANGELOG section as notes.

   Every job is safe to re-run: if one fails, fix the cause and use **Re-run failed jobs** on the
   run page. Publishing is skipped when the version is already on npm, and the release when it
   already exists.

### One-time npm setup (trusted publishing)

The workflow authenticates with **npm trusted publishing** (OIDC): no npm token is stored in
GitHub, and npm generates provenance automatically.

1. On npmjs.com open `@clagradi/effect-runtime`, then **Settings → Trusted publishing → GitHub
   Actions**: organization or user `clagradi`, repository `UseEffectState`, workflow filename
   `publish.yml`, environment empty.
2. Tick **npm publish** under allowed actions (configurations created after September 2026 only
   allow staged publishing unless you opt in).
3. Push the release tag within 48 hours: npm deletes a new configuration that has not been used
   for a successful publish by then.

After the first successful publish, consider **Settings → Publishing access → Require two-factor
authentication and disallow tokens**.

Optional: set the repository variable `NPM_STAGED_PUBLISH` to `true` to stage releases instead;
approve them on npmjs.com (Staged Packages) or with `npm stage approve <id>`.
