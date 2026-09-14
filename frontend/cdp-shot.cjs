const args = process.argv.slice(2);
const [url, out] = args;

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const profile = '/tmp/cdp-' + crypto.randomBytes(6).toString('hex');
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + profile,
  '--remote-debugging-port=19244', '--window-size=900,1400', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 19244, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}
let seq = 0;
const pending = new Map();
let ws;
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function connect(wsUrl) {
  ws = new WebSocket(wsUrl);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    }
  };
  return new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
}
async function evalJs(expr) {
  const { result } = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) return 'ERR:' + JSON.stringify(result.exceptionDetails.exception?.description || '');
  return result.value;
}
async function waitFor(expr, label, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const v = await evalJs(expr);
    if (v) return v;
    await sleep(300);
  }
  console.log('  WAIT TIMEOUT:', label);
  return null;
}
async function setVal(sel, value) {
  const r = await evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'missing';
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  if (r !== 'ok') console.log('  setVal', sel, '->', r);
}
async function nextStep() {
  const r = await evalJs(`(() => {
    const b = document.querySelector('.wizard-nav .btn-primary');
    if (!b) return 'no-next';
    if (b.disabled) return 'disabled';
    b.click();
    return 'clicked';
  })()`);
  if (r !== 'clicked') console.log('  next ->', r);
}

(async () => {
  let t = null;
  for (let i = 0; i < 40; i++) {
    try {
      const x = await getJson('/json');
      t = x.find((a) => a.type === 'page' && (a.url.includes('localhost') || a.url === 'about:blank'));
      if (t) { await connect(t.webSocketDebuggerUrl); break; }
    } catch {}
    await sleep(250);
  }
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(3000);

  // open builder
  await waitFor(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'create assert');
    if (b) { b.click(); return true; }
    return false;
  })()`, 'plus button');
  await sleep(500);

  await waitFor(`!!document.querySelector('.wizard-head h2')`, 'wizard head');

  // step 0 goal
  await setVal('.goal-input', 'train 4x a week for 30 days');
  await sleep(150);
  await nextStep();
  await sleep(350);

  // step 1 stake -> type an amount directly
  await waitFor(`!!document.querySelector('.stake-amount-input')`, 'stake amount input');
  await setVal('.stake-amount-input', '0.1');
  await sleep(250);
  await nextStep();
  await sleep(350);

  // step 2 referee
  await waitFor(`!!document.querySelector('.toggle-address')`, 'address toggle');
  await evalJs(`(() => {
    const t = document.querySelector('.toggle-address');
    if (t && !document.querySelector('.referee-address-input')) t.click();
  })()`);
  await sleep(250);
  await setVal('.referee-address-input', '0xE41113FbE2F1F8FB7A62d1E9b07Cb409A291f296');
  await sleep(400);
  await nextStep();
  await sleep(350);

  const info = await evalJs(`({
    heading: document.querySelector('.wizard-head h2')?.textContent || '',
    slide: document.querySelectorAll('.slide-assert').length,
    review: !!document.querySelector('.review-card'),
    step2body: document.querySelector('.friend-choice-list') ? 'has-friends' : document.querySelector('.referee-address-input') ? 'has-addr' : 'none',
    error: [...document.querySelectorAll('.create-form p')].map(p=>p.textContent).join(' | ')
  })`);
  console.log('final:', JSON.stringify(info));

  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(data, 'base64'));
  console.log('saved', out);
  chrome.kill();
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  chrome.kill();
  process.exit(1);
});
