# Operator

A Windows desktop app (Electron): an AI agent that drives the PC and its own
browser. `main.js` is the main process, `ui/` the window, `agent.js` the agent
and its tools. See README.md for the features.

## Working on it from the cloud

- Operator can't run here: it is a Windows app that controls the desktop.
  Check edits with `node --check <file>`. The window's UI can be previewed with
  `node ui-preview.js` (http://localhost:4321, fed by `ui/_preview-stub.js`).
- `npm install` downloads Electron and Chromium. If that is blocked, set
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1` and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`;
  neither is needed to edit or check the code.
- The owner tests by installing the build. Anything that lands on `main` is
  built into a Windows installer by `.github/workflows/build.yml` and published
  on the Releases page. So finish a change by getting it onto `main`, unless
  told otherwise.
- Make surgical edits: change only the lines that need changing, and never
  rewrite a whole file.
