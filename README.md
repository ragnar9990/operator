# Operator

An AI agent with its own computer. You give it a task in plain English; it uses
this PC to get it done — opening apps, clicking, typing, reading the screen and
running shell commands, the same way a person would.

The brain is **your Claude subscription**, used through the Claude Agent SDK — it
runs off your existing Claude Code login, so there's no separate API key or billing.
Or it can be **any model on NVIDIA NIM** — see below.

## Choosing a brain

The picker next to the send button says which model runs the next task. It has a
search box, because with NVIDIA connected there are around a hundred of them;
type three letters of a name, a vendor or a tag ("vision", "reasoning", "code")
and press Enter to take the top match.

**Claude** is there by default and needs nothing set up.

**NVIDIA NIM** adds everyone else. NVIDIA hosts every other vendor's weights
behind one OpenAI-compatible endpoint and one API key, so a single key gets you
Meta's Llama, Google's Gemma, Mistral, DeepSeek, Qwen, Microsoft's Phi, IBM
Granite, Moonshot's Kimi, Z.ai's GLM, OpenAI's open weights, and NVIDIA's own
Nemotron family — grouped in the picker by whose model it is.

Get a free key at [build.nvidia.com](https://build.nvidia.com) — sign in, open
any model, click **Get API Key** — and paste it into **Settings → Models**. Paste
the key, the whole `Bearer …` line or even the curl sample; it takes the key out
of whatever you give it. It is stored only on this computer, and the panel lists
how many models and vendors it can reach. You can also set it as
`NVIDIA_API_KEY` in the environment instead.

Anything that cannot be a key is refused rather than saved, so a stray paste
can never overwrite a working one. Whether NVIDIA *likes* the key is a different
question: that comes back as a warning, because a refusal there often means the
model it tried is gated rather than that the key is wrong.

The catalog is read live from NVIDIA, not hardcoded, so a model they publish
tomorrow appears in the picker without an update here.

**Check which models run.** NVIDIA's catalog lists everything it has ever
published — around 60 chat models — but it only *serves* a fraction of them to
any given key; the rest answer "not found for account". The button in Settings →
Models tries each one with a single token and takes the dead ones out of the
picker, which takes a minute or two. A model that starts answering 404 during a
task removes itself the same way.

Two things to know when you pick one:

- **Not every open model can call tools**, and a model that cannot call tools
  cannot touch the computer — it can only talk. Those are marked *no tool
  calling* in the picker, and Operator says so plainly instead of letting one
  narrate work it never did.
- **Not every model can see.** Models marked *sees the screen* get the
  screenshots; the rest are told they are blind and steered to the tools that
  return text — `browser_read_text`, `list_windows`, `run_command` — which is
  enough for a great deal of work.

Claude remains the default.

**Coding chats run independently.** Each one has its own folder and its own
run, so you can set a build going in one, switch to another and get on with
something else — a working chat shows a dot in the sidebar, Stop always belongs
to the chat you are looking at, and stopping one leaves the rest alone. Only a
second prompt into the *same* chat waits, because one conversation cannot have
two turns in flight. (The agent side is deliberately still one-at-a-time: there
is one mouse and one screen over there to fight over.)

**The coding side takes these models too.** Claude codes through Claude Code's
own toolset; a NIM model has no such thing, so it gets `Read`, `Write`, `Edit`,
`Bash`, `Grep`, `Glob` and `LS` rebuilt in plain Node and rooted at the chat's
project folder. Same tool names, same transcript, same steps in the sidebar —
only the brain changes. The file tools refuse to touch anything outside the
project folder; the shell is a shell, so it can still go where you send it.

## Talking to it

Click the microphone and just talk. It keeps listening until you stop it.

What you are talking to is **not** one of the agents — it is Operator itself.
It makes agents, names them, writes their personas, files them into
workspaces, reads back what one of them has been saying, and hands real work to
whichever agent should do it:

- *"Make me a workspace called client work."*
- *"Create an agent called Receipts that files my receipts by month, and put it
  in there."*
- *"What did the invoices one say?"*
- *"Put Kimi on Opus."*
- *"Tell the invoices agent to download this month and file them by date."*

Work it hands out really runs, on this machine, in the background — through the
same path as a typed task, so the audit log, the rules and the check at the end
all still apply. It tells you it has set the job going rather than pretending to
wait for it; ask it later what that agent said.

Deleting is the one thing it checks before doing. Speech gets misheard and
there is no undo, so it says what it is about to delete and waits for a yes.

It answers in a sentence or two, because everything it says has to be listened
to in real time rather than skimmed.

- **Hearing** is Whisper `large-v3` running locally on the GPU, through
  whisper.cpp. Free, offline, no API key. The model lives in `D:\whisper`
  (not in this folder, and not on C: — it is 3.1 GB and C: is nearly full).
- **Speaking** is [Piper](https://github.com/rhasspy/piper), a small neural
  text-to-speech that runs locally on the CPU. Free, offline, MIT licensed. The
  binary and one 60 MB voice live in `D:\piper\piper`. Measured here: 885ms to
  the first audio on a cold start, **36ms once the process is warm**, and about
  thirteen times faster than real time — so it is generating the end of a
  sentence long before it has finished saying the start of it. The audio streams
  into the app as raw PCM and plays through Web Audio, so there are no temp
  files and no wait for a whole line to finish.
- If Piper is not installed it falls back to the **SAPI voice built into
  Windows**, which is free and instant and sounds like 2009. Everything still
  works; it just sounds worse. Point it elsewhere with `OPERATOR_PIPER_DIR` /
  `OPERATOR_PIPER_MODEL`.

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
| `agent.js` | The brain — builds the tools and the prompt, then hands them to Claude or to NIM |
| `voice.js` | The other brain — hands-free mode, which drives the app itself rather than the computer |
| `piper.js` + `ui/vox.js` | The neural voice: a warm Piper process streaming PCM, played through Web Audio |
| `verify.js` | The second pass that decides whether a run actually met its goal |
| `nim.js` | The other brain — NVIDIA's catalog, and the tool-calling loop that drives it |
| `code.js` | The coding side — Claude Code's own toolset, or NIM with the one below |
| `code-tools.js` | Read/Write/Edit/Bash/Grep/Glob/LS in plain Node, for models that bring none |
| `ui/` | Front end (command box + activity log + live view) |

`agent.js` builds the toolset and the system prompt once and only then decides
who is driving, so the two brains always have identical hands and the UI cannot
tell them apart: `nim.js` emits the same events as the Agent SDK does. Chat
completions are stateless, so a NIM conversation is kept in memory here and
resumed by id — which lasts as long as the app is open, and starts a fresh
thread when it doesn't.

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

The voice lives outside the folder too, for the same reason:

```
D:\piper\piper\piper.exe          from github.com/rhasspy/piper releases (windows_amd64)
D:\piper\piper\voice.onnx         any piper voice from huggingface.co/rhasspy/piper-voices
D:\piper\piper\voice.onnx.json    its config, which carries the sample rate
```

Without it, hands-free mode still works and falls back to the Windows voice.

Point it somewhere else with `OPERATOR_WHISPER_DIR` / `OPERATOR_WHISPER_MODEL`.

## Notes

- First real run may ask you to log into a site inside the agent's browser once.
- The desktop helper starts on first use, not at launch, so a pure web task never
  pays for its ~1s startup.
- It won't magically defeat captchas designed to be unsolvable by bots; it clicks
  the ordinary checkbox / image challenges like a human, which works most of the time.
