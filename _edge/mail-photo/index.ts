// mail-photo: фото водителя для писем клиентам сайта (SQL 84).
// GET ?t=<32 hex> → JPEG из закрытого хранилища photos. Токен знает только адресат письма.
const URL_ = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

Deno.serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method', { status: 405 });
  const t = new URL(req.url).searchParams.get('t') || '';
  if (!/^[0-9a-f]{32}$/.test(t)) return new Response('not found', { status: 404 });
  const r = await fetch(`${URL_}/rest/v1/rpc/subnex_mail_photo`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: t }),
  });
  const path = r.ok ? await r.json() : null;
  if (!path || typeof path !== 'string') return new Response('not found', { status: 404 });
  const img = await fetch(`${URL_}/storage/v1/object/photos/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: H });
  if (!img.ok || !img.body) return new Response('not found', { status: 404 });
  return new Response(img.body, {
    headers: {
      'Content-Type': img.headers.get('Content-Type') || 'image/jpeg',
      'Cache-Control': 'public, max-age=604800',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
