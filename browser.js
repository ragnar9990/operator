// browser.js — the agent's "computer": one persistent Chromium it fully controls.
// Persistent profile means logins (YouTube, etc.) stick between sessions.

const path = require('path');
const { chromium } = require('playwright');

const VIEWPORT = { width: 1280, height: 800 };

let context = null;
let page = null;
let onFrame = null; // callback(base64Png) so the UI can show a live view

function setFrameListener(cb) {
  onFrame = cb;
}

// Playwright ships its own Chromium build. It renders the web fine, but it is
// not Google Chrome: the brand strings differ, it carries the automation flag,
// and sign-in pages that check for either will refuse it — which is what makes
// "log in to my account" fail when everything else works. Real Chrome is the
// same browser a person here would use, so prefer it and keep Chromium only as
// a fallback for machines that do not have Chrome installed.
const LAUNCH = {
  headless: false, // a real, visible window — this is its computer
  viewport: VIEWPORT,
  deviceScaleFactor: 1, // keep screenshot pixels == click coordinates
  // Drop the flag that makes Chrome announce it is being driven by a test tool.
  ignoreDefaultArgs: ['--enable-automation'],
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
  ],
};

let usingChrome = null; // null until the first launch tells us

async function ensureBrowser(userDataDir) {
  if (page && !page.isClosed()) return page;

  try {
    context = await chromium.launchPersistentContext(userDataDir, { ...LAUNCH, channel: 'chrome' });
    usingChrome = true;
  } catch (err) {
    context = await chromium.launchPersistentContext(userDataDir, LAUNCH);
    usingChrome = false;
  }

  // Even without the automation flag, the driver still sets this. A browser a
  // person is sitting at does not have it.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  page = context.pages()[0] || (await context.newPage());
  await page.setViewportSize(VIEWPORT);

  // Follow the active tab if the site opens a new one.
  context.on('page', (p) => {
    page = p;
    p.setViewportSize(VIEWPORT).catch(() => {});
  });

  return page;
}

// Take a viewport screenshot and push it to the live view.
async function snap() {
  if (!page || page.isClosed()) return null;
  const buf = await page.screenshot({ type: 'png' });
  const b64 = buf.toString('base64');
  if (onFrame) onFrame(b64, page.url());
  return b64;
}

// Let the page settle after an action before we look again.
//
// Deliberately impatient: waiting for networkidle meant every click on a page
// with analytics or a live feed burned the full timeout, so we settle for the
// DOM being ready and a short beat for paint. Pages that are still moving get
// caught by the agent taking another look.
async function settle(ms = 100) {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 800 });
  } catch (_) {}
  await page.waitForTimeout(ms);
}

// Pick a value from a dropdown.
//
// Two different things get called a dropdown, and treating them the same is
// why the agent used to get stuck on one:
//
//   A real <select>. Chromium draws its open list OUTSIDE the page — it is not
//   in the DOM, it does not appear in a screenshot, and it cannot be clicked or
//   scrolled at coordinates. Opening it and hunting for the option is hopeless,
//   which is exactly what happens on a long birthday year list. The fix is not
//   to open it at all: set the value directly and let the page see a change.
//
//   A custom one built from divs. That IS in the DOM, so it must be opened —
//   and the option often sits below the fold of its own scrolling list, so it
//   is scrolled into view before being clicked rather than hoping it is
//   already visible.
//
// Returns { ok, how, value } so the caller can report which path worked.
async function pickOption(field, option) {
  if (!page) throw new Error('no page');
  const want = String(option);
  // No regex escaping here on purpose: quotes and backslashes are simply
  // removed, which is safe inside an attribute selector and impossible to get
  // subtly wrong.
  const quoted = String(field).split('"').join('').split(String.fromCharCode(92)).join('');

  // ── a real <select> ──────────────────────────────────────────────
  // `named` means the element was found BY this field's name, so if it has no
  // such option that is a definite answer. The bare `select` at the end is a
  // guess for an unlabelled control, and only worth making when there is one
  // select on the page — otherwise it matches some unrelated dropdown and
  // reports, with total confidence, that the wrong element lacks the option.
  const onlyOneSelect = await page.locator('select').count() === 1;
  const selects = [
    { loc: page.locator(`select[aria-label*="${quoted}" i]`), named: true },
    { loc: page.locator(`select[name*="${quoted}" i]`), named: true },
    { loc: page.locator(`select[id*="${quoted}" i]`), named: true },
    { loc: page.getByLabel(field, { exact: false }), named: true },
    ...(onlyOneSelect ? [{ loc: page.locator('select'), named: false }] : []),
  ];

  for (const { loc, named } of selects) {
    let el;
    try {
      el = loc.first();
      if (!(await el.count())) continue;
      if ((await el.evaluate((n) => n.tagName)) !== 'SELECT') continue;
    } catch { continue; }

    // Exact label, then value, then a forgiving match on the real option text:
    // "1994" should find "1994", and "Jan" should find "January".
    for (const shape of [{ label: want }, { value: want }]) {
      try {
        await el.selectOption(shape, { timeout: 1500 });
        return { ok: true, how: 'select', value: want };
      } catch { /* try the next shape */ }
    }

    try {
      const texts = await el.locator('option').allTextContents();
      const lower = want.toLowerCase();
      const hit = texts.find((t) => t.trim().toLowerCase() === lower)
        || texts.find((t) => t.trim().toLowerCase().startsWith(lower))
        || texts.find((t) => t.trim().toLowerCase().includes(lower));
      if (hit) {
        await el.selectOption({ label: hit.trim() }, { timeout: 1500 });
        return { ok: true, how: 'select', value: hit.trim() };
      }
      // A select found BY NAME whose options do not contain this value is a
      // definite no — say what the choices actually are rather than falling
      // through and inventing a success. A guessed one just moves on.
      if (named) {
        return {
          ok: false,
          error: `"${field}" has no option matching "${want}". It offers: ${texts.map((t) => t.trim()).filter(Boolean).slice(0, 25).join(', ')}`,
        };
      }
    } catch { /* not readable as a select; try the custom path */ }
  }

  // ── a custom dropdown ────────────────────────────────────────────
  const opener = page.getByLabel(field, { exact: false })
    .or(page.getByRole('combobox', { name: field }))
    .or(page.getByRole('button', { name: field }))
    .or(page.getByText(field, { exact: false }))
    .first();

  try {
    await opener.click({ timeout: 3000 });
  } catch {
    return { ok: false, error: `could not find a dropdown called "${field}"` };
  }
  await page.waitForTimeout(220);

  const candidates = [
    page.getByRole('option', { name: want, exact: false }),
    page.locator('[role="option"]').filter({ hasText: want }),
    page.locator('li, [role="menuitem"]').filter({ hasText: want }),
  ];

  for (const loc of candidates) {
    try {
      const el = loc.first();
      if (!(await el.count())) continue;
      // The option is often below the fold of the popup's own scroll area,
      // which is the part plain page-scrolling can never reach.
      await el.scrollIntoViewIfNeeded({ timeout: 2000 });
      await el.click({ timeout: 2500 });
      return { ok: true, how: 'list', value: want };
    } catch { /* next shape */ }
  }

  // Some comboboxes only render their options once you type. Worth one go —
  // but the option still has to be found and clicked afterwards. Typing and
  // pressing Enter blind would report success for a value that does not exist,
  // which is worse than failing: the agent moves on believing it is set.
  try {
    await page.keyboard.type(want.slice(0, 12), { delay: 40 });
    await page.waitForTimeout(250);
    const filtered = page.getByRole('option', { name: want, exact: false }).first();
    if (await filtered.count()) {
      await filtered.scrollIntoViewIfNeeded({ timeout: 1500 });
      await filtered.click({ timeout: 2000 });
      return { ok: true, how: 'typed', value: want };
    }
  } catch { /* nothing matched */ }

  return { ok: false, error: `opened "${field}" but there is no option "${want}" in it` };
}

// Wait for the page to move on, then carry on.
//
// Some steps are not the agent's to do: a code typed on a phone, a QR scanned,
// an approval tapped, a slow upload or payment finishing. Ending the turn to
// report that is the wrong answer twice over — the person has to come back and
// restart it, and by then whatever was half-done has usually timed out.
//
// So instead: watch, and resume the moment the page says the step is finished.
// Nothing here presses anything. It only looks.
//
//   until: 'gone'     — some text disappears (the verification screen clears)
//          'appears'  — some text shows up (a success message)
//          'url'      — the address changes (a redirect after signing in)
//          'change'   — anything on the page changes at all
async function waitForChange({ until = 'change', text = '', seconds = 120 } = {}) {
  if (!page) throw new Error('no page');
  const limit = Math.max(3, Math.min(Number(seconds) || 120, 300));
  const deadline = Date.now() + limit * 1000;
  const startedAt = Date.now();

  const startUrl = page.url();
  const snapshot = async () => {
    try { return (await page.innerText('body')).replace(/\s+/g, ' ').slice(0, 4000); }
    catch { return ''; }
  };
  const startText = until === 'change' ? await snapshot() : '';

  const visible = async (t) => {
    try { return await page.getByText(t, { exact: false }).first().isVisible({ timeout: 800 }); }
    catch { return false; }
  };

  // If we are waiting for something to go and it was never there, the step has
  // already happened — say so rather than sitting for two minutes.
  if (until === 'gone' && text && !(await visible(text))) {
    return { ok: true, why: `"${text}" is not on the page`, waited: 0, url: page.url() };
  }

  while (Date.now() < deadline) {
    await page.waitForTimeout(700);
    const waited = Math.round((Date.now() - startedAt) / 1000);

    try {
      if (until === 'url' && page.url() !== startUrl) {
        return { ok: true, why: `the page moved to ${page.url()}`, waited, url: page.url() };
      }
      if (until === 'gone' && text && !(await visible(text))) {
        return { ok: true, why: `"${text}" is gone`, waited, url: page.url() };
      }
      if (until === 'appears' && text && (await visible(text))) {
        return { ok: true, why: `"${text}" appeared`, waited, url: page.url() };
      }
      if (until === 'change') {
        if (page.url() !== startUrl) {
          return { ok: true, why: `the page moved to ${page.url()}`, waited, url: page.url() };
        }
        const now = await snapshot();
        // A little noise on a page is normal — a clock, a counter. Only a real
        // difference in what is written counts as the step being finished.
        if (now && startText && now.slice(0, 600) !== startText.slice(0, 600)) {
          return { ok: true, why: 'the page changed', waited, url: page.url() };
        }
      }
    } catch { /* mid-navigation; look again next pass */ }
  }

  return {
    ok: false,
    waited: limit,
    url: page.url(),
    error: `Waited ${limit}s and the page did not ${until === 'gone' ? `lose "${text}"` : until === 'appears' ? `show "${text}"` : 'change'}.`,
  };
}

async function closeBrowser() {
  try {
    if (context) await context.close();
  } catch (_) {}
  context = null;
  page = null;
}

function getPage() {
  return page;
}

const isRealChrome = () => usingChrome;

module.exports = {
  VIEWPORT,
  isRealChrome,
  ensureBrowser,
  getPage,
  snap,
  settle,
  pickOption,
  waitForChange,
  closeBrowser,
  setFrameListener,
};
