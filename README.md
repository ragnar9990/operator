# Operator

An AI agent with its own computer. You give it a task in plain English; it uses
this PC to get it done — opening apps, clicking, typing, reading the screen and
running shell commands, the same way a person would.

The brain is **your Claude subscription**, used through the Claude Agent SDK — it
runs off your existing Claude Code login, so there's no separate API key or billing.

## Talking to it

Click the microphone in the command bar and just talk. It transcribes what you
said, runs it, and reads the answer back.

- **Hearing** is Whisper `large-v3` running locally on the GPU, through
  whisper.cpp. Free, offline, no API key. The model lives in `D:\whisper`
  (not in this folder, and not on C: — it is 3.1 GB and C: is nearly full).
- **Speaking** is the SAPI voice built into Windows.

It works out where a sentence ends by watching the microphone level, calibrating
against your room tone first, and keeping a third of a second of audio from
before you started talking so the first word never clips. It mutes itself while
speaking, so it never transcribes its own reply back in as an instruction.

A transcript needs at least two words before it will run as a task — a stray
noise should not be able to start something on a real computer.

The first click on the microphone loads large-v3 onto the GPU, which takes a few
seconds; after that a sentence comes back in well under a second. The model
stays loaded in a local whisper.cpp server between utterances.

## Giving it a different computer

Operator can drive another Windows machine on your network instead of this one —
a spare laptop becomes its computer, the way Grok or Codex have theirs. Nothing
happens on your own screen, and your mouse and keyboard stay yours.

**On the laptop**

1. Copy the `operator-node-package` folder across (37 KB, three files).
2. Right-click `start-operator-node.cmd` and choose **Run as administrator**.
   Administrator matters twice over: accepting connections from another machine
   needs it, and so does sending input to windows that are themselves elevated.
3. It prints an address and a token. Leave the window open.

If it says LOCALHOST ONLY, it is not running as administrator and your other
machine will not be able to reach it. You will also need to let the port through
Windows Firewall on the laptop:

```powershell
New-NetFirewallRule -DisplayName "Operator node" -Direction Inbound -LocalPort 8391 -Protocol TCP -Action Allow
```

If the node refuses to start and mentions antivirus, that machine needs the same
Defender exclusion this one does, for the folder you copied across.

**On this machine**

Set the two values before launching Operator:

```powershell
$env:OPERATOR_REMOTE_URL = "http://192.168.1.50:8391"
$env:OPERATOR_REMOTE_TOKEN = "the-token-it-printed"
npm start
```

From then on every screen tool — screenshots, clicks, typing, `list_windows`,
`launch_app`, `run_command` — acts on the laptop. The agent is told it is driving
another machine so it stops reaching for the local browser.

**What stays on this machine:** the voice (your microphone is here), the chat,
and the `browser_*` Chromium. For web work on the laptop, it opens a browser over
there with `launch_app` and drives it by sight.

**Worth knowing:** the token is the only thing standing between your network and
control of that laptop, and it travels in plain HTTP. That is a reasonable trade
on a home network you trust, and a bad idea on a shared or public one. Anyone on
the network who has the token can drive the machine.

## What it can touch

Two sets of hands, and it picks between them:

- **The desktop** — real mouse and keyboard on your real screens. It screenshots
  a monitor, clicks what it sees, types, switches windows, launches programs and
  runs PowerShell. This is how it does anything that isn't a web page.
- **Its own browser** — a dedicated Chromium with a persistent profile. Web work
  goes here because it can name a button instead of guessing a pixel, and read a
  page as text. Log into YouTube / Gmail in it once and it stays logged in.

Both monitors are supported. Screenshots come back per display, scaled to 1280
wide, and click coordinates use that same space — so what it sees is what it hits.

> **Note:** this version drives the whole machine, not just a browser. It will
> ask before anything destructive and hard to undo — deleting files, spending
> money, posting publicly — and just get on with everything else.

## Install it (it's a real app)

Double-click the installer:

```
C:\Users\c3645\operator\dist\Operator Setup 0.2.0.exe
```

It installs Operator and drops a **desktop shortcut**. From then on you just open
Operator like any other app — no terminal, no `npm start`.

Type a task and hit Run, then watch it work in the live view.

You need to be logged into your Claude account (the same login Claude Code uses)
for the brain to work — you already are.

## Rebuild the app (after code changes)

```powershell
cd C:\Users\c3645\operator
npm install      # first time only
npm run dist     # produces dist\Operator Setup <version>.exe
```

`npm start` still works too, if you just want to run it without installing.

## Try

- `Open Notepad and write me a shopping list for a roast dinner`
- `Tidy my Downloads folder — put the images, installers and PDFs into folders`
- `Go to my latest YouTube video, like it and reply to the top 3 comments`
- `What's currently open on my second monitor?`

## How it's built

| File | Role |
|------|------|
| `main.js` | Electron main; wires the UI to the agent |
| `desktop.js` | The computer — mouse, keyboard, screen capture, windows, shell |
| `desktop-helper.ps1` | The Windows side of that: one long-lived PowerShell process, P/Invoke to user32 |
| `browser.js` | The browser — one persistent Chromium controlled via Playwright |
| `whisper.js` | Hearing — runs whisper.cpp's server so large-v3 stays loaded on the GPU |
| `ui/mic.js` | Capture and voice-activity detection: finds where a sentence ends |
| `speech.js` + `speech-helper.ps1` | Speaking — the Windows SAPI voice |
| `agent.js` | The brain — Claude Agent SDK, holding both toolsets |
| `ui/` | Front end (command box + activity log + live view) |

Desktop input goes through `SendInput` with Unicode scan codes, so typing works
whatever the keyboard layout, and the helper marks itself DPI-aware before it
captures anything — otherwise coordinates drift on a scaled display. There are
**no native modules**, so `npm run dist` never needs a node-gyp rebuild.

## If voice stops working

Whisper lives outside this folder, so a fresh clone needs it put back:

```
D:\whisper\whisper-server.exe     from whisper.cpp release b5130 (CUDA 12.4 build)
D:\whisper\ggml-large-v3.bin      from huggingface.co/ggerganov/whisper.cpp
```

Point it somewhere else with `OPERATOR_WHISPER_DIR` / `OPERATOR_WHISPER_MODEL`.

## Notes

- First real run may ask you to log into a site inside the agent's browser once.
- The desktop helper starts on first use, not at launch, so a pure web task never
  pays for its ~1s startup.
- It won't magically defeat captchas designed to be unsolvable by bots; it clicks
  the ordinary checkbox / image challenges like a human, which works most of the time.
