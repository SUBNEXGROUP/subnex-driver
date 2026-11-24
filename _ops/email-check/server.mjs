// SUBNEX email check — asks the customer's mail server whether a mailbox exists.
// No email is ever sent: the conversation stops after RCPT TO and ends with QUIT.
// No dependencies, plain Node 22. Runs in Docker next to the road server, behind Caddy
// (only requests that start with a secret path token reach it).
//
//   GET /check?email=jane@example.com  ->  { result: "valid" | "invalid" | "unknown", reason, ms }
//   GET /health                          ->  { ok: true }
//
// "invalid" only when the mail server clearly said the mailbox (or the domain) does not exist.
// Everything doubtful — timeouts, blocks, greylisting, servers that accept any address — is "unknown",
// and the site lets such addresses through.
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8080);
const SMTP_PORT = Number(process.env.SMTP_PORT || 25); // 25 in real use; changed only by tests
const HELO = process.env.HELO || 'localhost';
const STEP_MS = 10000; // one SMTP reply
const TOTAL_MS = 20000; // whole check
const MAX_BUSY = 4;
const KEEP_MS = { valid: 6 * 3600e3, invalid: 6 * 3600e3, unknown: 10 * 60e3 };

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
// Answers about us (our IP, policy, spam lists) say nothing about the mailbox.
const BLOCKED_RE = /block|spam|reput|polic|denied|refused|rbl|listed|blacklist|client host|not allowed|relay|authenticat|5\.7\.\d|\brate\b|too many|try again|later/i;
// Answers that clearly say the mailbox does not exist.
const NO_MAILBOX_RE = /5\.1\.[0-9]|mailbox (?:not found|unavailable|does not exist|disabled)|no such (?:user|mailbox|recipient)|user (?:unknown|not found|doesn't exist|does not exist)|unknown (?:user|recipient)|recipient (?:not found|unknown|does not exist)|(?:account|address) (?:does not exist|doesn't exist|not found|disabled)|invalid (?:recipient|mailbox)|not a valid mailbox|undeliverable address/i;

const cache = new Map();
let busy = 0;

function connect(host) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port: SMTP_PORT });
    let buf = '';
    let pending = null;
    let ended = null;
    sock.setEncoding('latin1');
    const take = () => {
      if (!pending) return;
      const lines = buf.split(/\r?\n/);
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3}(?: |$)/.test(lines[i])) {
          const reply = lines.slice(0, i + 1);
          buf = lines.slice(i + 1).join('\n');
          const p = pending;
          pending = null;
          clearTimeout(p.timer);
          p.resolve({ code: Number(lines[i].slice(0, 3)), text: reply.join(' ').slice(0, 400) });
          return;
        }
      }
    };
    const read = () =>
      new Promise((res, rej) => {
        if (ended) return rej(ended);
        pending = {
          resolve: res,
          reject: rej,
          timer: setTimeout(() => {
            pending = null;
            rej(new Error('TIMEOUT'));
            sock.destroy();
          }, STEP_MS),
        };
        take();
      });
    const onEnd = (e) => {
      ended = e || new Error('CLOSED');
      if (pending) {
        const p = pending;
        pending = null;
        clearTimeout(p.timer);
        p.reject(ended);
      }
    };
    sock.on('data', (d) => {
      buf += d;
      if (buf.length > 65536) buf = buf.slice(-65536);
      take();
    });
    sock.setTimeout(STEP_MS, () => sock.destroy(new Error('CONNECT_TIMEOUT')));
    sock.once('error', reject);
    sock.once('connect', () => {
      sock.setTimeout(0);
      sock.removeListener('error', reject);
      sock.on('error', onEnd);
      sock.on('close', () => onEnd());
      resolve({
        read,
        cmd: (line) => {
          sock.write(line + '\r\n');
          return read();
        },
        close: () => {
          try {
            sock.write('QUIT\r\n');
          } catch {}
          setTimeout(() => sock.destroy(), 300);
        },
      });
    });
  });
}

async function mailHosts(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    if (!mx.length || (mx.length === 1 && (mx[0].exchange === '' || mx[0].exchange === '.'))) return { hosts: [], none: true };
    return { hosts: mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange) };
  } catch (e) {
    if (e.code !== 'ENOTFOUND' && e.code !== 'ENODATA') return { hosts: [], dnsError: e.code || 'DNS' };
    try {
      await dns.resolve4(domain);
      return { hosts: [domain] }; // no MX record: mail goes to the domain itself
    } catch (e2) {
      if (e2.code === 'ENOTFOUND' || e2.code === 'ENODATA') return { hosts: [], none: true };
      return { hosts: [], dnsError: e2.code || 'DNS' };
    }
  }
}

const ok = (code) => code === 250 || code === 251;

async function probe(host, email, domain) {
  const s = await connect(host);
  try {
    let r = await s.read();
    if (r.code !== 220) return { result: 'unknown', reason: 'greeting ' + r.code };
    r = await s.cmd('EHLO ' + HELO);
    if (r.code !== 250) r = await s.cmd('HELO ' + HELO);
    if (r.code !== 250) return { result: 'unknown', reason: 'helo ' + r.code };
    r = await s.cmd('MAIL FROM:<>');
    if (r.code !== 250) {
      await s.cmd('RSET');
      r = await s.cmd('MAIL FROM:<check@' + HELO + '>');
      if (r.code !== 250) return { result: 'unknown', reason: 'mail_from ' + r.code };
    }
    r = await s.cmd('RCPT TO:<' + email + '>');
    if (ok(r.code)) {
      // Some servers say "yes" to any address — then a "yes" proves nothing.
      const fake = 'subnex-check-' + crypto.randomBytes(6).toString('hex') + '@' + domain;
      const f = await s.cmd('RCPT TO:<' + fake + '>').catch(() => ({ code: 0 }));
      return ok(f.code) ? { result: 'unknown', reason: 'accepts_any' } : { result: 'valid', reason: 'mailbox_exists' };
    }
    if (r.code >= 500 && r.code < 600) {
      if (BLOCKED_RE.test(r.text)) return { result: 'unknown', reason: 'blocked ' + r.code };
      if (NO_MAILBOX_RE.test(r.text)) return { result: 'invalid', reason: 'no_mailbox ' + r.code };
      // An unclear refusal: it counts only if the same server accepts its own postmaster.
      const p = await s.cmd('RCPT TO:<postmaster@' + domain + '>').catch(() => ({ code: 0 }));
      return ok(p.code) ? { result: 'invalid', reason: 'refused ' + r.code } : { result: 'unknown', reason: 'refused_all ' + r.code };
    }
    return { result: 'unknown', reason: 'rcpt ' + r.code };
  } finally {
    s.close();
  }
}

async function check(email) {
  const at = email.lastIndexOf('@');
  const domain = email.slice(at + 1).toLowerCase();
  const m = await mailHosts(domain);
  if (m.none) return { result: 'invalid', reason: 'no_domain' };
  if (!m.hosts.length) return { result: 'unknown', reason: 'dns ' + m.dnsError };
  let last = 'no_connection';
  for (const host of m.hosts.slice(0, 2)) {
    try {
      return await probe(host, email, domain);
    } catch (e) {
      last = String(e?.code || e?.message || 'error').slice(0, 40);
    }
  }
  return { result: 'unknown', reason: last };
}

async function answer(raw) {
  const email = String(raw || '').trim();
  if (!EMAIL_RE.test(email)) return { result: 'invalid', reason: 'format' };
  const key = email.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS[hit.value.result]) return { ...hit.value, cached: true };
  if (busy >= MAX_BUSY) return { result: 'unknown', reason: 'busy' };
  busy++;
  try {
    const value = await Promise.race([
      check(email),
      new Promise((res) => setTimeout(() => res({ result: 'unknown', reason: 'slow' }), TOTAL_MS)),
    ]);
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    return value;
  } finally {
    busy--;
  }
}

export { probe, answer, BLOCKED_RE, NO_MAILBOX_RE };

if (process.env.EMAILCHECK_TEST !== '1') http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/health') return send(200, { ok: true });
    if (url.pathname !== '/check') return send(404, { error: 'NOT_FOUND' });
    const started = Date.now();
    const out = await answer(url.searchParams.get('email')).catch(() => ({ result: 'unknown', reason: 'error' }));
    out.ms = Date.now() - started;
    // The log keeps only the domain, never the address.
    const dom = String(url.searchParams.get('email') || '').split('@').pop().slice(0, 60);
    console.log(new Date().toISOString(), dom, out.result, out.reason, out.ms + 'ms');
    send(200, out);
  })
  .listen(PORT, () => console.log('email check on :' + PORT + ', HELO ' + HELO));
