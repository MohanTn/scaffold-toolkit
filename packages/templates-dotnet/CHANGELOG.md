# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- This change consolidates the template library by removing support for v10-minimal-api (both standard and GCP variants) and v8-controller-gcp variants, while significantly expanding the v8-controller template pack from base templates to 67 comprehensive templates covering CQRS patterns, domain-driven design, and multi-tenancy. A new architecture document establishes the dual-DbContext multi-tenancy pattern, the rendering engine gains pathConfig support for dynamic output paths, and configuration examples are enhanced with database provider and company/project metadata fields.
- This change introduces template pack validation automation. A new `validate-all.mjs` script auto-discovers all template packs and runs the existing smoke-test renderer against each using a shared example manifest. A GitHub Actions workflow runs this validation on every push to main and pull request across Node 18, 20, and 22. Package-lock.json is now committed for reproducible builds, and documentation updated to reflect the new npm test entry point.
