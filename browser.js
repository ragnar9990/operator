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
  closeBrowser,
  setFrameListener,
};
