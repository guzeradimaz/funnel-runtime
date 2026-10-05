// Browser end-to-end check of the funnel UI in headless Chrome.
// npm run e2e -- [--base https://funnel.guzerchuk.site]   (CHROME_PATH overrides the Chrome binary)
// Walks whatever version is active by step type, so it works for v1, v2 and v3 without knowing the copy.
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg('base', process.env.BASE_URL ?? 'http://localhost:3000');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 860 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(300);
const title = () => page.$eval('main h1', (e) => e.innerText).catch(() => '');
const stepType = () => page.$eval('main .step', (e) => [...e.classList].find((c) => c.startsWith('step-')).slice(5));
const sid = () => page.evaluate(() => localStorage.getItem('funnel:sessionId'));
const progressLabel = () => page.$eval('.progress-label', (e) => e.innerText).catch(() => '');
const submit = async () => {
  await page.click('main button[type=submit], main .btn.primary');
  await settle();
};

/** Answers the current step with a valid value. `branchy` picks options that open conditional steps. */
async function answer(branchy) {
  const type = await stepType();
  if (type === 'single-select') {
    const labels = await page.$$('main .option');
    const texts = await Promise.all(labels.map((l) => l.evaluate((e) => e.innerText)));
    const idx = branchy ? Math.max(0, texts.findIndex((t) => /hybrid|office/i.test(t))) : 0;
    await labels[idx].click();
  } else if (type === 'multi-select') {
    const labels = await page.$$('main .option');
    await labels[0].click();
  } else if (type === 'number') {
    const min = await page.$eval('main input[type=number]', (e) => Number(e.min || 0));
    await page.$eval('main input[type=number]', (e) => (e.value = ''));
    await page.type('main input[type=number]', String(Math.max(min, 2)));
  }
  await submit();
}

const url = (q = '') => `${BASE}/${q}`;

// 1. Fresh session, validation, branch, progress.
await page.goto(url('?variant=A&utm_source=e2e&utm_campaign=e2e_check'), { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear());
await page.goto(url('?variant=A&utm_source=e2e&utm_campaign=e2e_check'), { waitUntil: 'networkidle0' });
check('first screen renders from config', (await stepType()) === 'info', await title());
await submit();
let sawValidation = false;
let sawBranch = false;
let guard = 0;
let midSaved = null;
while ((await stepType()) !== 'result' && guard++ < 20) {
  const type = await stepType();
  if (!sawValidation && type === 'number') {
    await page.$eval('main input[type=number]', (e) => (e.value = ''));
    await submit();
    sawValidation = Boolean(await page.$('main .error'));
  }
  if (/office days/i.test(await title())) sawBranch = true;
  if (guard === 4 && !midSaved) {
    // 2. Refresh in the middle keeps step and progress.
    const before = { t: await title(), p: await progressLabel(), s: await sid() };
    await page.reload({ waitUntil: 'networkidle0' });
    await settle();
    const after = { t: await title(), p: await progressLabel(), s: await sid() };
    check('refresh keeps step, progress and session', JSON.stringify(before) === JSON.stringify(after), `${after.t} ${after.p}`);
    // 3. In-app Back returns to the previous step with the answer pre-filled; browser Back too.
    await page.click('button.back');
    await settle();
    const prefilled = await page.evaluate(
      () => !!document.querySelector('main .option.selected') || !!document.querySelector('main input[type=number]')?.value,
    );
    check('in-app Back keeps the previous answer', prefilled, await title());
    await page.goBack();
    await settle();
    const t2 = await title();
    check('browser Back goes one more step back', t2 !== after.t && t2 !== '', t2);
    await page.goForward();
    await settle();
    midSaved = true;
    continue;
  }
  await answer(true);
}
check('validation message shown for empty number', sawValidation);
check('conditional branch step shown for hybrid/office', sawBranch);
check('result screen reached', (await stepType()) === 'result', await title());
await page.click('main .btn.primary');
await settle();
const recs = await page.$$eval('.recommendations li', (els) => els.length);
check('CTA reveals recommendations', recs > 0, `${recs} items`);
await page.reload({ waitUntil: 'networkidle0' });
await settle();
check('result and CTA state survive refresh', (await page.$$eval('.recommendations li', (els) => els.length)) === recs);

// 4. Overrides and restart.
const s1 = await sid();
await page.goto(url('?variant=zzz'), { waitUntil: 'networkidle0' });
check('unknown ?variant= keeps the session', (await sid()) === s1);
await page.goto(url('?variant=B'), { waitUntil: 'networkidle0' });
const meta = await page.$eval('.funnel-meta', (e) => e.innerText);
check('valid ?variant=B starts a B session', (await sid()) !== s1 && /variant B/.test(meta), meta.split('\n')[0]);
const s2 = await sid();
await page.click('.funnel-meta .link');
await sleep(800);
check('Start over creates a new session', (await sid()) !== s2);

// 5. Internal pages.
await page.setViewport({ width: 1280, height: 1000 });
await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle0' });
const adminOk = (await page.$('.panel b.badge.active')) || (await page.$('input[type=password]'));
check('/admin renders (versions or token prompt)', Boolean(adminOk));
await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle0' });
await sleep(800);
const dashOk = (await page.$('.tile-value')) || (await page.$('input[type=password]'));
check('/dashboard renders (metrics or token prompt)', Boolean(dashOk));

const realErrors = errors.filter((e) => !/401/.test(e));
check('no JavaScript errors in console', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll browser checks passed');
process.exit(failed ? 1 : 0);
