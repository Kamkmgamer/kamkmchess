import { describe, expect, it } from 'vitest';
import { createConnectionProfile, createFirstRequestDisclosure } from '../../../src/providers/connections';

describe('first-request disclosure', () => {
  it('CON-07 supplies provider rules, consequences, quota use and the configured destination', async () => {
    const profile = await createConnectionProfile({ id: 'anthropic', name: 'Claude API', provider: 'anthropic' });
    const view = createFirstRequestDisclosure(profile);

    expect(view.destinationUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(view.body).toContain('directly from your browser');
    expect(view.body).toContain('quota or paid credits');
    expect(view.body).toContain('account restrictions, suspension, or loss of access');
    expect(view.links).toContainEqual(expect.objectContaining({
      href: 'https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use',
    }));
    expect(view.notices.join(' ')).toContain('Zero Data Retention');
    expect(view.notices.join(' ')).toContain('does not establish CORS');
  });

  it('CON-07 describes an overridden provider destination by its configured endpoint', async () => {
    const profile = await createConnectionProfile({
      id: 'openai-proxy',
      name: 'OpenAI via proxy',
      provider: 'openai',
      baseUrl: 'https://proxy.example.test/v1',
    });
    const view = createFirstRequestDisclosure(profile);

    expect(view.destinationUrl).toBe('https://proxy.example.test/v1/responses');
    expect(view.body).toContain('https://proxy.example.test/v1/responses');
    expect(view.body).not.toContain('directly from your browser to OpenAI');
    expect(view.body).toContain('endpoint operator');
    expect(view.links).toContainEqual(expect.objectContaining({ href: 'https://openai.com/policies/services-agreement/' }));
  });

  it('CON-07 calls out a separately configured catalog origin and its authentication', async () => {
    const profile = await createConnectionProfile({
      id: 'openai-catalog-proxy',
      name: 'OpenAI with catalog endpoint',
      provider: 'openai',
      catalogUrl: 'https://catalog.example.test/v2/models',
    });
    const view = createFirstRequestDisclosure(profile);

    expect(view.catalogUrl).toBe('https://catalog.example.test/v2/models');
    expect(view.notices.join(' ')).toContain('https://catalog.example.test/v2/models');
    expect(view.notices.join(' ')).toContain('authentication');
  });
});
