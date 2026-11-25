# Changelog

All notable changes to Quire. Versions follow [semantic versioning](https://semver.org); each release's section here becomes its GitHub release notes.

## [Unreleased]

## [0.1.0] - 2026-11-25

First public release.

### Added

- **Spaces and nested pages**, each page a plain Markdown file on your server, edited with a visual block editor (`/` for blocks, tables, math, Mermaid, media, embeds and more).
- **Links and backlinks** with `[[`, rewritten for you on renames and moves.
- **Databases, formulas and forms**: typed columns; table, board, calendar, gallery and chart views; spreadsheet-style formulas; forms with public links. Rows are a `.csv` beside the page.
- **Search** across titles and full text that lists the sections that fit best and copes with other word forms and misspellings, plus tags, a link graph, open tasks and missing links per space.
- **Ask**: type a question in plain words and get the section of your pages that answers it. It is search, not AI: nothing leaves the server.
- **History and trash**, including changes made to the files outside Quire.
- **Backups to [Coffer](https://github.com/OddOmens/Coffer)** on a schedule, and import from Markdown folders, Obsidian, Notion and Docmost.
- **Sharing** a page read-only by link, **live sync** between open tabs and devices, and an installable app for phones.
- **Sign-in** with a password and optional two-factor codes; secret warnings for pages that look like they hold a password or key.
- Images for x86-64 and ARM64 on GitHub Container Registry: `ghcr.io/oddomens/quire`.

[Unreleased]: https://github.com/OddOmens/Quire/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OddOmens/Quire/releases/tag/v0.1.0
