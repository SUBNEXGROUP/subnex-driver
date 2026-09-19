/* SUBNEX chat. No Twilio secrets in this file. All actions are checked by subnex-sms. */
(function () {
  'use strict';
  const T = window.T || ((s) => s);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const codes = {
    ACCESS_DENIED: T('Нет доступа. Администратор должен назначить ваш аккаунт и водителя.'),
    LOGIN_REQUIRED: T('Войдите в аккаунт заново.'),
    NOT_CONFIGURED: T('Сервер ещё не настроен. Проверьте установку по инструкции.'),
    UK_MOBILE_REQUIRED: T('Укажите британский мобильный номер, например 07446 932887.'),
    ADDRESS_REQUIRED: T('Сначала привяжите адрес сбора к переписке.'),
    DRIVER_REQUIRED: T('Назначьте активного водителя.'),
    SLOT_CONFLICT: T('Этот промежуток уже занят или предложен другому клиенту. Выберите свободное время.'),
    SLOT_IN_PAST: T('Выберите будущую дату и время.'),
    OUTSIDE_WORKING_HOURS: T(
      'Время выходит за рабочий график этого дня. Откройте Настройки → Часы и доступ и продлите часы этого дня недели (или выберите время внутри графика).',
    ),
    SLOT_INVALID: T('Проверьте дату и время.'),
    STALE_ADDRESS: T('Адрес или назначение изменились. Обновите переписку и проверьте время заново.'),
    AGREEMENT_REQUIRED: T('Подтвердите, что клиент согласовал дату и время.'),
    CONFIRMED_CHANGE_REQUIRES_AGREEMENT: T('Для переноса нужно отдельное согласие клиента.'),
    USE_CHAT_TO_RESCHEDULE: T('Подтверждённые дата и интервал сохраняются.'),
    ALREADY_SCHEDULED_USE_MANUAL: T('Сбор уже запланирован. Подтверждённое время сохраняется.'),
    OPTED_OUT: T('Клиент отказался от SMS. Отправка заблокирована до его START.'),
    MESSAGE_LENGTH: T('Введите от 1 до 1000 символов.'),
    RATE_LIMIT: T('Достигнут лимит отправки. Попробуйте позже.'),
    REQUEST_ID_REUSED: T('Запрос уже использован с другим текстом. Обновите переписку.'),
    RECENT_DUPLICATE: T('Такое сообщение уже отправлялось в последнюю минуту.'),
    PHONE_HAS_ACTIVE_REQUEST: T('На этот номер уже есть активная заявка. Откройте её переписку.'),
    CREATE_AUTH_USER_FIRST: T('Сначала создайте и подтвердите пользователя в Supabase → Authentication → Users.'),
    CANNOT_DISABLE_YOURSELF: T('Нельзя отключить или понизить собственный аккаунт.'),
    DATABASE_ERROR: T('Сервер не сохранил действие. Обновите экран и проверьте данные.'),
    SERVICE_UNAVAILABLE: T('Нет подтверждения от сервера. Обновите историю перед повторной отправкой.'),
    NETWORK: T('Нет подтверждения от сервера. Текст сохранён в этом окне; повтор использует тот же номер запроса.'),
  };
  Object.assign(codes, {
    CANCELLATION_REQUIRED: T('Подтвердите закрытие именно этой заявки.'),
    CANCELLATION_REASON: T('Выберите причину закрытия.'),
    REQUEST_ALREADY_FINISHED: T('Эта заявка уже завершена. Обновите переписку.'),
  });
  /* Дружелюбное сообщение клиенту о переносе. Английский, как и все письма клиентам. */
  const moveMessage = (address, name, brand, day, start, end) => {
    const when = new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(day + 'T12:00:00Z'));
    return (
      `Hello, this is ${name ? name + ' from ' + brand : brand}.\n\n` +
      `Your clothing collection at ${address.text} has been moved to ${when}, between ${start} and ${end} (UK time).\n\n` +
      `Thank you for letting us know. If this no longer suits you, just reply to this message and we will find another day.\n\n` +
      `Kind regards,\n${name ? name + '\n' : ''}${brand}`
    );
  };
  const collectionStates = {
    new: T('Новая'),
    planned: T('Запланирована'),
    done: T('Выполнено'),
    noanswer: T('Не отвечает'),
    problem: T('Проблема'),
    cancelled: T('Отменена'),
  };
  const resultStatuses = ['done', 'noanswer', 'problem'];
  const collectionState = (a) => collectionStates[a?.status] || a?.status || T('Не указан');
  const isClosed = (a) => !!a && (a.status === 'cancelled' || !!a.collection_cancelled_at);
  const threadState = (t) =>
    (t.closed_request && !t.address_id) || t.address_status === 'cancelled'
      ? T('Заявка закрыта')
      : resultStatuses.includes(t.address_status)
        ? collectionStates[t.address_status]
        : t.date
          ? T('В маршруте · ') + t.date
          : t.offer_state === 'awaiting'
            ? T('Ожидаем YES')
            : T('Согласование');
  Object.assign(codes, { RESULT_REPLACEMENT_REQUIRED: T('Подтвердите замену прежнего результата на отмену.') });
  const cancellationReasons = {
    customer_cancelled: T('Клиент отменил сбор'),
    already_collected: T('Уже забрали'),
    no_bags: T('Мешков для сбора нет'),
    duplicate: T('Повторная заявка'),
    other: T('Другая причина'),
  };
  /* Причина автоматического закрытия (планировщик): в списке выбора её нет, в отчётах — есть. */
  const reasonLabel = (code) => cancellationReasons[code] || (code === 'no_reply' ? T('Не ответил на предложение') : code || '');
  const errText = (e) =>
    codes[e?.code] ||
    codes[e?.message] ||
    codes[String(e?.message || '').replace(/^ROUTE_/, '')] ||
    window.OpsDispatch?.error(e) ||
    e?.message ||
    T('Не удалось выполнить действие.');
  /* База отдаёт code='P0001', а настоящий код лежит в message — та же ловушка,
   что чинили в errText. Поэтому смотрим оба поля. */
  const isCode = (e, name) => [e?.code, e?.message].some((v) => String(v || '').replace(/^ROUTE_/, '') === name);
  const errDetail = (e) => {
    const d = e?.details ?? e?.detail;
    if (!d) return null;
    if (typeof d === 'object') return d;
    try {
      return JSON.parse(d);
    } catch {
      return null;
    }
  };
  /* Сегодняшний день пересчитывается от текущей минуты. Если в нём остался незакрытый
   адрес, чьё обещанное окно уже прошло, день перестаёт сходиться целиком — и время
   нельзя подтвердить даже на вечер. Голый TIME_CONFLICT этого не объясняет. */
  const staleDayHint = (e, day) => {
    const C = window.OpsDispatch?.core;
    if (!C || !day || day !== C.ukDay()) return '';
    if (!isCode(e, 'TIME_CONFLICT')) return '';
    const d = errDetail(e),
      latest = d ? Number(d.latest) : NaN;
    if (!Number.isFinite(latest) || latest >= C.ukMinute(new Date())) return '';
    return (
      T(' Дело не в выбранном времени: сегодняшний день считается от текущей минуты, а в нём остался незакрытый адрес') +
      (d.to ? ' «' + d.to + '»' : '') +
      T(', обещанное окно которого уже прошло — до ') +
      C.hm(latest) +
      T('. Пока он висит, в сегодня нельзя добавить ничего, даже на вечер.') +
      T(' Отметьте по нему результат в «Дне маршрута» — Выполнено, Не отвечает или Проблема — либо перенесите его на другой день.')
    );
  };
  async function api(sb, action, data = {}) {
    const { data: result, error } = await sb.functions.invoke('subnex-sms', { body: { action, data } });
    if (error) {
      let code = 'NETWORK';
      try {
        const j = await error.context.json();
        code = j.error || code;
      } catch {}
      const e = new Error(codes[code] || T('Ошибка запроса: ') + code);
      e.code = code;
      throw e;
    }
    if (result?.error) {
      const e = new Error(codes[result.error] || result.error);
      e.code = result.error;
      throw e;
    }
    return result;
  }
  const photoCache = new Map();
  async function signPhotos(sb, paths) {
    const missing = [...new Set(paths)].filter((p) => p && (!photoCache.has(p) || photoCache.get(p).expires < Date.now()));
    for (let offset = 0; offset < missing.length; offset += 100) {
      const { data, error } = await sb.storage.from('photos').createSignedUrls(missing.slice(offset, offset + 100), 3600);
      if (error) continue;
      (data || []).forEach((x) => {
        if (x.signedUrl) photoCache.set(x.path, { url: x.signedUrl, expires: Date.now() + 3300000 });
      });
    }
  }
  const photoUrl = (p) => photoCache.get(p)?.url || 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
  const ukDate = (d) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      new Date(d || Date.now()),
    );
  const ukTime = (d) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(new Date(d));
  const slotLabel = (a) =>
    a?.collection_start
      ? ukDate(a.collection_start) +
        ' · ' +
        (SubnexDispatchCore.isDaySpan(a.collection_start, a.collection_end)
          ? T('в течение дня (окно уйдёт утром)')
          : ukTime(a.collection_start) + '–' + ukTime(a.collection_end) + ' UK')
      : '';
  const sources = { subnex: 'SUBNEX Collections', partner: 'Partner Collections', missing: 'Missing Collections' };
  const sourceLabel = (a) =>
    a?.collection_source === 'partner' && a.intake_channel === 'partner_email'
      ? 'Emails from partner'
      : sources[a?.collection_source] || sources.subnex;
  function partnerOffer(day, start, end, name) {
    const d = new Date(day + 'T12:00:00Z');
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      isNaN(d) ||
      d.toISOString().slice(0, 10) !== day ||
      !/^\d{2}:\d{2}$/.test(start) ||
      !/^\d{2}:\d{2}$/.test(end)
    )
      return '';
    const n = d.getUTCDate(),
      suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
    const date =
      ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()] +
      ' ' +
      n +
      suffix +
      ' ' +
      ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][
        d.getUTCMonth()
      ] +
      ' ' +
      d.getUTCFullYear();
    const clock = (t) => {
      const [h, m] = t.split(':').map(Number);
      return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? 'am' : 'pm');
    };
    return (
      "Good afternoon,\n\nI'm your We Recycle Clothes driver, here to collect your clothing donation.\n\nI can collect on " +
      date +
      ', between ' +
      clock(start) +
      ' and ' +
      clock(end) +
      ".\n\nPlease reply YES to confirm, or let me know if you'd prefer a different day or time.\n\nThank you, and see you then!\n" +
      (name?.trim() ? name.trim() + '\n' : '') +
      'We Recycle Clothes'
    );
  }
  function subnexOffer(text) {
    return text
      .replace(
        "Good afternoon,\n\nI'm your We Recycle Clothes driver, here to collect your clothing donation.",
        "Hi,\n\nI'm getting in touch from SUBNEX to arrange your clothing collection.",
      )
      .replace(/We Recycle Clothes$/, 'SUBNEX');
  }
  const statuses = {
    pending_auto: T('Ожидает автоматической отправки'),
    auto_skipped: T('Не отправлено — заявка или условия изменились'),
    received: T('Получено'),
    dispatching: T('Отправка начата — ожидаем статус'),
    unknown: T('Результат неизвестен — проверьте Twilio'),
    accepted: T('Принято Twilio'),
    queued: T('В очереди'),
    sending: T('Отправляется'),
    sent: T('Отправлено оператору'),
    delivered: T('Доставлено'),
    read: T('Прочитано'),
    failed: T('Ошибка отправки'),
    undelivered: T('Не доставлено'),
    canceled: T('Отменено'),
  };
  let current = null;
  function close() {
    current?.close();
    current = null;
  }
  async function open(options) {
    close();
    current = new Chat(options);
    await current.start();
    return current;
  }
  class Chat {
    constructor(o) {
      this.o = o;
      this.sb = o.sb;
      this.profile = o.profile;
      this.inline = !!o.mount;
      this.admin = o.profile.role === 'admin';
      this.threadId = null;
      this.data = null;
      this.mode = 'reply';
      this.planner = null;
      this.drafts = new Map();
      this.offset = 0;
      this.sendBusy = false;
      this.closed = false;
      this.listLoading = false;
      this.detailLoading = false;
      this.oldFocus = document.activeElement;
    }
    $(s) {
      return this.root.querySelector(s);
    }
    async call(action, data = {}) {
      return api(this.sb, action, data);
    }
    notice(s) {
      if (this.closed) return;
      const n = this.$('.oc-notice');
      n.textContent = s || '';
      n.classList.toggle('on', !!s);
    }
    async run(fn, day) {
      try {
        return await fn();
      } catch (e) {
        this.notice(errText(e) + staleDayHint(e, day));
        return null;
      }
    }
    drivers() {
      return (this.o.drivers?.() || []).filter((d) => d.active !== false);
    }
    driverOptions(selected = '') {
      return (
        `<option value="">${T('Не назначен')}</option>` +
        this.drivers()
          .map((d) => `<option value="${esc(d.id)}" ${d.id === selected ? 'selected' : ''}>${esc(d.name)}</option>`)
          .join('')
      );
    }
    async start() {
      this.root = document.createElement('div');
      this.root.className = 'ops-root' + (this.inline ? ' ops-inline' : '');
      if (!this.inline) {
        this.root.setAttribute('role', 'dialog');
        this.root.setAttribute('aria-modal', 'true');
      }
      this.root.setAttribute('aria-label', 'SUBNEX SMS');
      this.root.innerHTML =
        (this.inline
          ? ''
          : `<header class="oc-top"><div class="oc-brand">SUBNEX <span class="oc-brand-acc">SMS</span><small>${T('Переписка и сборы')}</small></div><nav>${this.admin ? `<button data-act="settings">${T('График и доступ')}</button>` : ''}<button data-act="close">${T('Закрыть ×')}</button></nav></header>`) +
        `<div class="oc-notice" role="status"></div><div class="oc-body"><aside class="oc-side"><div class="oc-filters"><div class="oc-row oc-between"><b>${T('Переписки')}</b><button class="oc-primary" data-act="new">${T('+ Новая')}</button></div><input id="oc-search" type="search" placeholder="${T('Телефон или адрес')}" aria-label="${T('Поиск переписки')}"><select id="oc-source" aria-label="${T('Категория')}"><option value="">${T('Все категории')}</option>${Object.entries(
          sources,
        )
          .map(([v, n]) => `<option value="${v}">${n}</option>`)
          .join(
            '',
          )}</select>${this.admin ? `<select id="oc-driver-filter" aria-label="${T('Водитель')}"><option value="">${T('Все водители')}</option>${this.driverOptions().replace(`<option value="">${T('Не назначен')}</option>`, '')}</select>` : ''}<label><input type="checkbox" id="oc-attention">${T('Требуют внимания')}</label></div><div class="oc-list"><div class="oc-empty">${T('Загрузка…')}</div></div><div class="oc-row" style="padding:10px"><button data-act="prev">←</button><span class="oc-page oc-muted"></span><button data-act="next">→</button><button data-act="refresh">${T('Обновить')}</button></div></aside><main class="oc-conversation"><div class="oc-empty"><strong>${T('Каждая договорённость — в истории')}</strong>${T('Выберите переписку или создайте запрос на сбор.')}</div></main></div>`;
      if (this.inline) {
        this.o.mount.replaceChildren(this.root);
      } else {
        document.body.append(this.root);
        this.previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
      }
      this.root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (b && !b.disabled) this.action(b.dataset.act, b);
      });
      this.root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (this.$('.oc-modal-wrap')) this.$('.oc-modal-wrap').remove();
          else if (!this.inline) this.close();
        }
        if (e.key === 'Tab') {
          const focus = [...this.root.querySelectorAll('button,input,select,textarea,[tabindex="0"]')].filter(
            (x) => !x.disabled && x.getClientRects().length,
          );
          if (!focus.length) return;
          const first = focus[0],
            last = focus.at(-1);
          if (e.shiftKey && document.activeElement === first) {
            last.focus();
            e.preventDefault();
          } else if (!e.shiftKey && document.activeElement === last) {
            first.focus();
            e.preventDefault();
          }
        }
      });
      for (const id of ['#oc-source', '#oc-attention', '#oc-driver-filter'])
        this.$(id)?.addEventListener('change', () => {
          this.offset = 0;
          this.loadList();
        });
      this.$('#oc-search').addEventListener('input', () => {
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => {
          this.offset = 0;
          this.loadList();
        }, 350);
      });
      this.$('#oc-search').value = this.o.phone || '';
      if (!this.inline) this.$('#oc-search').focus();
      await this.loadList();
      if (this.o.phone) {
        const match = (this.visibleThreads || []).find(
          (t) => t.phone.replace(/\D/g, '').replace(/^0/, '44') === this.o.phone.replace(/\D/g, '').replace(/^0/, '44'),
        );
        if (match) await this.select(match.id);
      }
      if (this.o.addressId)
        await this.run(async () => {
          const t = await this.call('create', { address_id: this.o.addressId });
          await this.select(t.thread_id);
          if (this.o.planner) this.applyPlanner(this.o.planner);
        });
      /* Опрос идёт только пока переписка на экране. Раньше он продолжался и на других
         страницах пульта — до 900 вызовов в час с каждой открытой вкладки, а лимит
         Supabase Free — 500 000 в месяц. */
      this.timer = setInterval(() => {
        if (!document.hidden && !this.closed && !this.sendBusy && this.visible()) {
          this.loadList();
          if (this.threadId) this.loadDetail();
        }
      }, 8000);
    }
    visible() {
      return !!(this.root && this.root.isConnected && this.root.getClientRects().length);
    }
    /* Пульт зовёт это при возврате на страницу «Переписка»: подтянуть, что накопилось. */
    resume() {
      if (this.closed || this.sendBusy) return;
      this.loadList();
      if (this.threadId) this.loadDetail();
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      if (!this.inline) window.OpsPlanner?.close();
      clearInterval(this.timer);
      clearTimeout(this.searchTimer);
      this.root?.remove();
      if (!this.inline) {
        document.body.style.overflow = this.previousOverflow || '';
        this.oldFocus?.focus();
      }
      this.o.onChanged?.();
    }
    async loadList() {
      if (this.listLoading || this.closed) return;
      this.listLoading = true;
      try {
        const result = await this.call('list', {
          search: this.$('#oc-search').value,
          source: this.$('#oc-source').value,
          attention: this.$('#oc-attention').checked,
          driver_id: this.$('#oc-driver-filter')?.value || '',
          limit: 60,
          offset: this.offset,
        });
        if (this.closed) return;
        this.hasNext = result.threads.length > 60;
        const list = result.threads.slice(0, 60);
        this.visibleThreads = list;
        this.$('.oc-list').innerHTML =
          list
            .map(
              (t) =>
                `<button data-act="thread" data-id="${esc(t.id)}" class="oc-thread ${t.id === this.threadId ? 'active' : ''}"><strong>${t.needs_attention ? '<span class="oc-dot"></span>' : ''}${esc(t.phone)}</strong><p>${esc(t.address || t.closed_request?.text || T('Адрес не привязан'))}</p><p>${esc(t.last_body || T('Сообщений пока нет'))}</p><small>${esc(threadState(t))} · ${esc(ukTime(t.last_activity))}</small></button>`,
            )
            .join('') || `<div class="oc-empty">${T('Переписок по этому фильтру нет.')}</div>`;
        this.$('[data-act=prev]').disabled = this.offset === 0;
        this.$('[data-act=next]').disabled = !this.hasNext;
        this.$('.oc-page').textContent = String(1 + this.offset / 60);
      } catch (e) {
        this.notice(errText(e));
      } finally {
        this.listLoading = false;
      }
    }
    rememberDraft() {
      const b = this.$('#oc-body');
      if (b && this.threadId) {
        this.drafts.set(this.threadId, {
          mode: this.mode,
          body: b.value,
          day: this.$('#oc-day')?.value,
          start: this.$('#oc-start')?.value,
          end: this.$('#oc-end')?.value,
          planner: this.planner,
          closure_id: this.closureId,
          template: this.mode === 'offer' && this.dayOnly ? 'day-v1' : undefined,
        });
      }
    }
    async select(id) {
      if (this.sendBusy) return;
      this.rememberDraft();
      this.threadId = id;
      this.data = null;
      this.planner = null;
      this.pending = null;
      this.root.classList.add('oc-selected');
      this.$('.oc-conversation').innerHTML = `<div class="oc-empty">${T('Загрузка переписки…')}</div>`;
      await this.loadDetail(true);
      this.loadList();
    }
    async loadDetail(reset = false) {
      if (!this.threadId || this.detailLoading || this.closed) return;
      this.detailLoading = true;
      const id = this.threadId;
      try {
        const data = await this.call('detail', { thread_id: id });
        if (this.closed || id !== this.threadId) return;
        if (!reset && this.data?.thread.id === id)
          data.messages = [...new Map([...this.data.messages, ...data.messages].map((m) => [m.id, m])).values()].sort(
            (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
          );
        if (this.data && this.data.address?.id !== data.address?.id && !this.sendBusy) {
          this.drafts.delete(id);
          this.pending = null;
          sessionStorage.removeItem('subnex_sms_pending_' + this.profile.user_id + '_' + id);
          reset = true;
        }
        this.data = data;
        if (reset || !this.$('.oc-messages')) {
          this.$('.oc-conversation').innerHTML =
            `<div class="oc-head"></div><div class="oc-messages" aria-label="${T('История сообщений')}"></div><div class="oc-compose"></div>`;
          let draft = this.drafts.get(id);
          if (!draft) {
            try {
              const pending = JSON.parse(sessionStorage.getItem('subnex_sms_pending_' + this.profile.user_id + '_' + id) || 'null');
              if (pending) {
                const payload = JSON.parse(pending.signature);
                draft = { ...payload, mode: payload.kind, planner: pending.planner };
              }
            } catch {}
          }
          this.mode = draft?.mode || 'reply';
          this.compose(draft);
        }
        this.renderHead();
        this.renderMessages(data.messages);
        this.$('#oc-send')?.toggleAttribute('disabled', this.sendBusy || data.thread.opted_out);
      } catch (e) {
        if (['ACCESS_DENIED', 'LOGIN_REQUIRED'].includes(e.code)) {
          this.data = null;
          this.threadId = null;
          this.$('.oc-conversation').innerHTML =
            `<div class="oc-empty">${T('Доступ к переписке закрыт. Войдите заново или проверьте назначение.')}</div>`;
        }
        this.notice(errText(e));
      } finally {
        this.detailLoading = false;
      }
    }
    renderHead() {
      const { thread: t, address: a, offer: o } = this.data;
      const c = !a ? t.closed_request : isClosed(a) ? { text: a.text, source: a.collection_source, reason: a.cancellation_reason } : null;
      const finished = !!a && resultStatuses.includes(a.status),
        closed = !!c;
      const slot = a?.collection_start
        ? `<span class="oc-chip ${finished || closed ? '' : 'ok'}">${finished || closed ? T('Было согласовано') : T('Согласовано')}: ${esc(slotLabel(a))}</span>`
        : a?.date
          ? `<span class="oc-chip ${finished || closed ? '' : 'ok'}">${finished || closed ? T('Дата сбора') : T('В маршруте')}: ${esc(a.date)}</span>`
          : !closed
            ? `<span class="oc-chip">${T('Вне маршрута')}</span>`
            : '';
      const action =
        (a && a.kind !== 'bank') || c
          ? `<button data-act="cancel-request" style="margin-top:10px" ${closed ? 'disabled aria-disabled="true"' : this.sendBusy ? 'disabled' : ''}>${closed ? T('Заявка закрыта') : T('Закрыть заявку')}</button>`
          : '';
      this.$('.oc-head').innerHTML =
        `<div class="oc-row oc-between"><div class="oc-row"><button class="oc-back" data-act="back">←</button><strong>${esc(t.phone)}</strong></div><div class="oc-row"><button data-act="${closed ? 'rebook' : 'attach'}">${closed ? T('Новая заявка') : a ? T('Адрес') : T('Привязать адрес')}</button>${this.admin ? `<button data-act="assign">${T('Водитель')}</button>` : ''}<button data-act="refresh" aria-label="${T('Обновить переписку')}">↻</button><button data-act="read" title="${T('Отметить просмотренным')}">✓</button></div></div><p>${esc(a?.text || c?.text || T('Добавьте адрес, чтобы согласовать сбор.'))}</p><div>${a ? `${this.admin && !closed ? `<button class="oc-chip" data-act="category" title="${T('Изменить категорию')}" ${this.sendBusy ? 'disabled' : ''}>${esc(sourceLabel(a))} ▾</button>` : `<span class="oc-chip">${esc(sourceLabel(a))}</span>`}` : ''}${closed ? `<span class="oc-chip">${T('Отменена')}${c.reason ? ' · ' + esc(cancellationReasons[c.reason] || c.reason) : ''}</span>` : a ? `<span class="oc-chip ${finished ? 'warn' : ''}">${T('Статус:')} ${esc(collectionState(a))}</span>` : ''}${slot}${t.opted_out ? `<span class="oc-chip warn">${T('SMS отключены клиентом · нужен START')}</span>` : !closed && t.manual_mode ? `<span class="oc-chip warn">${T('Ручное согласование')}</span>` : !closed && o?.state === 'awaiting' ? `<span class="oc-chip warn">${T('Ожидаем точный ответ YES')}</span>` : ''}</div>${action}${closed ? `<p class="oc-help">${T('История сохранена.')}${c.previous_status ? T(' До закрытия: ') + esc(collectionStates[c.previous_status] || c.previous_status) + '.' : ''} ${T('Для следующего сбора создайте новую заявку.')}</p>${c.previous_result_note ? `<p class="oc-help">${T('Прежняя заметка о результате:')} ${esc(c.previous_result_note)}</p>` : ''}` : ''}`;
    }
    renderMessages(messages, prepend = false) {
      const box = this.$('.oc-messages');
      const bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
      const previous = box.scrollHeight;
      if (prepend) {
        const all = [...messages, ...this.data.messages];
        this.data.messages = [...new Map(all.map((x) => [x.id, x])).values()];
        messages = this.data.messages;
      }
      const html =
        `${messages.length >= 100 ? `<button data-act="older">${T('Более ранние сообщения')}</button>` : ''}` +
        messages
          .map(
            (m) =>
              `<article class="oc-message ${m.direction === 'out' ? 'out' : ''}"><div class="oc-text">${esc(m.body)}</div>${m.num_media ? `<div class="oc-help">${T('Вложений:')} ` + m.num_media + ` ${T('(файлы не загружены)')}</div>` : ''}<footer><span class="${['unknown', 'failed', 'undelivered', 'dispatching'].includes(m.status) ? 'oc-error' : ''}">${esc(statuses[m.status] || m.status)}${m.error_code ? ' · ' + esc(m.error_code) : ''}</span> · ${esc(ukDate(m.created_at))} ${esc(ukTime(m.created_at))}</footer></article>`,
          )
          .join('');
      if (box.innerHTML !== html) box.innerHTML = html || `<div class="oc-empty">${T('Напишите первое сообщение.')}</div>`;
      if (prepend) box.scrollTop = box.scrollHeight - previous;
      else if (bottom || !this.initialScroll) {
        box.scrollTop = box.scrollHeight;
        this.initialScroll = true;
      }
    }
    compose(draft) {
      this.planner = draft?.planner || null;
      const { address: a, thread: t } = this.data;
      this.closureId = draft?.closure_id || (!a ? t.closed_request?.id : null);
      const schedulable = !!a && ['new', 'planned'].includes(a.status) && !isClosed(a);
      if (!schedulable) this.mode = 'reply';
      this.formVersion = a?.collection_version;
      const isOffer = this.mode === 'offer',
        manual = this.mode === 'confirm';
      this.$('.oc-compose').innerHTML =
        `${schedulable && !a.date && ['subnex', 'partner'].includes(a.collection_source) ? `<button data-act=planner style="margin-bottom:10px">${T('Подобрать время по маршруту')}</button>` : ''}${schedulable && a.collection_start ? `<button data-act=movecol style="margin-bottom:10px">${T('Перенести сбор')}</button>` : ''}${this.planner ? `<p class=oc-help>${T('Интервал выбран по маршруту. Перед отправкой проверим его ещё раз.')}</p>` : ''}<div class="oc-controls"><button data-act="mode" data-mode="reply" class="${this.mode === 'reply' ? 'active' : ''}">${T('Сообщение')}</button><button data-act="mode" data-mode="offer" ${!schedulable || a.date ? 'disabled' : ''} class="${isOffer ? 'active' : ''}">${T('Предложить время')}</button><button data-act="mode" data-mode="confirm" ${!schedulable || a.collection_start ? 'disabled' : ''} class="${manual ? 'active' : ''}">${T('Подтвердить вручную')}</button></div>${isOffer || manual ? `<div class="oc-slots"><label>${T('Дата')}<input id="oc-day" type="date" min="${ukDate()}" value="${esc(draft?.day || a?.date || (this.data.offer?.starts_at ? ukDate(this.data.offer.starts_at) : ukDate()))}"></label><label>${T('С')}<input id="oc-start" type="time" value="${esc(draft?.start || (a?.collection_start ? ukTime(a.collection_start) : this.data.offer?.starts_at ? ukTime(this.data.offer.starts_at) : '09:00'))}"></label><label>${T('До')}<input id="oc-end" type="time" value="${esc(draft?.end || (a?.collection_end ? ukTime(a.collection_end) : this.data.offer?.ends_at ? ukTime(this.data.offer.ends_at) : '09:30'))}"></label></div><div class="oc-help">${T('Время Великобритании. Новый интервал прибытия — 30 минут; время сбора учитывается отдельно.')}</div>${isOffer && ['subnex', 'partner', 'missing'].includes(a?.collection_source) ? `<label class="oc-dayonly" style="margin-top:8px"><input id="oc-dayonly" type="checkbox" ${this.dayOnly ? 'checked' : ''}>${T('Только дата — окно прибытия придёт клиенту утром, когда водитель начнёт маршрут')}</label>` : ''}` : ''}${manual ? `<label><input id="oc-agreed" type="checkbox">${T('Клиент согласовал эту дату и время в переписке или по телефону.')}</label>${a?.date ? `<label style="margin-top:10px"><input id="oc-change-agreed" type="checkbox">${T('Клиент согласен изменить ранее назначенный срок.')}</label>` : ''}<p class="oc-help">${T('Подтверждение добавит адрес в маршрут. Автоматическая SMS подтвердит запись клиенту.')}</p><button class="oc-green" id="oc-confirm" data-act="confirm">${T('Подтвердить и добавить в маршрут')}</button>` : `<label for="oc-body">${isOffer ? T('Текст предложения') : T('Сообщение клиенту')}</label><textarea id="oc-body" maxlength="1000" placeholder="${T('Текст SMS…')}"></textarea>${isOffer ? '<div class="oc-preview" id="oc-preview"></div>' : ''}<div class="oc-row oc-between" style="margin-top:8px"><span class="oc-muted" id="oc-count"></span><button class="oc-primary" id="oc-send" data-act="send" ${t.opted_out ? 'disabled' : ''}>${isOffer ? T('Отправить предложение') : T('Отправить SMS')}</button></div><p class="oc-help">${isOffer ? (t.manual_mode || t.active_offer_id ? T('Продолжается ручное согласование. После ответа подтвердите время кнопкой выше.') : T('Адрес попадёт в маршрут после точного ответа YES. Другой ответ откроет ручное согласование.')) : T('SMS отправляется с номера компании. Статус «Доставлено» не подтверждает сбор.')}</p>`}`;
      const body = this.$('#oc-body');
      if (body) {
        body.value =
          draft?.body ?? (isOffer ? `Hi, this is SUBNEX. We'd like to collect your bags${a?.text ? ' from ' + a.text : ''}.` : '');
        body.addEventListener('input', () => this.preview());
      }
      this.dayOnly = !!(draft ? draft.template === 'day-v1' : this.dayOnly);
      this.$('#oc-dayonly')?.addEventListener('change', (e) => {
        this.dayOnly = e.target.checked;
        this.preview();
      });
      for (const id of ['#oc-day', '#oc-start', '#oc-end'])
        this.$(id)?.addEventListener('input', () => {
          if (id === '#oc-start' && !a?.collection_start) {
            const m = SubnexDispatchCore.minute(this.$('#oc-start').value);
            if (Number.isFinite(m) && m + 30 < 1440) this.$('#oc-end').value = SubnexDispatchCore.hm(m + 30);
          }
          this.preview();
        });
      this.preview();
    }
    partnerTemplate() {
      return this.mode === 'offer' && ['subnex', 'partner', 'missing'].includes(this.data?.address?.collection_source);
    }
    driverName() {
      return (
        this.drivers().find((d) => d.id === this.data?.thread.driver_id)?.name ||
        (this.profile.driver_id === this.data?.thread.driver_id ? this.profile.driver_name : '') ||
        ''
      );
    }
    /* Часы дня для предложения «только дата»: окно = весь рабочий день, как считает сервер. */
    dayHours(day) {
      const h = this.hoursCache;
      if (!h || !day) return null;
      const one =
        (h.days || []).find((x) => x.day === day) || (h.week || []).find((x) => x.weekday === new Date(day + 'T12:00:00Z').getUTCDay());
      if (!one || one.closed) return null;
      return { opens: one.opens.slice(0, 5), closes: one.closes.slice(0, 5) };
    }
    preview() {
      const b = this.$('#oc-body');
      const dayOnly = this.mode === 'offer' && this.dayOnly && this.$('#oc-dayonly');
      for (const id of ['#oc-start', '#oc-end']) {
        const el = this.$(id);
        if (el) el.closest('label').style.display = dayOnly ? 'none' : '';
      }
      if (b && dayOnly) {
        b.readOnly = true;
        const day = this.$('#oc-day').value;
        if (!this.hoursCache) {
          this.call('hours')
            .then((h) => {
              this.hoursCache = h;
              if (!this.closed) this.preview();
            })
            .catch(() => {});
        }
        const h = this.dayHours(day);
        if (h) {
          this.$('#oc-start').value = h.opens;
          this.$('#oc-end').value = h.closes;
        }
        b.value = SubnexDispatchCore.dayOfferText(this.data.address.collection_source, day, this.driverName());
        this.$('#oc-count').textContent = b.value.length + T(' / 1000 символов');
        this.$('#oc-preview').textContent = h
          ? T('SMS только с датой. После YES сбор встанет на ') + day + T(' без времени; окно прибытия уйдёт утром при старте маршрута.')
          : T('На эту дату нет рабочих часов — выберите другой день.');
        return;
      }
      if (b && this.partnerTemplate()) {
        b.readOnly = true;
        b.value = partnerOffer(this.$('#oc-day').value, this.$('#oc-start').value, this.$('#oc-end').value, this.driverName());
        if (this.data.address.collection_source === 'subnex') b.value = subnexOffer(b.value);
        this.$('#oc-count').textContent = b.value.length + T(' / 1000 символов');
        this.$('#oc-preview').textContent =
          T('Готовая SMS от ') +
          SubnexDispatchCore.brandOf(this.data.address) +
          T('. Дата и часы обновляются автоматически. Подпись: ') +
          (this.driverName() || T('без имени — назначьте водителя')) +
          '.';
        return;
      }
      if (b) this.$('#oc-count').textContent = b.value.length + T(' / 1000 символов');
      if (!this.$('#oc-preview')) return;
      const day = this.$('#oc-day').value;
      const dt = day ? new Date(day + 'T12:00:00Z') : null;
      const date =
        dt && !isNaN(dt) ? dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '…';
      const manual = this.data.thread.manual_mode || this.data.thread.active_offer_id;
      this.$('#oc-preview').textContent =
        T('К SMS будет добавлено:\nCollection: ') +
        date +
        ', ' +
        this.$('#oc-start').value +
        '-' +
        this.$('#oc-end').value +
        ' (UK time).\n' +
        (manual ? 'Please reply to agree the day/time with our team.' : 'Reply YES to confirm, or reply to arrange a different day/time.');
    }
    async action(act, b) {
      if (this.sendBusy && !['close', 'back'].includes(act)) return;
      if (act === 'cancel-request') {
        this.closeCollection();
        return;
      }
      if (act === 'rebook') {
        const a = this.data?.address,
          c = this.data?.thread.closed_request || (isClosed(a) ? { text: a.text, source: a.collection_source } : null);
        if (c) this.newThread(this.data.thread.phone, c);
        return;
      }
      if (act === 'planner') {
        await this.run(() => this.pickTime());
        return;
      }
      if (act === 'movecol') {
        await this.run(() => this.moveCollection());
        return;
      }
      if (act === 'close') {
        this.close();
        return;
      }
      if (act === 'back') {
        this.rememberDraft();
        this.root.classList.remove('oc-selected');
        return;
      }
      if (act === 'thread') {
        this.initialScroll = false;
        await this.select(b.dataset.id);
        return;
      }
      if (act === 'mode') {
        if (this.sendBusy) return;
        const mode = b.dataset.mode;
        if (
          mode !== 'reply' &&
          (!this.data.address || !['new', 'planned'].includes(this.data.address.status) || isClosed(this.data.address))
        ) {
          this.notice(T('Для нового сбора создайте отдельную заявку.'));
          return;
        }
        this.mode = mode;
        this.compose();
        return;
      }
      if (act === 'refresh') {
        this.notice('');
        await this.loadList();
        await this.loadDetail();
        return;
      }
      if (act === 'prev' || act === 'next') {
        this.offset = Math.max(0, this.offset + (act === 'next' ? 60 : -60));
        await this.loadList();
        return;
      }
      if (act === 'new') {
        this.newThread();
        return;
      }
      if (act === 'attach') {
        if (this.data.address) {
          this.notice(T('Адрес: ') + this.data.address.text + T('. Редактирование реквизитов доступно в разделе «Адреса».'));
        } else this.newThread(this.data.thread.phone);
        return;
      }
      if (act === 'category') {
        if (!this.sendBusy) this.changeCategory();
        return;
      }
      if (act === 'assign') {
        this.assign();
        return;
      }
      if (act === 'settings') {
        this.settings();
        return;
      }
      if (act === 'read') {
        await this.run(() => this.call('read', { thread_id: this.threadId }));
        await this.loadList();
        return;
      }
      if (act === 'older') {
        b.disabled = true;
        const first = this.data.messages[0];
        const old = await this.run(() => this.call('detail', { thread_id: this.threadId, before: first.created_at, before_id: first.id }));
        if (old) {
          this.renderMessages(old.messages, true);
          if (!old.messages.length) {
            this.notice(T('Начало переписки.'));
            this.$('[data-act=older]')?.remove();
          }
        }
        return;
      }
      if (act === 'send') {
        await this.send();
        return;
      }
      if (act === 'confirm') {
        await this.confirm();
        return;
      }
    }
    applyPlanner(plan) {
      if (this.closed || !this.data?.address || this.data.address.id !== plan.address_id) return;
      this.mode = 'offer';
      this.compose({ ...plan, planner: plan });
      this.rememberDraft();
      this.notice(T('Время выбрано. Проверьте текст и нажмите «Отправить предложение».'));
    }
    /* Перенос уже согласованного сбора прямо из переписки: клиент просит другой день,
    приложение само подбирает время в этом дне по маршруту. Подтверждённый срок
    двигается только с явной отметкой согласия клиента. */
    async moveCollection() {
      const a = this.data?.address,
        t = this.data?.thread;
      if (!a || !a.collection_start) return;
      const D = window.OpsDispatch;
      if (!D?.core || !D.rpc) throw new Error(T('Модуль маршрута не загружен. Обновите страницу.'));
      const C = D.core,
        driverId = a.driver_id || t.driver_id;
      if (!driverId) throw new Error(codes.DRIVER_REQUIRED);
      const brand = SubnexDispatchCore.brandOf(a);
      let zones = [];
      try {
        const z = await this.sb.rpc('subnex_zones', { p_action: 'list', p_data: {} });
        if (!z.error) zones = z.data.zones || [];
      } catch (e) {}
      let slots = [];
      const w = this.modal(
        T('Перенести сбор'),
        `<p><b>${esc(a.text)}</b></p>
   <p class="oc-help">${T('Сейчас согласовано:')} ${esc(slotLabel(a))}${T('. Перенос изменит договорённость с клиентом.')}</p>
   <label>${T('Новая дата')}<input id="oc-mv-day" type="date" min="${ukDate()}" value="${esc(a.date || ukDate())}"></label>
   <label>${T('Время')}<select id="oc-mv-time"><option value="">${T('Считаю…')}</option></select></label>
   <p class="oc-help" id="oc-mv-note">${T('Время подбирается по маршруту выбранного дня — первым идёт самое выгодное по дороге.')}</p>
   <label><input id="oc-mv-agreed" type="checkbox">${T('Клиент согласовал перенос.')}</label>
   <label><input id="oc-mv-sms" type="checkbox" checked>${T('Отправить клиенту сообщение о переносе.')}</label>
   <textarea id="oc-mv-text" rows="7" readonly></textarea>`,
        async (wrap) => {
          const day = wrap.querySelector('#oc-mv-day').value,
            pick = wrap.querySelector('#oc-mv-time').value;
          const slot = slots[+pick];
          if (!day || !slot) throw new Error(T('Выберите дату и свободное время.'));
          if (!wrap.querySelector('#oc-mv-agreed').checked) throw new Error(codes.CONFIRMED_CHANGE_REQUIRES_AGREEMENT);
          const r = await this.sb.rpc('subnex_move_request', {
            p_data: { address_id: a.id, version: a.collection_version, day, start: slot.start, end: slot.end, agreed: true },
          });
          if (r.error) throw r.error;
          let tail = '';
          if (wrap.querySelector('#oc-mv-sms').checked) {
            try {
              await this.call('send', {
                thread_id: t.id,
                kind: 'reply',
                body: wrap.querySelector('#oc-mv-text').value,
                request_id: crypto.randomUUID(),
              });
            } catch (e) {
              tail = T(' Сообщение не ушло: ') + errText(e) + T(' Напишите клиенту вручную.');
            }
          }
          await this.loadDetail(true);
          await this.loadList();
          this.compose();
          this.o.onChanged?.();
          this.notice(T('Сбор перенесён: ') + day + ', ' + slot.start + '–' + slot.end + '.' + tail);
        },
        T('Перенести'),
      );
      const text = () => {
        const box = w.querySelector('#oc-mv-text'),
          slot = slots[+w.querySelector('#oc-mv-time').value];
        box.value = slot ? moveMessage(a, this.driverName(), brand, w.querySelector('#oc-mv-day').value, slot.start, slot.end) : '';
      };
      const load = async () => {
        const day = w.querySelector('#oc-mv-day').value;
        const sel = w.querySelector('#oc-mv-time'),
          note = w.querySelector('#oc-mv-note');
        slots = [];
        sel.innerHTML = `<option value="">${T('Считаю…')}</option>`;
        note.textContent = T('Считаю дорогу на этот день…');
        text();
        try {
          if (!day) throw new Error(T('Укажите дату.'));
          const o = { sb: this.sb, driver: { id: driverId }, hasOutbox: this.o.hasOutbox };
          let roads = {};
          try {
            roads = (await D.warm(o, day, [a.id])).roads || {};
          } catch (e) {}
          const snap = await D.rpc(this.sb, 'snapshot', { driver_id: driverId, from_day: day, days: 1, address_ids: [a.id] });
          const node = {
            key: 'mv:' + a.id,
            address_id: a.id,
            text: a.text,
            lat: a.lat,
            lng: a.lng,
            service: a.service_minutes || 5,
            kg: a.estimated_kg || 10,
          };
          slots = C.slotsFor({ days: snap.days, assigned: [], unassigned: [] }, node, day, { ...snap.config, zones }, roads, 8);
          sel.innerHTML = slots.length
            ? slots
                .map(
                  (s, i) =>
                    `<option value="${i}">${esc(s.start)}–${esc(s.end)}${s.extra_minutes ? ' · +' + s.extra_minutes + T(' мин дороги') : ''}</option>`,
                )
                .join('')
            : `<option value="">${T('Свободного места нет')}</option>`;
          note.textContent = slots.length
            ? `${T('Свободных мест в этот день:')} ${slots.length}${T('. Первое — с наименьшим крюком.')}`
            : D.dayIssueText(C.dayIssue({ days: snap.days, assigned: [], unassigned: [] }, node, day, { ...snap.config, zones }, roads)) ||
              T('Свободного времени в этот день не осталось. Выберите другую дату.');
        } catch (e) {
          sel.innerHTML = `<option value="">${T('Не удалось посчитать')}</option>`;
          note.textContent = errText(e);
        }
        text();
      };
      w.querySelector('#oc-mv-day').addEventListener('change', load);
      w.querySelector('#oc-mv-time').addEventListener('change', text);
      load();
    }
    async pickTime() {
      const a = this.data?.address,
        threadId = this.threadId;
      if (!a || !['new', 'planned'].includes(a.status) || isClosed(a) || a.date || a.collection_start)
        throw new Error(codes.ALREADY_SCHEDULED_USE_MANUAL);
      if (!window.OpsPlanner) throw new Error(T('Загрузите файлы обновления подбора времени и обновите страницу.'));
      const driver = this.drivers().find((d) => d.id === a.driver_id);
      if (!driver) throw new Error(codes.DRIVER_REQUIRED);
      const points = this.o.plannerPoints?.(driver.id) || {};
      await OpsPlanner.open({
        sb: this.sb,
        driver,
        ...points,
        address: { ...a },
        source: a.collection_source === 'subnex' ? 'subnex' : 'partner_email',
        addresses: this.o.addresses,
        hasOutbox: this.o.hasOutbox,
        onChoose: (plan) => {
          if (!this.closed && this.threadId === threadId) this.applyPlanner(plan);
        },
      });
    }
    async send() {
      if (this.sendBusy) return;
      const text = this.$('#oc-body').value.trim();
      if (!text) {
        this.notice(T('Введите сообщение.'));
        return;
      }
      const threadId = this.threadId,
        plan = this.mode === 'offer' ? this.planner : null;
      const payload = { thread_id: threadId, kind: this.mode, body: text };
      if (this.mode === 'offer')
        Object.assign(payload, {
          day: this.$('#oc-day').value,
          start: this.$('#oc-start').value,
          end: this.$('#oc-end').value,
          version: this.formVersion,
        });
      if (this.mode === 'offer' && this.dayOnly && this.$('#oc-dayonly')) {
        const h = this.dayHours(payload.day);
        if (!h) {
          this.notice(T('На эту дату нет рабочих часов — выберите другой день.'));
          return;
        }
        payload.start = h.opens;
        payload.end = h.closes;
        payload.template = 'day-v1';
        payload.expected_source = this.data.address.collection_source;
        payload.expected_driver_name = this.driverName().trim();
      } else if (this.partnerTemplate()) {
        payload.template = 'wrc-v1';
        payload.expected_source = this.data.address.collection_source;
        payload.expected_driver_name = this.driverName().trim();
      }
      if (plan && !plan.dispatch) payload.planner_required = true;
      if (this.mode === 'reply' && this.closureId) payload.closure_id = this.closureId;
      const signature = JSON.stringify(payload),
        key = 'subnex_sms_pending_' + this.profile.user_id + '_' + threadId;
      if (!this.pending) {
        try {
          this.pending = JSON.parse(sessionStorage.getItem(key) || 'null');
        } catch {}
      }
      if (this.pending?.signature !== signature) this.pending = null;
      this.sendBusy = true;
      this.$('#oc-send').disabled = true;
      this.$('#oc-body').disabled = true;
      this.notice(plan ? T('Проверяю маршрут перед отправкой…') : T('Отправка…'));
      try {
        if (!this.pending) {
          const extra = plan
            ? await OpsPlanner.prepareSms({ sb: this.sb, hasOutbox: this.o.hasOutbox, address: this.data.address }, plan, payload)
            : this.mode === 'offer'
              ? (await OpsDispatch.preflight({ sb: this.sb, hasOutbox: this.o.hasOutbox, address: this.data.address }, null, payload)) || {}
              : {};
          if (this.closed || this.threadId !== threadId) return;
          this.pending = { signature, id: crypto.randomUUID(), extra, planner: plan };
          sessionStorage.setItem(key, JSON.stringify(this.pending));
        }
        Object.assign(payload, this.pending.extra || {}, { request_id: this.pending.id });
        // A network retry reuses the original ticket and request id; never issue a new send id.
        const r = await this.call('send', payload);
        if (this.closed) return;
        this.$('#oc-body').value = '';
        this.drafts.delete(threadId);
        this.pending = null;
        this.planner = null;
        sessionStorage.removeItem(key);
        this.mode = 'reply';
        this.compose();
        this.notice(
          r.uncertain
            ? T('Результат неизвестен. Проверьте Message logs в Twilio перед новой отправкой.')
            : T('Статус: ') + (statuses[r.message.status] || r.message.status),
        );
        this.o.onChanged?.();
      } catch (e) {
        if (
          [
            'STALE_ADDRESS',
            'SLOT_CONFLICT',
            'OUTSIDE_WORKING_HOURS',
            'SLOT_IN_PAST',
            'SLOT_INVALID',
            'ALREADY_SCHEDULED_USE_MANUAL',
          ].includes(e.code)
        ) {
          this.pending = null;
          sessionStorage.removeItem(key);
        }
        this.notice(errText(e));
      } finally {
        this.sendBusy = false;
        if (!this.closed) {
          this.$('#oc-send').disabled = !!this.data?.thread.opted_out;
          this.$('#oc-body').disabled = false;
          await this.loadDetail();
          await this.loadList();
          this.preview();
        }
      }
    }
    async confirm() {
      const button = this.$('#oc-confirm');
      if (button.disabled) return;
      const data = {
        thread_id: this.threadId,
        day: this.$('#oc-day').value,
        start: this.$('#oc-start').value,
        end: this.$('#oc-end').value,
        version: this.formVersion,
        agreed: this.$('#oc-agreed').checked,
        change_agreed: this.$('#oc-change-agreed')?.checked || false,
      };
      button.disabled = true;
      const result = await this.run(async () => {
        if (!data.agreed) throw new Error('AGREEMENT_REQUIRED');
        await OpsDispatch.preflight({ sb: this.sb, hasOutbox: this.o.hasOutbox, address: this.data.address }, this.planner, data);
        return this.call('confirm', data);
      }, data.day);
      if (result) {
        this.notice(T('Дата и время сохранены. Адрес добавлен в маршрут.'));
        await this.loadDetail();
        await this.loadList();
        this.compose();
        this.o.onChanged?.();
      } else button.disabled = false;
    }
    modal(title, content, onSave, saveLabel = T('Сохранить')) {
      this.$('.oc-modal-wrap')?.remove();
      const wrap = document.createElement('div');
      wrap.className = 'oc-modal-wrap';
      wrap.innerHTML = `<section class="oc-modal" role="dialog" aria-label="${esc(title)}"><h2>${esc(title)}</h2><div class="oc-form">${content}</div><p class="oc-modal-error" role="alert"></p><div class="oc-actions"><button class="oc-cancel">${T('Отмена')}</button>${onSave ? `<button class="oc-primary oc-save">${esc(saveLabel)}</button>` : ''}</div></section>`;
      this.root.append(wrap);
      wrap.querySelector('.oc-cancel').onclick = () => wrap.remove();
      if (onSave)
        wrap.querySelector('.oc-save').onclick = async () => {
          const save = wrap.querySelector('.oc-save');
          save.disabled = true;
          try {
            await onSave(wrap);
            wrap.remove();
          } catch (e) {
            wrap.querySelector('.oc-modal-error').textContent = errText(e);
            save.disabled = false;
          }
        };
      wrap.querySelector('input,select,button')?.focus();
      return wrap;
    }
    newThread(phone = '', previous = null) {
      const addresses = (this.o.addresses?.() || []).filter((a) => a.kind !== 'bank' && a.phone && ['new', 'planned'].includes(a.status));
      this.modal(
        previous ? T('Новая заявка') : phone ? T('Привязать адрес') : T('Новая переписка'),
        `<label>${T('Существующая заявка')}<select id="oc-existing"><option value="">${T('Новый запрос')}</option>${addresses.map((a) => `<option value="${esc(a.id)}">${esc(a.text)} · ${esc(a.phone)}</option>`).join('')}</select></label><label>${T('Мобильный телефон')}<input id="oc-new-phone" type="tel" value="${esc(phone)}" placeholder="07…"></label><label>${T('Адрес нового сбора')}<input id="oc-new-address" value="${esc(previous?.text || '')}" placeholder="${T('Улица, дом, город, индекс')}"></label><label>${T('Категория')}<select id="oc-new-source">${Object.entries(
          sources,
        )
          .map(([v, n]) => `<option value="${v}" ${v === previous?.source ? 'selected' : ''}>${n}</option>`)
          .join(
            '',
          )}</select></label>${this.admin ? `<label>${T('Водитель')}<select id="oc-new-driver">${this.driverOptions(previous ? this.data.thread.driver_id : this.profile.driver_id)}</select></label>` : ''}<p class="oc-help">${T('Новый адрес останется вне маршрута до согласования срока. Координаты можно уточнить в редакторе адреса.')}</p>`,
        async (w) => {
          const data = {
            address_id: w.querySelector('#oc-existing').value,
            phone: w.querySelector('#oc-new-phone').value,
            address: w.querySelector('#oc-new-address').value,
            source: w.querySelector('#oc-new-source').value,
            driver_id: w.querySelector('#oc-new-driver')?.value || this.profile.driver_id,
          };
          if (!data.address_id && data.address && this.o.geocode) {
            const point = await Promise.race([
              this.o.geocode(data.address),
              new Promise((resolve) => setTimeout(() => resolve(null), 12000)),
            ]);
            if (point) {
              data.lat = point.lat;
              data.lng = point.lng;
            }
          }
          const r = await this.call('create', data);
          this.drafts.delete(r.thread_id);
          sessionStorage.removeItem('subnex_sms_pending_' + this.profile.user_id + '_' + r.thread_id);
          if (this.threadId === r.thread_id) {
            this.data = null;
            this.$('.oc-compose')?.replaceChildren();
          }
          this.o.onChanged?.();
          await this.select(r.thread_id);
          await this.loadList();
        },
        T('Открыть переписку'),
      );
    }
    closeCollection() {
      const a = this.data?.address,
        t = this.data?.thread;
      if (!a || !t || a.kind === 'bank') return;
      if (isClosed(a)) {
        this.notice(T('Заявка уже закрыта. Для следующего сбора нажмите «Новая заявка».'));
        return;
      }
      const address = { ...a },
        thread = { ...t },
        replaceResult = resultStatuses.includes(a.status),
        name = this.driverName(),
        brand = SubnexDispatchCore.brandOf(a);
      const text =
        'Your collection booking has been cancelled. If you need a collection in the future, you are welcome to book again.\n\nKind regards,\n' +
        (name ? name + '\n' : '') +
        brand;
      this.modal(
        T('Закрыть текущую заявку'),
        `<p><b>${esc(a.text)}</b></p><p>${T('Текущий статус:')} <b>${esc(collectionState(a))}</b></p>${a.collection_start ? `<p class="oc-help">${T('Дата и время:')} ${esc(slotLabel(a))}</p>` : ''}${replaceResult ? `<p class="oc-help">${T('Результат «')}${esc(collectionState(a))}${T('» будет заменён на «Отменено».')} ${a.status === 'done' ? T('Этот сбор перестанет учитываться как выполненный. ') : ''}${T('Предыдущий результат и заметка сохранятся в истории.')}</p>` : ''}<p class="oc-help">${T('Закроется только этот сбор. Адрес уйдёт из маршрута, история сохранится. Позже можно создать новую заявку с тем же адресом и номером.')}</p><label>${T('Причина')}<select id="oc-cancel-reason">${Object.entries(
          cancellationReasons,
        )
          .map(([v, n]) => `<option value="${v}">${n}</option>`)
          .join(
            '',
          )}</select></label><label>${T('Примечание')}<input id="oc-cancel-note" maxlength="2000"></label><p class="oc-help">${T('Если клиент просит другую дату, оставьте заявку открытой и используйте подбор времени.')}</p><label><input id="oc-cancel-agreed" type="checkbox">${replaceResult ? T('Заменить прежний результат на «Отменено»') : T('Закрыть именно эту заявку')}</label>${t.opted_out ? `<p class="oc-help">${T('SMS отключены клиентом. Закрытие заявки не отменяет этот запрет.')}</p>` : `<label><input id="oc-cancel-sms" type="checkbox" checked>${T('Отправить SMS об отмене')}</label><p class="oc-help">${T('После закрытия сообщение отправится автоматически. Снимите галочку, если уже ответили клиенту.')}</p><div class="oc-preview" style="white-space:pre-wrap">${esc(text)}</div>`}`,
        async (w) => {
          if (this.sendBusy) throw new Error(T('Дождитесь завершения отправки SMS.'));
          if (!w.querySelector('#oc-cancel-agreed').checked) throw new Error(codes.CANCELLATION_REQUIRED);
          const reason = w.querySelector('#oc-cancel-reason').value,
            sendSms = !!w.querySelector('#oc-cancel-sms')?.checked;
          this.sendBusy = true;
          let result;
          try {
            const { data, error } = await this.sb.rpc('subnex_close_collection_notified', {
              p_data: {
                thread_id: thread.id,
                address_id: address.id,
                version: address.collection_version,
                expected_status: address.status,
                expected_done_at: address.done_at || null,
                expected_result_note: address.result_note || '',
                replace_result: replaceResult,
                reason,
                note: w.querySelector('#oc-cancel-note').value,
                agreed: true,
                send_sms: sendSms,
              },
            });
            if (error) {
              const code = Object.keys(codes).find((c) => error.message?.includes(c));
              throw new Error(
                code ? codes[code] : T('Не удалось закрыть заявку. Проверьте установку 05_auto_sms.sql и обновите переписку.'),
              );
            }
            result = data;
          } finally {
            this.sendBusy = false;
          }
          if (!result?.id) throw new Error(T('Сервер не подтвердил закрытие. Обновите переписку.'));
          this.drafts.delete(thread.id);
          sessionStorage.removeItem('subnex_sms_pending_' + this.profile.user_id + '_' + thread.id);
          this.pending = null;
          if (!this.closed && this.threadId === thread.id) {
            this.mode = 'reply';
            await this.loadDetail(true);
            await this.loadList();
            if (this.data?.thread.closed_request?.id === result.id && !this.data.address) {
              const n = result.notification;
              let notice = T('Заявка закрыта. История сохранена.');
              if (n?.state === 'pending') notice = T('Заявка закрыта. SMS об отмене в очереди на отправку.');
              else if (n?.state === 'accepted') notice = T('Заявка закрыта. Статус SMS показан в истории.');
              else if (n?.state === 'disabled' && sendSms) notice = T('Заявка закрыта. Автоматические SMS ещё не включены.');
              else if (n?.state === 'skipped' && n.reason === 'OPTED_OUT') notice = T('Заявка закрыта. Клиент отключил SMS.');
              else if (n?.state === 'skipped' && sendSms)
                notice = T('Заявка закрыта. SMS не отправлена — проверьте номер клиента и текущую заявку.');
              else if (['failed', 'unknown'].includes(n?.state))
                notice = T('Заявка закрыта. Проверьте статус SMS в истории перед повторной отправкой.');
              this.notice(notice);
            }
          }
          this.o.onChanged?.({ kind: 'collection_closed', date: address.date, address_id: address.id });
        },
        T('Закрыть заявку'),
      );
    }
    changeCategory() {
      if (!this.admin || !this.data?.address || this.sendBusy) return;
      const address = { ...this.data.address },
        threadId = this.threadId;
      this.modal(
        T('Категория сбора'),
        `<label>${T('Категория')}<select id="oc-category">${Object.entries(sources)
          .map(([v, n]) => `<option value="${v}" ${v === address.collection_source ? 'selected' : ''}>${esc(n)}</option>`)
          .join(
            '',
          )}</select></label><p class="oc-help">${T('Категория определяет шаблон новых SMS. Согласованные дата и время сохраняются.')}</p>`,
        async (w) => {
          if (this.sendBusy) throw new Error(T('Дождитесь завершения отправки SMS.'));
          const source = w.querySelector('#oc-category').value;
          if (!Object.hasOwn(sources, source)) throw new Error(T('Выберите категорию из списка.'));
          if (source === address.collection_source) return;
          const { data, error } = await this.sb
            .from('addresses')
            .update({ collection_source: source })
            .eq('id', address.id)
            .eq('collection_source', address.collection_source)
            .eq('collection_version', address.collection_version)
            .select('id');
          if (error) throw new Error(T('Не удалось сохранить категорию. Обновите переписку и проверьте доступ.'));
          if (!data?.length) throw new Error(T('Адрес изменился или недоступен. Обновите переписку и повторите.'));
          if (!this.closed && this.threadId === threadId && this.data?.address?.id === address.id) {
            this.rememberDraft();
            const draft = this.drafts.get(threadId);
            this.data.address.collection_source = source;
            if (draft && this.mode === 'offer') delete draft.body;
            this.compose(draft);
            this.renderHead();
            this.notice(T('Категория сохранена: ') + sources[source] + '.');
            await this.loadList();
          }
          this.o.onChanged?.();
        },
      );
    }
    assign() {
      this.modal(
        T('Назначить водителя'),
        `<label>${T('Водитель')}<select id="oc-assignee">${this.driverOptions(this.data.thread.driver_id)}</select></label><p class="oc-help">${T('История останется у компании. Доступ перейдёт назначенному водителю. Незавершённое предложение перейдёт в ручное согласование.')}</p>`,
        async (w) => {
          await this.call('assign', { thread_id: this.threadId, driver_id: w.querySelector('#oc-assignee').value });
          await this.loadDetail();
          await this.loadList();
          this.o.onChanged?.();
        },
      );
    }
    async settings() {
      const result = await this.run(async () => ({ hours: await this.call('hours'), members: await this.call('members') }));
      if (!result) return;
      const days = [T('Воскресенье'), T('Понедельник'), T('Вторник'), T('Среда'), T('Четверг'), T('Пятница'), T('Суббота')];
      const w = this.modal(
        T('Рабочий график и доступ'),
        `<h3>${T('Прибытие к клиентам · время Великобритании')}</h3><div class="oc-muted">${T('С — самое раннее прибытие к клиенту, До — самое позднее. Выезд из дома может быть раньше, склад — позже. Изменения не переносят существующие договорённости.')}</div><div class="oc-hours">${result.hours.week.map((x) => `<div class="oc-row oc-between oc-member"><span>${days[x.weekday]} · ${x.closed ? T('выходной') : x.opens.slice(0, 5) + '–' + x.closes.slice(0, 5)}</span><button data-hour="${x.weekday}">${T('Изменить')}</button></div>`).join('')}</div><button id="oc-day-override">${T('Исключение на дату')}</button>${result.hours.days.map((x) => `<div class="oc-row oc-between">${esc(x.day)} · ${x.closed ? T('выходной') : esc(x.opens.slice(0, 5) + '–' + x.closes.slice(0, 5))}<button data-remove-day="${esc(x.day)}">${T('Сбросить')}</button></div>`).join('')}<h3>${T('Аккаунты')}</h3>${result.members.members.map((m) => `<div class="oc-member"><b>${esc(m.email)}</b><br><small>${m.role === 'admin' ? T('Администратор') : T('Водитель')} · ${m.active ? T('активен') : T('отключён')}</small></div>`).join('')}<button id="oc-manage-member">${T('Назначить / изменить доступ')}</button>`,
        null,
      );
      w.querySelectorAll('[data-hour]').forEach(
        (b) =>
          (b.onclick = () => {
            const day = Number(b.dataset.hour);
            const h = result.hours.week.find((x) => x.weekday === day);
            this.hoursForm(h, days[day]);
          }),
      );
      w.querySelector('#oc-day-override').onclick = () =>
        this.hoursForm({ day: ukDate(), opens: '08:00', closes: '16:00', closed: false }, T('Исключение на дату'));
      w.querySelectorAll('[data-remove-day]').forEach(
        (b) =>
          (b.onclick = async () => {
            const ok = await this.run(() => this.call('save_hours', { day: b.dataset.removeDay, remove: true }));
            if (ok) this.settings();
          }),
      );
      w.querySelector('#oc-manage-member').onclick = () =>
        this.modal(
          T('Доступ пользователя'),
          `<p class="oc-help">${T('Сначала создайте пользователя с подтверждённым email в Supabase → Authentication → Users. Пароль передайте ему лично.')}</p><label>Email<input id="oc-member-email" type="email"></label><label>${T('Роль')}<select id="oc-member-role"><option value="driver">${T('Водитель')}</option><option value="admin">${T('Администратор')}</option></select></label><label>${T('Водитель')}<select id="oc-member-driver">${this.driverOptions()}</select></label><label><input id="oc-member-active" type="checkbox" checked>${T('Доступ включён')}</label>`,
          async (m) => {
            await this.call('save_member', {
              email: m.querySelector('#oc-member-email').value,
              role: m.querySelector('#oc-member-role').value,
              driver_id: m.querySelector('#oc-member-driver').value,
              active: m.querySelector('#oc-member-active').checked,
            });
            this.notice(T('Доступ сохранён.'));
          },
        );
    }
    hoursForm(h, title) {
      this.modal(
        title,
        `${h.day ? `<label>${T('Дата')}<input id="oc-hours-day" type="date" value="${esc(h.day)}"></label>` : ''}<div class="oc-slots"><label>${T('Первое прибытие с')}<input id="oc-hours-open" type="time" value="${h.opens.slice(0, 5)}"></label><label>${T('Последнее прибытие до')}<input id="oc-hours-close" type="time" value="${h.closes.slice(0, 5)}"></label></div><label><input id="oc-hours-closed" type="checkbox" ${h.closed ? 'checked' : ''}>${T('Выходной')}</label>`,
        async (w) => {
          await this.call('save_hours', {
            ...(h.day ? { day: w.querySelector('#oc-hours-day').value } : { weekday: h.weekday }),
            opens: w.querySelector('#oc-hours-open').value,
            closes: w.querySelector('#oc-hours-close').value,
            closed: w.querySelector('#oc-hours-closed').checked,
          });
          this.notice(T('График сохранён.'));
        },
      );
    }
  }
  window.Ops = {
    api,
    profile: (sb) => api(sb, 'profile'),
    open,
    close,
    esc,
    error: errText,
    dayHint: staleDayHint,
    reasonLabel,
    offerText: (source, day, start, end, name) => {
      const t = partnerOffer(day, start, end, name);
      return t && source === 'subnex' ? subnexOffer(t) : t;
    },
    signPhotos,
    photoUrl,
    slotLabel,
    ukDate,
    ukTime,
    current: () => current,
    settings: () => current?.settings(),
    clear: () => {
      photoCache.clear();
      close();
    },
  };
})();
