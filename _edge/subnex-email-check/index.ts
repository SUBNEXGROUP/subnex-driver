// Supabase Edge Function: subnex-email-check. Verify JWT OFF (the site's browser calls it; CORS below).
// The booking form asks: does this mailbox exist? The answer comes from our own mail checker on the
// Hostinger server (_ops/email-check, secret EMAIL_CHECK_URL) — no email is sent to the customer.
// Every answer is logged (subnex_email_check_db), so subnex_web_booking refuses an address the form
// was told does not exist, even if someone skips the form. Per-IP limit: 30 checks an hour.
const ORIGINS = ['https://subnex.co.uk', 'https://www.subnex.co.uk'];
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[A-Za-z]{2,24}$/;
type Result = { result: 'valid' | 'invalid' | 'unknown'; reason?: string };

export async function handleRequest(req: Request): Promise<Response> {
  const origin = req.headers.get('origin') || '';
  const cors = {
    'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  const reply = (status: number, data: unknown) =>
    Response.json(data, { status, headers: { ...cors, 'Cache-Control': 'no-store' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'POST_REQUIRED' });

  let email = '';
  try {
    const body = await req.json();
    email = String(body?.email || '').trim().toLowerCase().slice(0, 200);
  } catch {
    return reply(400, { error: 'BAD_INPUT' });
  }
  if (!EMAIL_RE.test(email)) return reply(200, { result: 'invalid', reason: 'format' });

  const base = Deno.env.get('SUPABASE_URL')?.trim().replace(/\/$/, '');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim();
  const checkUrl = Deno.env.get('EMAIL_CHECK_URL')?.trim().replace(/\/$/, '');
  if (!base || !serviceKey) return reply(200, { result: 'unknown', reason: 'not_configured' });
  const ip = (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0].trim().slice(0, 64);

  const db = async (action: string, data: Record<string, unknown>) => {
    try {
      const r = await fetch(base + '/rest/v1/rpc/subnex_email_check_db', {
        method: 'POST',
        headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_action: action, p_data: data }),
        signal: AbortSignal.timeout(5000),
      });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };

  const gate = await db('gate', { email, ip });
  if (gate?.known === 'invalid') return reply(200, { result: 'invalid', reason: gate.reason });
  if (!gate?.allow || !checkUrl) return reply(200, { result: 'unknown', reason: gate?.reason || 'not_ready' });

  let out: Result = { result: 'unknown', reason: 'no_answer' };
  try {
    const r = await fetch(checkUrl + '/check?email=' + encodeURIComponent(email), { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (['valid', 'invalid', 'unknown'].includes(j?.result)) out = { result: j.result, reason: String(j.reason || '').slice(0, 80) };
  } catch {
    // Checker down or slow: the form lets the address through, bounce handling covers the rest.
  }
  await db('log', { email, ip, ...out });
  // No addresses or IPs in logs.
  return reply(200, out);
}

if (import.meta.main) Deno.serve(handleRequest);
export default { fetch: handleRequest };
