# temp-logger working agreements

Follow Mike's global AGENTS.md guidance. This repository adds:

- Plain Node.js ESM and browser JavaScript; `package.json` is the version source.
- Declare runtime/test dependencies in the manifest and synchronize the lockfile.
- Run `npm ci`, `npm run test:install` (once), and `npm run check` before publishing.
- `npm run build` validates directly served sources; there is no bundle to generate.
- Real sensors need Apple Silicon macOS; CI and browser tests use demo mode.
- Keep real, demo, and test databases separate. Never commit databases or test output.
- Use `DB_PATH=:memory:` for disposable manual checks. Worktrees need no local data.
- For sensor changes, run `npm run sensors:check` on supported hardware when available.
- Non-trivial work uses sibling worktrees and squash PRs. Version each PR once.
- GitHub Actions is the only deployment automation; this is a local app, not a hosted service.

- Desktop/login changes require `npm run build:desktop` on macOS. Never install
  login agents pointing at a temporary feature worktree; install from primary main.
- Default app port comes from `package.json` config.port. Keep the native window
  and launchd service aligned with it.
- Stored temperatures and API temperatures are Celsius; F/C is display-only.
- Workload is sampled in memory every second; summaries persist at the thermal
  interval. CPU percentages are normalized across all cores.
