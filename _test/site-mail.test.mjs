// Сайт_письма.gs в чистом node: разбор адреса, очистка цитаты, передача ответов клиентов в чат
// и ответ оператора в ту же цепочку. Google-объекты подменяются.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '_intake', 'Сайт_письма.gs'), 'utf8');
const store = {};
const calls = [];
const sent = [];
const PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => store[k] ?? null, setProperty: (k, v) => { store[k] = v; } }) };
const Logger = { log: () => {} };
const LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
const Session = { getEffectiveUser: () => ({ getEmail: () => 'info@subnex.co.uk' }) };
const now = Date.now();
const msg = (id, from, to, body, ageH = 1) => ({
  getId: () => id, getFrom: () => from, getTo: () => to, getCc: () => '', getSubject: () => 'Re: Collection confirmed',
  getDate: () => new Date(now - ageH * 3600e3), getPlainBody: () => body,
  reply: (text, opts) => sent.push({ how: 'reply', id, text, from: opts.from }),
});
const messages = [
  msg('m1', 'SUBNEX <collections@subnex.co.uk>', 'ann@example.com', 'You are booked in'),
  msg('m2', 'Ann Smith <Ann@Example.com>', 'SUBNEX <collections@subnex.co.uk>',
    'Can you come on Saturday?\n\nThanks, Ann\n\nOn Mon, 5 Oct 2026 at 20:00, SUBNEX <collections@subnex.co.uk>\nwrote:\n> You are booked in'),
  msg('m3', 'Stranger <x@example.org>', 'collections@subnex.co.uk', 'Hello?'),
  msg('m4', 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'collections@subnex.co.uk', 'Bounce'),
  msg('m5', 'Old <old@example.com>', 'collections@subnex.co.uk', 'Too old', 72),
];
const GmailApp = {
  search: () => [{ getMessages: () => messages }],
  getAliases: () => ['collections@subnex.co.uk'],
  getMessageById: (id) => messages.find((m) => m.getId() === id) || null,
  sendEmail: (to, subject, text, opts) => sent.push({ how: 'new', to, subject, from: opts.from }),
};
const UrlFetchApp = {
  fetch: (url, o) => {
    const body = JSON.parse(o.payload);
    const name = url.split('/rpc/')[1];
    calls.push({ name, body });
    let r = {};
    if (name === 'subnex_email_inbound') r = { ok: true, matched: body.p_data.from === 'ann@example.com' };
    if (name === 'subnex_email_worker' && body.p_action === 'claim')
      r = { jobs: [
        { id: 'j1', to: 'ann@example.com', subject: 'Re: Collection confirmed', text: 'See you Saturday', html: '<p>x</p>', reply_ref: 'm2' },
        { id: 'j2', to: 'bob@example.com', subject: 'Collection confirmed', text: 'Booked', html: '<p>y</p>' },
        { id: 'j3', to: 'cat@example.com', subject: 'Re: Hi', text: 'Lost thread', html: '<p>z</p>', reply_ref: 'gone' },
      ] };
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify(r) };
  },
};
const ScriptApp = { getProjectTriggers: () => [] };
const fn = new Function('PropertiesService', 'Logger', 'LockService', 'Session', 'GmailApp', 'UrlFetchApp', 'ScriptApp',
  src + '\nreturn { сайтАдрес, сайтИмя, сайтЧистыйТекст, сайтВходящие, сайтОтправлять };');
const G = fn(PropertiesService, Logger, LockService, Session, GmailApp, UrlFetchApp, ScriptApp);
let pass = 0, fail = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log((ok ? 'ok   ' : 'FAIL ') + n + (ok ? '' : ' got ' + JSON.stringify(got))); };

eq('адрес из «Имя <почта>»', G.сайтАдрес('Ann Smith <Ann@Example.com>'), 'ann@example.com');
eq('адрес без имени', G.сайтАдрес(' bob@x.org '), 'bob@x.org');
eq('имя', G.сайтИмя('"Ann Smith" <ann@example.com>'), 'Ann Smith');
eq('цитата Gmail в две строки срезана', G.сайтЧистыйТекст('Saturday please\n\nOn Mon, 5 Oct 2026 at 20:00, SUBNEX <collections@subnex.co.uk>\nwrote:\n> old'), 'Saturday please');
eq('цитата Outlook срезана', G.сайтЧистыйТекст('Yes thanks\r\n\r\nFrom: SUBNEX <collections@subnex.co.uk>\r\nSent: Monday'), 'Yes thanks');
eq('Sent from my iPhone срезано', G.сайтЧистыйТекст('Ok\n\nSent from my iPhone'), 'Ok');
eq('строки с > срезаны', G.сайтЧистыйТекст('Fine\n> quoted'), 'Fine');
eq('обычный текст цел', G.сайтЧистыйТекст('Line 1\nLine 2'), 'Line 1\nLine 2');

const passed = G.сайтВходящие();
const inbound = calls.filter((c) => c.name === 'subnex_email_inbound').map((c) => c.body.p_data);
eq('в чат передан только ответ клиента с сайта', passed, 1);
eq('отправлены на сервер: клиент и незнакомец (сервер сам решает)', inbound.map((d) => d.message_id), ['m2', 'm3']);
eq('текст без цитаты', inbound[0].body, 'Can you come on Saturday?\n\nThanks, Ann');
eq('имя отправителя', inbound[0].from_name, 'Ann Smith');
calls.length = 0;
G.сайтВходящие();
eq('повторный проход ничего не шлёт', calls.filter((c) => c.name === 'subnex_email_inbound').length, 0);

store['сайтВходящиеВремя'] = String(Date.now());
G.сайтОтправлять();
eq('ответ — в ту же цепочку, с collections@', sent[0], { how: 'reply', id: 'm2', text: 'See you Saturday', from: 'collections@subnex.co.uk' });
eq('обычное письмо — новым', sent[1].how + ' ' + sent[1].to, 'new bob@example.com');
eq('цепочка не найдена — новым письмом', sent[2].how + ' ' + sent[2].to + ' ' + sent[2].subject, 'new cat@example.com Re: Hi');
eq('все три отмечены отправленными', calls.filter((c) => c.body.p_action === 'done' && c.body.p_data.ok).map((c) => c.body.p_data.id), ['j1', 'j2', 'j3']);
console.log(`${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
