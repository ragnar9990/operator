/* Operator — product site.
   Two jobs: swap the screenshot in the viewer, and be honest about the fact
   that checkout is not wired up yet. No scroll-triggered entrances, no
   decorative motion — the screenshots carry the page. */

const SHOTS = {
  run: {
    src: 'img/app-run.png', w: 1440, h: 900,
    alt: 'A finished job in Operator, with its five commands listed and a plain-English summary.',
    cap: 'The five commands it ran, timestamped — then what happened, in a sentence.',
  },
  rail: {
    src: 'img/app-rail.png', w: 1440, h: 900,
    alt: 'Operator with three agents in the sidebar — Operator, Bookkeeper and Inbox — each with their own chats.',
    cap: 'Keep separate agents for separate jobs. Each has its own memory, its own logins and its own browser.',
  },
  audit: {
    src: 'img/app-audit.png', w: 880, h: 700,
    alt: "Operator's audit log: filters, export buttons, and rows showing each action with its tool and duration.",
    cap: 'Every action, filterable and exportable — with secrets replaced by a fingerprint before they reach the disk.',
  },
};

const img = document.getElementById('viewerImg');
const cap = document.getElementById('viewerCap');
const tabs = [...document.querySelectorAll('.vtab')];

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const shot = SHOTS[tab.dataset.shot];
    if (!shot) return;
    tabs.forEach((t) => {
      const on = t === tab;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-pressed', String(on));
    });
    // width/height go with the src so the frame does not jump between shots
    // of different proportions while the new one loads.
    img.width = shot.w;
    img.height = shot.h;
    img.src = shot.src;
    img.alt = shot.alt;
    cap.textContent = shot.cap;
  });
});

// Preload the other two so switching is instant rather than a flash of nothing.
for (const key of Object.keys(SHOTS)) {
  const pre = new Image();
  pre.src = SHOTS[key].src;
}

/* ── buying ────────────────────────────────────────────────────────
   There is no checkout yet. Rather than dead-ending on an anchor that does not
   exist, the button says so and sends you to the one thing that does work. */

const email = document.getElementById('earlyEmail');
const msg = document.getElementById('earlyMsg');

document.getElementById('buyBtn').addEventListener('click', () => {
  msg.classList.remove('is-bad');
  msg.textContent = 'Checkout opens at launch. Leave your email and you get the $49 launch price.';
  email.focus({ preventScroll: true });
});

document.getElementById('earlyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  msg.classList.remove('is-bad');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim())) {
    msg.textContent = 'That address will not reach you. Check it and try again.';
    msg.classList.add('is-bad');
    email.focus();
    return;
  }

  msg.textContent = 'Not wired up yet — this list needs a backend before it can hold anything.';
  msg.classList.add('is-bad');
});
