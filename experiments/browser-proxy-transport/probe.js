/* Synthetic transport experiment. This is not a chess client or a model test. */
window.kha15Probe = async function ({base, label, scope = 'baseline', skipWarning = false}) {
  const key = 'kha15-synthetic-only-no-provider';
  const permissionNames = ['local-network-access', 'local-network', 'loopback-network'];
  const permissions = await Promise.all(permissionNames.map(async name => {
    try { return {name, state: (await navigator.permissions.query({name})).state}; }
    catch (error) { return {name, error: String(error)}; }
  }));
  const cases = [];
  if (['baseline', 'explicit', 'restricted', 'blocked-origin'].includes(scope)) {
    for (const header of ['Authorization', 'X-Api-Key']) {
      for (const method of ['GET', 'POST']) {
        cases.push({name: `${scope}-${header}-${method}`, header, method, prefix: scope === 'baseline' ? '' : `/${scope}`});
      }
    }
  } else if (scope === 'controls') {
    cases.push(
      {name: 'missing-key-GET', method: 'GET'},
      {name: 'wrong-key-GET', method: 'GET', header: 'X-Api-Key', key: 'deliberately-wrong-synthetic-key'},
      {name: 'credentials-include-GET', method: 'GET', header: 'X-Api-Key', credentials: 'include'},
      {name: 'synthetic-SSE-POST', method: 'POST', header: 'X-Api-Key', stream: true}
    );
  } else { throw new Error('Unknown probe scope'); }
  const rows = [];
  for (const test of cases) {
    const headers = {Accept: 'application/json'};
    if (test.header) headers[test.header] = test.header === 'Authorization' ? `Bearer ${key}` : (test.key || key);
    if (skipWarning) headers['ngrok-skip-browser-warning'] = 'kha15';
    if (test.method === 'POST') headers['Content-Type'] = 'application/json';
    const caseID = `${label}-${test.name}`;
    const url = `${base.replace(/\/$/, '')}${test.prefix || ''}/v1/${test.method === 'GET' ? 'models' : 'chat/completions'}?case=${encodeURIComponent(caseID)}`;
    const start = performance.now();
    const row = {case: caseID, method: test.method, url, credentials: test.credentials || 'omit', requestHeaderNames: Object.keys(headers)};
    try {
      const response = await fetch(url, {
        method: test.method, headers, credentials: test.credentials || 'omit', mode: 'cors', cache: 'no-store',
        signal: AbortSignal.timeout(7000),
        ...(test.method === 'POST' ? {body: JSON.stringify({model: 'kha15-synthetic', messages: [{role: 'user', content: 'SYNTHETIC TRANSPORT FIXTURE ONLY'}], stream: !!test.stream})} : {})
      });
      row.status = response.status;
      row.ok = response.ok;
      row.responseType = response.type;
      row.body = await response.text();
      row.readable = true;
      row.syntheticSSEComplete = test.stream ? row.body.includes('data: [DONE]') : null;
    } catch (error) {
      row.readable = false;
      row.error = {name: error.name, message: error.message};
    }
    row.elapsedMs = Math.round(performance.now() - start);
    rows.push(row);
  }
  return {
    utc: new Date().toISOString(), label, sourceOrigin: location.origin,
    userAgent: navigator.userAgent, secureContext: isSecureContext, permissions,
    uaData: navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platform', 'platformVersion']) : null,
    scope, rows
  };
};
