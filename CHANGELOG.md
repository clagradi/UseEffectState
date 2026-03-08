# Changelog

All notable changes to this project are documented in this file.

## [0.1.2] - 2026-03-08

### Changed

- Added a real consumer smoke test that installs the packed tarball into the Vite example app and runs typecheck plus build.
- Split CI into core validation and consumer package validation.
- Refined README structure with before / after usage, local example instructions, consumer verification, and release flow.
- Removed provenance from local `publishConfig`; CI remains the supported provenance publish path.
- Stopped versioning generated `dist/` output and tarball artifacts.

### Fixed

- Added focused `useEvent` tests for stable identity and latest closure behavior.

## [0.1.1] - 2026-02-27

### Changed

- Hardened release metadata for npm package consumers.
- Refined publish and release documentation for scoped package workflows.
- Added OSS hygiene docs: contributing guide, issue templates, and security policy.
- Confirmed CI and publish workflows for tag-based release automation.

## [0.1.0] - 2026-02-26

### Added

- Initial release of `@clagradi/effect-runtime`.
- `useEffectTask` and `useEvent` primitives for safer async effect handling.
