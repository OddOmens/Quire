# Contributing

Suggestions and fixes are welcome.

1. **Fork** the repository and make your change on a branch in your fork.
2. Run the checks locally (you only need Docker and Node):
   - `make test` for the Go tests.
   - `npm test && npm run build` in `frontend/`.
3. Open a **pull request** against `main`, saying what it changes and why.

Quire's security model is short and strict, so please keep to it:

- Every file operation goes through the vault (`os.Root`). No direct `os.Open` on a path that came from a request.
- Pages stay plain Markdown. Anything the editor can't represent must survive a save unchanged.
- Public pages (share links and forms) are served without script and expose only what was shared.
- Nothing may grow without a limit: new tables, caches and logs need pruning.

Quire is licensed under the [GNU AGPL v3.0](LICENSE). By opening a pull request you agree that your contribution is licensed under it too.

For a bug or an idea you'd rather not code yourself, open an issue. For a **security problem**, don't open an issue or pull request; see [SECURITY.md](SECURITY.md).
