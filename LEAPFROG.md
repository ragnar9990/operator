# Operator — LEAPFROG

A build spec written to be **fed to a coding agent**, in the same shape as
`BEAT-GROKBOT.md`. That file closes the gap with Grok Bot. **This file is about
not being in the same race.**

`BEAT-GROKBOT.md` is still the backlog and is **not** superseded — of it, only
dry run (#3) and the audit log (#4) are built. Nothing here duplicates an item
in that file. Where something is adjacent, the item says how it differs.

---

## THE THESIS — paste this above any prompt in this file

> **MASTER CONTEXT — required before any task below.**
>
> You are working on **Operator**, an Electron app at `C:\Users\c3645\operator`.
> It is an AI agent that drives a real Windows computer: its own private hidden
> desktop (`desktop-launcher.ps1` → `desktop-helper.ps1`), a dedicated Playwright
> Chromium (`browser.js`), PowerShell, email, and voice. The brain is the Claude
> Agent SDK on the user's own Claude subscription (`agent.js`), or any model on
> NVIDIA NIM (`nim.js`).
>
> **Architecture you must respect:**
> - `agent.js` — the brain. Every tool (`screen_*`, `browser_*`, `list_windows`,
>   `focus_window`, `launch_app`, `run_command`, `wait`, `remember`, `email_*`,
>   `get_verification_code`, `message_bot`, `*_code_chat`), the SYSTEM_PROMPT, the
>   model list, skill injection. The toolset and prompt are built **once**, before
>   it decides whether Claude or NIM is driving, so both brains always have
>   identical hands and the UI cannot tell them apart.
> - `nim.js` — the OpenAI-compatible tool-calling loop. It emits the **same
>   events** as the Agent SDK. Any new tool must work on both paths.
> - `main.js` — Electron main. `runOne()`, IPC handlers (`domain:verb`), the
>   routines scheduler (`tick` / `dueNow` / `fireRoutine`), connectors.
> - `store.js` — persistence. Bots in `bots.json`; skills, connectors, code chats
>   and settings in `settings.json`, under Electron `userData`.
> - `desktop.js` ↔ `desktop-helper.ps1` — newline-JSON over stdio to one
>   long-lived PowerShell process, P/Invoke to user32. Can run on the **private
>   hidden desktop** or on a **remote machine** (`remote-node.ps1`).
> - `browser.js` — one persistent Chromium. Browser actions return page **text**,
>   not screenshots, because it is faster and cheaper.
> - `audit.js` — the run journal. Already has `audit:query`, `audit:facets`,
>   `audit:export`. Several items below build on it; read it before you extend it.
> - `ui/index.html`, `ui/renderer.js`, `ui/styles.css` — front end, two modes
>   (Agents, Code). Dark theme, tokens on `:root` (`--bg #131211`,
>   `--accent #299fff`, `--ink`, `--line`). Match the existing visual language.
>
> **House rules — these are not negotiable:**
> - **No native modules.** `npm run dist` must never need node-gyp.
> - **Never break the private-desktop path.** Except where an item explicitly
>   hands control over, the agent must never steal the user's mouse, keyboard or
>   foreground window.
> - **Do not rewrite working code.** Add alongside. Read the neighbouring code
>   first and match its voice: short comments that say *why*, not *what*.
> - **One feature per commit**, each revertable on its own. Do not batch.
> - Verify with `node --check` on every file you touch, then `npm start` and
>   confirm it boots clean and an existing task still runs end to end.
> - Every new capability must degrade gracefully: if the feature is off, unpaired
>   or unsupported, the app behaves exactly as it does today.
>
> **Why we are building this.** Competitors — Grok Bot, and every cloud
> computer-use agent — rent you a Linux VM in a datacentre. They are all the same
> shape, so they all have the same ceiling: the machine is not yours, it has none
> of your apps, none of your logins, none of your files, and it forgets everything
> about your world between runs. They are also priced per month, forever.
>
> Operator is a **$49 one-time Windows app that drives the computer the user
> already owns.** The items below are chosen because a cloud VM *structurally*
> cannot copy them. Together they make one claim true:
>
> > **An agent you can actually trust with your real computer — and one that gets
> > faster, cheaper and more reliable every time it does a job.**
>
> Three pillars. Every item serves one:
> 1. **Trust** — you can watch it, stop it, take over from it, and undo it.
> 2. **Compounding** — the second time it does a job it costs nothing and takes
>    seconds, because it learned.
> 3. **It is your machine** — your apps, your logins, your files, your printer,
>    offline, no subscription.

### Ship constraints (do not gold-plate)

Operator has a launch date: **live and taking money by 30 November 2026**, at $49.
Every item below must ship **independently**. If an item is not finished, it must
be possible to leave it switched off and launch without it. Prefer a small honest
version now over a complete one in February.

---

# TIER 1 — The three that change the category

## 1. Take the wheel — live handoff, both directions

**Why it wins.** Every agent on the market dies at the same place: a login it
can't do, a 2FA prompt, a payment screen, a judgement call, a CAPTCHA. They all
respond by giving up and writing you a paragraph. Operator can do the one thing a
datacentre VM can never do — hand the wheel to the human who is *right there*, let
them do the ten seconds only they can do, and carry on from the new state.

This is also the answer to the single biggest objection to buying: *"I'm not
letting an AI loose on my machine."* You are not. You are sitting next to it.

**Build.**

- New tool `ask_human(question, why)` in `agent.js`. It pauses the run and puts
  the question in front of the user. It is not a chat message — it blocks.
- New tool `hand_over(reason)` — the agent asks for the human to drive.
- A **Take the wheel** button on the running-task UI, live at any point, not only
  when the agent asks.
- Handoff mechanics: `desktop-helper.ps1` already owns the private desktop. Add
  `SwitchDesktop` (user32) so the user's input desktop switches to the agent's,
  and back. On the agent desktop there is no Explorer shell — that is fine and
  expected; the user sees only the app windows.
- While the human has the wheel, show a small always-on-top bar on that desktop
  (reuse the pattern in `overlay.js`): *"You have the wheel. Ctrl+Alt+O to hand
  back."* Electron's `globalShortcut` does **not** fire on another desktop, so
  poll the combo with `GetAsyncKeyState` in the helper loop.
- Pausing the run: the tool wrapper in `agent.js` must `await` a resume gate
  **between** tool calls, so the model is never mid-call when control moves. This
  must work identically on the `nim.js` path.
- On hand-back: screenshot, diff against the screenshot taken at hand-over, and
  inject a synthetic user turn — *"The human took the wheel for 40s. Here is the
  screen now. Carry on from here."* Never resume blind.
- Log both edges to `audit.js` as first-class events.
- Remote node: if the agent is driving another machine, "take the wheel" must say
  plainly that the wheel is over there, and offer the screen view instead.

**Done when.** Mid-task, the user clicks Take the wheel, lands on the agent's
desktop, types a password into a real login box, presses Ctrl+Alt+O, is returned
to their own desktop, and the agent continues the same task with the logged-in
state — with both handoffs in the audit log. And: a task that asks `ask_human`
waits indefinitely without burning tokens.

---

## 2. Rewind — a real undo for what it did

**Why it wins.** The thing that stops people letting an agent touch a real
computer is not that it is slow. It is that a mistake is permanent. Dry run
(`BEAT-GROKBOT.md` #3) answers *"what will it do?"* — **Rewind answers the much
harder question, "it already did it, now what?"** Nobody in this market offers it,
because on a fresh cloud VM there is nothing worth undoing.

**Build.**

- A per-run **journal** directory under `userData`: `runs/<runId>/journal/`.
- Route destructive file work through new tools that journal first:
  `fs_write(path, content)`, `fs_move(from, to)`, `fs_delete(path)`. Each copies
  the current bytes into the journal, with a manifest entry, before it acts.
- Deletes go to the **Recycle Bin**, never `Remove-Item`. Use the shell API in the
  helper.
- `run_command` is a shell, so it can still do damage. Add a **pre-flight scan**:
  if the command matches destructive patterns (`Remove-Item`, `rm`, `del`,
  `Move-Item`, `Set-Content`, `Out-File`, `>`/`>>` redirects, `rmdir`, `format`,
  `reg delete`), resolve the target paths and journal them first. If the targets
  cannot be resolved, require confirmation. Do not silently let it through.
- Teach the SYSTEM_PROMPT to prefer the `fs_*` tools over PowerShell for file
  changes, and say why.
- UI: every finished run gets a **Rewind** button showing exactly what would be
  restored — file count, bytes, list. One click restores.
- **Be honest about the limits, in the UI, in plain words.** Registry edits,
  settings changed inside an app, emails sent, money spent and web forms submitted
  are *not* undoable. The panel must list what it cannot undo as prominently as
  what it can. A rewind that silently half-works is worse than none.
- Journals age out on a setting (default 7 days) and report their disk use.

**Done when.** A task that renames 40 files, overwrites two and deletes one can be
fully reversed by one button; the panel lists the one thing it could not undo
(a sent email) before the user clicks; and the whole thing is off by default for
`run_command` if the user turns the scanner off.

---

## 3. Replay — compile a finished run into a macro that costs nothing

**Why it wins.** This is the compounding pillar, and commercially it is the
strongest item in the file. Today, doing the same job twice costs the same twice.
After this, the **second run of a job uses zero model calls**: it is a script, it
takes seconds, it works offline, and it never gets it wrong differently. A
competitor billing $120/month for VM time has no incentive to build the feature
that makes their meter stop spinning. We do — we are one-time.

It is also the honest version of "teach-a-task" (`BEAT-GROKBOT.md` #1): they
record you doing it, we record *the agent* doing it, after it has already proven
the job works.

**Build.**

- After a successful run, compile its `audit.js` action list into a **script**:
  an ordered list of steps, each `{ action, args, checkpoint }`.
- **Prefer durable locators over pixels.** A step recorded as `screen_click(x,y)`
  should be re-expressed as `screen_click_text` / a UIA element / a browser text
  selector wherever the original action had one. Coordinates are the last resort
  and must be marked brittle.
- Each step carries a **checkpoint**: a cheap assertion that the world is where it
  should be — expected window title, expected text on screen, expected URL. No
  model call.
- A runner executes the script with the same `desktop.js` / `browser.js`
  functions. No brain attached.
- **Self-healing.** When a checkpoint fails, the runner wakes the model **for that
  one step only**, with the goal, the failed checkpoint and a screenshot, lets it
  fix that step, records the fix, and rewrites the script. The next run is free
  again. This is the feature — not the recording, the healing.
- Store scripts as first-class objects in `store.js` (name, source run, step
  count, last run, heal count, success rate). Surface them in the UI as
  **Playbooks**.
- Routines and watchers (#4) can fire a playbook instead of a prompt.
- A playbook must honour the same policy gates and audit logging as a live run.
  A script is not an excuse to skip approvals.

**Done when.** "Download yesterday's invoices and file them by month" runs once
with the model, is saved as a playbook, and runs again with **zero** model calls
in under a fifth of the time; when the site moves a button, the run heals that one
step, logs the heal, and the run after that is free again.

---

# TIER 2 — Make it an automation platform, not a chat box

## 4. Watchers — triggers that aren't a clock

**Why it wins.** Routines today are scheduled. Real work is *event shaped*: when
the invoice lands, when the file appears, when the page changes. This turns
Operator from "an assistant you talk to" into "software that runs your errands",
which is a different purchase.

**Build.** Extend the routines model in `store.js` and the `tick`/`dueNow`/
`fireRoutine` scheduler in `main.js` with trigger types:

- **File** — a path or glob appears / changes / is deleted (PowerShell
  `FileSystemWatcher` in the helper, debounced).
- **Email** — a message matching a filter arrives (`email.js` already polls).
- **Window** — an app or window title opens or closes.
- **Web** — a page's visible text changes, or a selector's text matches (reuse
  `browser_read_text`; cheap polling, configurable interval).
- **Webhook** — an HTTP POST. `phone.js` already runs a token-guarded local
  server; reuse it, do not start a second one.
- **Hotkey** — a global combo.
- **Clipboard** — content matches a pattern.

Each watcher fires a prompt **or a playbook** (#3), on a chosen bot. Every watcher
needs: an enable toggle, a last-fired time, a fired-count, a **cool-down**, and a
**max-per-hour** so a runaway watcher cannot loop the machine. A watcher that
errors three times in a row disables itself and says so.

**Done when.** Dropping a PDF into a folder makes Operator rename, file and log it
with no one at the keyboard — and a watcher pointed at a file that changes every
second does not melt the machine.

---

## 5. It learns your computer — the app atlas

**Why it wins.** The compounding pillar again, at a lower level than playbooks.
A cloud VM starts blank every time and has never seen your apps. Operator sees the
same apps, in the same places, on the same screen, every day — and should get
better at them. *"It's quicker this week than last week"* is a thing no competitor
can say.

**Build.**

- A store keyed by `app` → `intent` → locator, with a confidence score and a last-
  worked timestamp: once it has found "the Export button in Excel", write down how
  it found it.
- Inject the relevant slice of the atlas into the prompt **only for apps present in
  `list_windows`** — never the whole atlas, or context cost eats the gain.
- Every successful `screen_click_text` / UIA hit updates the atlas; two failures in
  a row demote the entry; a demoted entry is re-learned, not reused.
- Surface it in Settings as **What it has learned**, per app, with a Forget button
  per entry. Privacy matters here: the user must be able to see and delete it.
- The atlas is per machine. When driving a remote node, use that node's atlas.

**Done when.** The same task in the same app measurably needs fewer screenshots
and fewer steps on its fifth run than its first, and the Settings panel can show
the user why.

---

## 6. Proof pack — a run you can show someone

**Why it wins.** Two jobs at once. It closes the trust loop (*what exactly did it
do while I was out?*), and it is **free marketing** — a good-looking single-file
report of an agent doing something real is the thing people screenshot and post.
Per the $30k plan, traffic is the binding constraint on this business, not price.
Build the shareable artefact into the product.

**Build.**

- One self-contained HTML file per run, generated from `audit.js`: the goal, each
  step in plain English, before/after screenshots, files touched, elapsed time,
  model cost, the result, and any approvals or handoffs.
- No external assets — images inlined, styles inlined, opens anywhere.
- Buttons: **Save**, **Copy link to file**, **Open**.
- A redact toggle that blurs a chosen region across every screenshot in the pack,
  so a report can be shared without leaking what was on screen.
- Match the app's dark theme, and put a small "Made by Operator" mark on it.

**Done when.** A finished run produces one HTML file that a non-user can open and
follow, and the redact toggle actually blurs the same region in all of them.

---

## 7. Ask me — answer its questions from your phone

**Why it wins.** Long runs only pay off if they can happen while you are not
there. `ask_human` (#1) is useless if you have to be at the desk to answer it.
`phone.js` is already paired to the user's phone, with a token and a local server.

**Build.**

- When a run blocks on `ask_human`, publish the question to the pending-questions
  endpoint on the existing `phone.js` server, and answer it from a tiny mobile web
  page on the same local address.
- Optional push via a user-supplied ntfy / Pushover topic — **opt-in, off by
  default**, and the question text must never leave the machine unless the user
  turned that on. Say so in the UI.
- Answers are typed or picked from the choices the agent offered.
- A question times out on a setting and the run parks rather than hanging forever.
- No new server, no new port, no account.

**Done when.** A task started before leaving the house blocks, buzzes the phone,
is answered from the couch, and finishes.

---

## 8. Verify — it doesn't get to say "done" on its own say-so

**Why it wins.** The single most common complaint about every computer-use agent
is that it reports success it did not achieve. Fixing that is worth more than any
new capability, and it is nearly free.

**Build.**

- Before a run is allowed to report success, a **second, cheap pass** (Haiku by
  default, or the current NIM model) gets: the original goal, the final screen,
  and the list of actions taken. It answers one question — was the goal actually
  met?
- On "no", the run continues with that critique injected, up to a bounded number
  of retries.
- The verdict is shown in the UI and written to the audit log and the proof pack.
- Dry runs are verified too — against what *would* have happened.
- Setting to turn it off for speed, on by default.

**Done when.** A task told to do something impossible reports failure with a
reason instead of a confident summary — and the check costs a cent or less.

---

# TIER 3 — Remove the ceilings

## 9. A brain that needs no subscription and no internet

**Why it wins.** Two problems, one fix. Commercially: today the default brain is
the buyer's own Claude login, which is friction at the till and a dependency
outside our control — a $49 app whose first run says "log into Claude first" loses
sales. Practically: "works with no internet" is a claim no cloud competitor can
ever make.

**Build.**

- `nim.js` is already an OpenAI-compatible tool-calling loop. Add a **local
  endpoint** brain — Ollama / LM Studio / llama.cpp server — as a third option
  with its own base URL, no key, and auto-detection of a server on the usual
  local ports.
- List the locally installed models in the picker, tagged like the NIM ones, with
  the same honesty the README already applies: mark which can call tools and which
  can see, and steer the blind ones to the text tools.
- An **offline mode** banner: when there is no internet and a local brain is
  selected, everything except `browser_*` and `email_*` still works. Say that
  plainly rather than failing oddly.
- Write a short first-run path: no Claude, no key, one local model → a working
  agent in three clicks.

**Done when.** With the network cable out and Ollama running, Operator completes a
real desktop task end to end.

## 10. A fleet, not a laptop

**Why it wins.** The remote node already turns one spare laptop into the agent's
computer. Make it a *list* and the story changes from a feature to a product
category: old hardware in a cupboard becomes a workforce, at no monthly cost. The
competitor charges per VM, per month, forever.

**Build.**

- Promote the single `OPERATOR_REMOTE_URL` / `OPERATOR_REMOTE_TOKEN` pair into a
  saved list of machines in `store.js`: name, address, token, last seen, status.
- A machine picker per bot, and per run, defaulting to "this computer".
- Health: ping each node, show online/offline, and fail a run with a clear message
  when its machine is unreachable — not a stack trace.
- One task runs on one machine (one mouse, one screen — that rule stands), but
  different bots may hold different machines at the same time.
- Each machine keeps its own app atlas (#5) and its own playbooks (#3).
- Keep the security warning from the README loud in this UI: the token is the only
  thing protecting that machine and it travels in plain HTTP.

**Done when.** Two nodes are paired, two bots run at once on different machines,
and unplugging one produces a clean, readable failure.

## 11. Read the screen instead of photographing it

**Why it wins.** Speed and cost, which decide whether anyone uses this daily.
`uia.ps1` already exists. A UI Automation tree is text: it is 5–10× cheaper than
a screenshot, more accurate than pixel-hunting, and does not care about DPI or
theme. `browser.js` already made exactly this bet for web pages and it is the
reason browser work is fast.

**Build.**

- `screen_read` should return a **structured UIA tree** — controls, names, roles,
  values, bounds — as its primary path, with OCR/screenshot as the fallback when
  an app has no accessibility surface (Electron apps, games, remote desktop).
- `screen_click_text` resolves through the tree first and only falls back to
  pixels, and says which path it used so the atlas (#5) can learn from it.
- Teach the SYSTEM_PROMPT the ladder: tree → text → screenshot, and to stop taking
  screenshots it does not need.
- Measure it. Put a before/after on a fixed benchmark task in `bench.js`: tokens
  per task and wall-clock. If it is not meaningfully cheaper, it is not done.

**Done when.** A representative desktop task completes with at least half the
screenshots it takes today, and `bench.js` proves it.

---

# Positioning — the claims these unlock

Write these into the empty state, Settings, the site, and the demo video. Each one
is true only after the item ships, and **none of them can be copied by a cloud VM**:

- **Take over any time.** It hands you the keyboard for the bits only you can do —
  your logins, your call — then carries on. *(#1)*
- **Undo what it did.** One button. *(#2)*
- **The second time is free.** It compiles a finished job into a playbook that
  runs with no model at all — and repairs itself when the screen changes. *(#3)*
- **It runs on events, not just on a timer.** *(#4)*
- **It gets faster at your computer every week.** *(#5)*
- **A report you can show someone.** *(#6)*
- **Answer it from your phone.** *(#7)*
- **It doesn't claim work it didn't do.** *(#8)*
- **No subscription, no internet, no account.** *(#9)*
- **Turn the old laptop in the cupboard into a worker.** *(#10)*
- **Your machine. Your apps. Your files. Nothing leaves.** *(always)*

---

# Order of work

Impact per hour, and each one leaves the app shippable:

1. **#8 Verify** — smallest, fixes the loudest complaint, do it first.
2. **#1 Take the wheel** — the demo that sells the app. Film it.
3. **#2 Rewind** — the objection-killer. Pairs with dry run in the copy.
4. **#3 Replay** — the biggest long-term win; needs `audit.js` solid first.
5. **#11 UIA-first** — makes 3 and 5 much more reliable, so do it before 5.
6. **#5 App atlas**, then **#4 Watchers**.
7. **#6 Proof pack**, **#7 Ask me on phone**.
8. **#9 Local brain**, **#10 Fleet**.

Stop and ship at any numbered boundary. 1–4 alone is a different product from
anything else on sale.

---

# For the agent picking this up

- Read `BEAT-GROKBOT.md` first for the master context and the existing backlog.
  Do not implement its items from this file.
- Read `README.md`, then `agent.js`, `main.js`, `store.js`, `audit.js` and
  `desktop.js` before writing anything.
- Pick **one** numbered item. Say which one, and what you are about to change,
  before you change it.
- Add alongside; do not refactor what already works.
- `node --check` every file you touch. Then `npm start`, run a real task, confirm
  the app boots clean and nothing that worked before is broken.
- Commit that one item, with a message in the style of the existing log
  (`Dry run: rehearse a task without changing anything`).
- Then stop and report: what shipped, what you deliberately left out, and what it
  cannot do — in plain words, the way the README talks.
