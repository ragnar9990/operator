# Connecting your phone

Operator can read the one-time code a service sends you and finish signing you
in, instead of stopping to ask you to read it out.

It has no line to a phone network of its own. Instead your phone pushes the
message to Operator — which means no app to install, and it works on iPhone as
well as Android.

---

## Turn it on

**Settings → Connectors → Phone → Turn on.** You get an address and a pairing
token. The address only works on your own network, and only with that token.

## iPhone

Shortcuts can do this without anything else installed.

1. Shortcuts → **Automation** → **＋** → **Message** → *Message Contains* (leave
   it broad, or enter "code")
2. Choose **Run Immediately** and turn **Notify When Run** off
3. Add the action **Get Contents of URL**, and set:
   - URL: the address from Settings
   - Method: **POST**
   - Headers: `X-Operator-Token` → your pairing token
   - Request Body: **JSON**, with one field `text` set to **Shortcut Input**

## Android

Any automation app will do — MacroDroid, Tasker, HTTP Shortcuts.

1. Trigger: **SMS received**
2. Action: **HTTP POST** to the address from Settings
3. Header: `X-Operator-Token` → your pairing token
4. Body: `{"from": "[sender]", "text": "[message]"}` using whatever the app calls
   those variables

## Check it worked

Send yourself a text. Settings → Connectors should change from *waiting for your
phone* to *Paired*.

---

## No phone? Use email instead

If a mailbox is connected under the same Connectors tab, Operator looks there
too. Plenty of services send codes by email anyway, and Android SMS-forwarding
apps can put your texts there as well. The phone is checked first, email second.

---

## What it does with a code

**Will:** finish signing you in to something you already have an account with —
two-step verification, confirming an address, a bank OTP you triggered.

**Will not:** clear phone verification on a *new* signup. That check exists to
make sure a person is making the account, and services are good at spotting when
one wasn't. Accounts made that way get closed within days, usually taking
whatever was set up on them.

**It waits.** When Operator reaches a code step it holds there — checking your
phone every second and a half, and email every eight — until the code lands,
then carries straight on. Up to two minutes by default. It does not stop and ask
you to go and read it.

If nothing arrives in that time it says so, and tells you where to look.

**Used once.** A code handed over is marked used, so a retry cannot pick up a
stale one and get stuck.

**Never on disk.** The code goes to the model and into the box it belongs in.
The audit log records that a code was fetched and who sent it, with the number
replaced by a fingerprint.

**Check the sender.** Operator reports who sent the code, and is told to make
sure that matches the service it is signing in to. A code from somewhere
unexpected is one to ask you about, not to type in.

---

## Turning it off

**Turn off** in Settings closes the port and drops anything held in memory. The
listener is also closed when Operator quits. **New token** unpairs any phone
holding the old one — use it if you lose a handset.
