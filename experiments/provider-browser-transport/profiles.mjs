// Only OPTIONS and model-catalog GET requests may reach these provider URLs.
const key = 'kha21-invalid-synthetic-not-a-key';
const bearer = {authorization: `Bearer ${key}`};
const oaExtra = {'openai-organization': 'kha21-synthetic-org', 'openai-project': 'kha21-synthetic-project'};
const routerExtra = {'http-referer': 'https://example.invalid/kha21', 'x-openrouter-title': 'KHA21 synthetic transport', 'x-openrouter-cache': 'false'};
const anthropicBase = {'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true'};
export const profiles = [];
function add(provider, root, routes, variants) {
  for (const [route, method] of routes) for (const [variant, headers] of variants) {
    profiles.push({id: `${provider}-${route.replaceAll('/', '-')}-${variant}`, provider,
      url: root + route, method, headers: {...headers, ...(method === 'POST' ? {'content-type': 'application/json'} : {})}});
  }
}
add('openai', 'https://api.openai.com/v1/', [['models','GET'],['chat/completions','POST'],['responses','POST']],
  [['base',bearer],['scope',{...bearer,...oaExtra}]]);
add('openrouter', 'https://openrouter.ai/api/v1/', [['models','GET'],['chat/completions','POST'],['responses','POST'],['messages','POST']],
  [['base',bearer],['attribution',{...bearer,'http-referer':routerExtra['http-referer'],'x-openrouter-title':routerExtra['x-openrouter-title']}],['attribution-cache',{...bearer,...routerExtra}]]);
profiles.push({id:'openrouter-models-public',provider:'openrouter',url:'https://openrouter.ai/api/v1/models',method:'GET',headers:{}});
add('anthropic', 'https://api.anthropic.com/v1/', [['models','GET'],['messages','POST']],
  [['api-key',{...anthropicBase,'x-api-key':key}],['bearer',{...anthropicBase,...bearer}],
    ['workspace-beta',{...anthropicBase,'x-api-key':key,'anthropic-workspace-id':'kha21-synthetic-workspace','anthropic-beta':'kha21-synthetic-beta'}]]);
export const catalogProfiles = profiles.filter(p => p.method === 'GET');
