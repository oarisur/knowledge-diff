# Changelog

All notable changes to Knowledge Diff are documented in this file.

## [1.1.0] - 2026-08-31

### Added

- A versioned 30-case quality benchmark with retrieval and live-provider evaluation modes.
- Deterministic evaluation metrics and a CI quality gate.
- A deployable hosted GitHub App preview with webhook verification, installation authentication, trusted repository configuration, bounded job processing, and GitHub check runs.
- Docker, deployment manifest, and hosted-service configuration examples.

### Changed

- Hardened drift detection with batched document candidates, strict structured-output parsing, retry backoff, request timeouts, and partial-failure reporting.
- Documentation is analyzed from the pull-request head while hosted configuration is read from the trusted base revision.
- Expanded default document discovery to include common AI-agent instruction files.
- Updated the GitHub Action runtime to Node.js 24.
- Updated default models to `gpt-4o-mini`, `claude-haiku-4-5-20251001`, and `gemini-2.5-flash`.

### Fixed

- Prevented incomplete analyses from being reported as successful.
- Improved behavior for forked pull requests and inaccessible head documentation.
- Repaired cross-platform optional-dependency metadata so clean Linux `npm ci` installs succeed.

## [1.0.0] - 2026-05-27

- Initial GitHub Marketplace release.

[1.1.0]: https://github.com/oarisur/knowledge-diff/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/oarisur/knowledge-diff/releases/tag/v1.0.0
