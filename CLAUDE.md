# Operator

A Windows desktop app (Electron): an AI agent that drives the PC and its own
browser. `main.js` is the main process, `ui/` the window, `agent.js` the agent
and its tools. See README.md for the features.

## Running and testing

- The owner works on it from more than one PC. Run `git pull` before starting,
  so you have their latest work.
- On a Windows PC: `npm install` once, then `npm start` runs it. After every
  change, restart it so the owner always sees the latest version.
- In the cloud (claude.ai/code), Operator can't run: it is a Windows app that
  controls the desktop. Check edits with `node --check <file>`. The window's UI
  can be previewed with `node ui-preview.js` (http://localhost:4321, fed by
  `ui/_preview-stub.js`).
- `npm install` downloads Electron and Chromium. If that is blocked, set
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1` and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`;
  neither is needed to edit or check the code.
- The owner tests by installing the build. Anything that lands on `main` is
  built into a Windows installer by `.github/workflows/build.yml` and published
  on the Releases page. So finish a change by committing it and pushing it to
  `main`, unless told otherwise.
- Make surgical edits: change only the lines that need changing, and never
  rewrite a whole file.
