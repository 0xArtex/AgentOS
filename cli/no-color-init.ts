// Side-effect module: honor `--no-color` and the NO_COLOR convention BEFORE any
// color-emitting module (./ui.js, ./app.js) is imported. ./ui.js snapshots
// process.env.NO_COLOR at import time, so this must run first — it is imported
// at the very top of cli.ts, ahead of the UI imports, so the theme is frozen in
// the correct mode. We scan process.argv directly (parse() hasn't run yet).
if (process.argv.includes('--no-color') || process.env.NO_COLOR) {
  process.env.NO_COLOR = '1'
}
