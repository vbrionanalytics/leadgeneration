import { describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';
process.env.N8N_WEBHOOK_SECRET = 'n8n-shared-secret';
process.env.N8N_BASE_URL = 'https://n8n.dealpost.co.in';
process.env.API_URL = 'https://leadgen.example.test';

const calls: { url: string; headers: any; body: any }[] = [];
vi.stubGlobal('fetch', async (url: any, init: any) => {
  calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
  return new Response('{"accepted":true}', { status: 200 });
});
const { dispatchToN8n } = await import('./services/integrations');

describe('n8n dispatch', () => {
  it('calls the right webhook with the shared secret and callback URL', async () => {
    await dispatchToN8n('emailSend', { emailId: 'e1' });
    expect(calls[0].url).toBe('https://n8n.dealpost.co.in/webhook/leadgen-email-send');
    expect(calls[0].headers['X-LeadGen-Key']).toBe('n8n-shared-secret');
    expect(calls[0].body).toEqual({ emailId: 'e1', callbackBaseUrl: 'https://leadgen.example.test/api/integrations/n8n' });
  });
  it('paths match the five workflows', async () => {
    for (const f of ['discovery', 'analysis', 'emailGenerate', 'marketplace'] as const) await dispatchToN8n(f, {});
    expect(calls.slice(1).map((c) => c.url.split('/').pop())).toEqual(['leadgen-discovery', 'leadgen-analysis', 'leadgen-email-generate', 'leadgen-marketplace']);
  });
});
