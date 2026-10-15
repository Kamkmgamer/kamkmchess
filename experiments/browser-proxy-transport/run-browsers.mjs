import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

// CDP controls only fresh task-owned browser profiles. Permission overrides set
// ordinary granted/denied states; no CORS, TLS, or local-network checks are disabled.
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextID = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result || {});
      } else if (message.method) {
        if (['Network.loadingFailed', 'Log.entryAdded'].includes(message.method)) this.events.push(message);
        if (message.method === 'Network.responseReceived' && message.params.type === 'Document') {
          const {url, status, mimeType, remoteIPAddress, headers} = message.params.response;
          this.events.push({method: message.method, params: {url, status, mimeType, remoteIPAddress, contentType: headers['content-type'] || headers['Content-Type'], contentLength: headers['content-length'] || headers['Content-Length']}});
        }
      }
    });
    ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Task browser CDP connection closed'));
      }
      this.pending.clear();
    });
  }
  static async connect(port) {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, {once: true}); ws.addEventListener('error', reject, {once: true}); });
    const cdp = new CDP(ws);
    cdp.version = version;
    return cdp;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextID;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 40000);
      this.pending.set(id, {resolve, reject, timer});
      this.ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    });
  }
  async evaluate(expression, sessionId) {
    const result = await this.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
}

const directory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = join(directory, 'evidence');
await mkdir(outputDirectory, {recursive: true});
const publicOrigin = new URL(process.argv[2]).origin;
const corsControlsOnly = process.argv.includes('--cors-controls');
const probeSource = await readFile(join(directory, 'probe.js'), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function navigate(cdp, session, url) {
  const result = await cdp.send('Page.navigate', {url}, session);
  if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
  const deadline = Date.now() + 20000;
  let page;
  while (Date.now() < deadline) {
    try {
      page = await cdp.evaluate('({url:location.href,origin:location.origin,title:document.title,ready:document.readyState,text:document.body?.innerText?.slice(0,2500),buttons:[...document.querySelectorAll("button,a")].map(e=>({text:e.textContent.trim(),tag:e.tagName})).slice(0,15)})', session);
      if (page.origin === new URL(url).origin && page.ready !== 'loading' && page.text?.trim()) return page;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Navigation did not settle: ${JSON.stringify(page)}`);
}

for (const [name, port] of [['chrome', 19222], ['edge', 19223]]) {
  const outputName = corsControlsOnly ? `${name}-cors-controls.json` : `${name}.json`;
  const record = {browser: name, publicOrigin, startedAt: new Date().toISOString(), permissionOverrides: [], pageStates: [], probes: []};
  let cdp;
  let context;
  try {
    cdp = await CDP.connect(port);
    record.protocolVersion = cdp.version;
    context = (await cdp.send('Target.createBrowserContext', {disposeOnDetach: true})).browserContextId;
    const target = await cdp.send('Target.createTarget', {url: 'about:blank', browserContextId: context});
    const session = (await cdp.send('Target.attachToTarget', {targetId: target.targetId, flatten: true})).sessionId;
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);
    await cdp.send('Network.enable', {}, session);
    await cdp.send('Log.enable', {}, session);
    async function setPermission(origin, setting) {
      for (const permission of ['local-network-access', 'local-network', 'loopback-network']) {
        const attempt = {origin, permission, setting};
        try {
          await cdp.send('Browser.setPermission', {permission: {name: permission}, setting, origin, browserContextId: context});
          attempt.applied = true;
        } catch (error) { attempt.applied = false; attempt.error = String(error); }
        record.permissionOverrides.push(attempt);
      }
    }
    async function probe(base, phase, scope, skipWarning = false) {
      const result = await cdp.evaluate(`window.kha15Probe(${JSON.stringify({base, label: `${name}-${phase}`, scope, skipWarning})})`, session);
      record.probes.push(result);
      await writeFile(join(outputDirectory, outputName), JSON.stringify({...record, diagnostics: cdp.events}, null, 2) + '\n');
      process.stdout.write(JSON.stringify({browser: name, phase, scope, permissions: result.permissions, rows: result.rows.map(r => ({case: r.case, status: r.status, readable: r.readable, error: r.error, syntheticSSEComplete: r.syntheticSSEComplete}))}) + '\n');
    }
    await setPermission(publicOrigin, 'granted');
    let page = await navigate(cdp, session, `${publicOrigin}/harness`);
    record.pageStates.push(page);
    // ngrok's browser interstitial, when present, is accepted through its normal
    // visible Visit Site control. Do not use network interception or extra headers.
    if (!page.text?.includes('Synthetic browser-to-proxy transport check')) {
      const found = await cdp.evaluate('(() => { const e=[...document.querySelectorAll("button,a")].find(e=>/visit site/i.test(e.textContent)); if(e){e.click();return true;} return false; })()', session);
      if (found) { await sleep(500); page = await navigate(cdp, session, `${publicOrigin}/harness`); record.pageStates.push(page); }
    }
    if (!page.text?.includes('Synthetic browser-to-proxy transport check')) throw new Error(`Unexpected public harness page: ${JSON.stringify(page)}`);
    await cdp.evaluate(probeSource, session);
    if (corsControlsOnly) {
      for (const scope of ['baseline', 'restricted', 'blocked-origin']) await probe('http://127.0.0.1:18765', 'cors-audit-loopback', scope);
      record.pageStates.push(await navigate(cdp, session, 'https://example.com/'));
      await cdp.evaluate(probeSource, session);
      await setPermission('https://example.com', 'denied');
      for (const scope of ['baseline', 'restricted', 'blocked-origin']) await probe(publicOrigin, 'cors-audit-public-https', scope, true);
      record.completedAt = new Date().toISOString();
      continue;
    }
    await probe('http://127.0.0.1:18765', 'loopback-granted', 'baseline');
    await probe('http://127.0.0.1:18765', 'loopback-granted', 'explicit');
    await probe('http://127.0.0.1:18765', 'loopback-granted', 'controls');
    await setPermission(publicOrigin, 'denied');
    await probe('http://127.0.0.1:18765', 'loopback-denied', 'baseline');
    await setPermission(publicOrigin, 'granted');
    await probe('http://127.0.0.1:18765', 'loopback-regranted', 'baseline');
    await probe('http://localhost:18765', 'localhost-granted', 'baseline');

    record.pageStates.push(await navigate(cdp, session, 'https://example.com/'));
    await cdp.evaluate(probeSource, session);
    await setPermission('https://example.com', 'denied');
    await probe(publicOrigin, 'public-https-reference', 'baseline', true);
    await probe(publicOrigin, 'public-https-reference', 'explicit', true);
    await probe(publicOrigin, 'public-https-reference', 'controls', true);
    record.completedAt = new Date().toISOString();
  } catch (error) {
    record.error = String(error);
    process.exitCode = 1;
    process.stdout.write(JSON.stringify({browser: name, error: record.error}) + '\n');
  } finally {
    if (cdp) {
      record.diagnostics = cdp.events;
      if (context) { try { await cdp.send('Target.disposeBrowserContext', {browserContextId: context}); } catch {} }
      try { await cdp.send('Browser.close'); } catch {}
      cdp.ws.close();
    }
    await writeFile(join(outputDirectory, outputName), JSON.stringify(record, null, 2) + '\n');
  }
}
