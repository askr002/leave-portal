/* Leave portal front end. Plain JavaScript, no build step.
 * Talks to the Apps Script web app with POST text/plain JSON.
 * All page text is set with textContent, never innerHTML, so names and
 * notes from the spreadsheet can't inject markup. */
(function () {
  'use strict';

  var CONFIG = window.LEAVE_PORTAL_CONFIG || {};
  var APP_VERSION = '1.3.0';
  var SESSION_KEY = 'leavePortalSession';
  var state = { session: null, me: null, tab: 'mine', hrTab: 'queue', balanceYear: null, hrPerson: null, hrPersonYear: null,
    hrEditing: false, hrShowInactive: false, hrOptions: null, notice: null, lastError: null };
  var NEW_PERSON = '__new__';
  var ROLE_TEXT = { employee: 'Employee', hr: 'HR', admin: 'Admin' };

  /* ------------------------------- Helpers ------------------------------- */

  function $(id) { return document.getElementById(id); }

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
    el.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  var dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  var dateFmtYear = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  function isoToDate(iso) { var p = iso.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function fmtDate(iso) { return dateFmt.format(isoToDate(iso)); }
  function fmtRange(a, b) { return a === b ? fmtDate(a) : fmtDate(a) + ' – ' + fmtDate(b); }
  function fmtStamp(iso) { return iso ? dateFmtYear.format(new Date(iso)) : ''; }
  function days(n) { n = Math.round(n * 2) / 2; return n + (n === 1 ? ' day' : ' days'); }
  function halfLabel(h) { return h === 'FIRST' ? 'first half, 9–1 ET' : h === 'SECOND' ? 'second half, 1–5 ET' : ''; }
  var STATUS_TEXT = { PENDING: 'Waiting for HR', APPROVED: 'Approved', DENIED: 'Declined', CANCELLED: 'Cancelled', REVOKED: 'Revoked' };
  function statusChip(s) { return h('span', { class: 'status ' + s, text: STATUS_TEXT[s] || s }); }

  var toastTimer = null;
  function toast(message, isError) {
    var t = $('toast');
    if (isError) state.lastError = message;
    t.textContent = message;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isError || message.length > 60 ? 7000 : 3500);
  }

  /* --------------------------------- API --------------------------------- */

  function api(action, payload) {
    var body = Object.assign({ action: action, session: state.session }, payload || {});
    return fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      credentials: 'omit'
    }).then(function (res) {
      if (!res.ok) throw new Error('The leave portal server did not respond (' + res.status + '). Try again shortly.');
      return res.json();
    }).then(function (json) {
      if (json.ok) return json.data;
      if (json.error && json.error.code === 'SESSION') { signOut(json.error.message); }
      var err = new Error(json.error ? json.error.message : 'Something went wrong.');
      err.code = json.error && json.error.code;
      throw err;
    }, function (err) {
      if (err instanceof TypeError) throw new Error('Could not reach the leave portal. Check your connection and try again.');
      throw err;
    });
  }

  /* ------------------------------- Sign in ------------------------------- */

  function showSignIn(message) {
    $('app').hidden = true;
    $('signin').hidden = false;
    $('signin-org').textContent = CONFIG.ORG_NAME || '';
    var err = $('signin-error');
    err.hidden = !message;
    err.textContent = message || '';
    renderGoogleButton();
  }

  var gsiReady = false;
  function renderGoogleButton() {
    if (!window.google || !google.accounts || !google.accounts.id) {
      setTimeout(renderGoogleButton, 200);
      return;
    }
    if (!gsiReady) {
      google.accounts.id.initialize({
        client_id: CONFIG.CLIENT_ID,
        callback: onCredential,
        auto_select: false,
        cancel_on_tap_outside: true,
        use_fedcm_for_prompt: true
      });
      gsiReady = true;
    }
    google.accounts.id.renderButton(clear($('gsi-button')), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: 300 });
  }

  function onCredential(response) {
    $('signin-error').hidden = true;
    api('auth.login', { idToken: response.credential }).then(function (data) {
      state.session = data.session;
      try { sessionStorage.setItem(SESSION_KEY, data.session); } catch (e) {}
      startApp(data.me);
    }).catch(function (err) { showSignIn(err.message); });
  }

  function signOut(message) {
    var old = state.session;
    state.session = null;
    state.me = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    if (old && !message) api('auth.logout', { session: old }).catch(function () {});
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    showSignIn(message);
  }

  /* -------------------------------- App -------------------------------- */

  function startApp(me) {
    state.me = me;
    state.balanceYear = state.balanceYear || Number(me.today.slice(0, 4));
    $('signin').hidden = true;
    $('app').hidden = false;
    $('who-name').textContent = me.profile.name;
    $('report-bug').hidden = !(me.features && me.features.bugReports);
    renderTabs();
    show(state.tab);
  }

  function availableTabs() {
    var p = state.me.profile;
    var tabs = [{ id: 'mine', label: 'My leave' }];
    if (p.isManager) tabs.push({ id: 'team', label: 'My team' });
    if (p.isHr) tabs.push({ id: 'hr', label: 'HR' });
    return tabs;
  }

  function renderTabs() {
    var nav = clear($('tabs'));
    availableTabs().forEach(function (t) {
      nav.appendChild(h('button', {
        type: 'button', class: 'tab', 'aria-current': state.tab === t.id ? 'page' : false,
        onclick: function () { show(t.id); }
      }, t.label));
    });
  }

  function show(tab) {
    if (!availableTabs().some(function (t) { return t.id === tab; })) tab = 'mine';
    state.tab = tab;
    renderTabs();
    var main = clear($('main'));
    if (tab === 'mine') renderMine(main);
    if (tab === 'team') renderTeam(main);
    if (tab === 'hr') renderHr(main);
  }

  function refreshMe() {
    return api('me.get').then(function (me) { state.me = me; if (state.tab === 'mine') show('mine'); });
  }

  /* ------------------------------ My leave ------------------------------ */

  function renderMine(main) {
    var me = state.me;
    var years = Object.keys(me.balances).map(Number).sort();
    if (years.indexOf(state.balanceYear) === -1) state.balanceYear = years[0];

    var yearSwitch = years.length > 1 ? h('div', { class: 'year-switch', role: 'group', 'aria-label': 'Balance year' },
      years.map(function (y) {
        return h('button', { type: 'button', 'aria-pressed': String(y === state.balanceYear), onclick: function () { state.balanceYear = y; show('mine'); } }, String(y));
      })) : null;

    main.appendChild(h('div', { class: 'page-head' },
      h('h1', { text: 'Hi, ' + me.profile.name.split(' ')[0] }),
      h('p', { text: 'Dates are workdays on Eastern Time. Weekends and your holidays are never counted.' })));

    main.appendChild(h('div', { class: 'split' },
      h('div', { class: 'stack' },
        h('section', { class: 'panel', 'aria-labelledby': 'bal-h' },
          h('div', { class: 'panel-head' }, h('h2', { id: 'bal-h', text: 'Your balance' }), yearSwitch),
          balanceList(me.balances[state.balanceYear] || []),
          pipLegend()),
        h('section', { class: 'panel', 'aria-labelledby': 'req-h' },
          h('h2', { id: 'req-h', text: 'Request leave' }),
          requestForm()),
        me.holidays.length ? h('section', { class: 'panel', 'aria-labelledby': 'hol-h' },
          h('h2', { id: 'hol-h', text: 'Upcoming holidays' }),
          h('div', { class: 'holidays' }, me.holidays.slice(0, 8).map(function (x) {
            return h('div', null, h('span', { text: x.name }), h('span', { class: 'muted', text: fmtDate(x.date) }));
          }))) : null),
      h('section', { class: 'panel', 'aria-labelledby': 'mine-h' },
        h('h2', { id: 'mine-h', text: 'Your requests' }),
        myRequests(me.requests))));
  }

  function balanceList(balances) {
    if (!balances.length) return h('p', { class: 'empty', text: 'No leave types are set up for you yet. Ask HR.' });
    return h('div', { class: 'balances' }, balances.map(function (b) {
      if (!b.requiresBalance) {
        return h('div', { class: 'balance' },
          h('div', { class: 'balance-top' }, h('h3', { text: b.name }),
            h('span', { class: 'balance-meta', text: days(b.taken) + ' taken' + (b.pending ? ', ' + days(b.pending) + ' waiting' : '') })),
          h('p', { class: 'balance-meta', text: b.paid ? 'No fixed allowance.' : 'Unpaid. No fixed allowance; days are deducted from pay.' }));
      }
      return h('div', { class: 'balance' },
        h('div', { class: 'balance-top' },
          h('h3', { text: b.name }),
          h('span', { class: 'balance-left' }, String(Math.round(b.remaining * 2) / 2), h('small', { text: ' left' }))),
        pipStrip(b),
        h('p', { class: 'balance-meta', text:
          days(b.allocated) + ' allowance' + (b.adjustments ? ', ' + (b.adjustments > 0 ? '+' : '') + b.adjustments + ' adjusted' : '') +
          ', ' + days(b.taken) + ' taken' + (b.pending ? ', ' + days(b.pending) + ' waiting for HR' : '') }));
    }));
  }

  /** One square per day: taken (solid), waiting (striped), left (outline). Half days are half squares. */
  function pipStrip(b) {
    var MAX = 40;
    var segments = [['taken', b.taken], ['pending', b.pending], ['', Math.max(b.remaining, 0)], ['over', Math.max(-b.remaining, 0)]];
    var total = segments.reduce(function (s, x) { return s + x[1]; }, 0);
    if (total > MAX || total === 0) return null;
    var strip = h('div', { class: 'pips', role: 'img', 'aria-label': days(b.taken) + ' taken, ' + days(b.pending) + ' waiting, ' + days(Math.max(b.remaining, 0)) + ' left' });
    segments.forEach(function (seg) {
      var n = seg[1];
      while (n >= 1) { strip.appendChild(h('span', { class: 'pip ' + seg[0] })); n -= 1; }
      if (n >= 0.5) strip.appendChild(h('span', { class: 'pip half ' + seg[0] }));
    });
    return strip;
  }

  function pipLegend() {
    return h('div', { class: 'pip-legend', 'aria-hidden': 'true' },
      h('span', null, h('span', { class: 'pip taken' }), 'Taken'),
      h('span', null, h('span', { class: 'pip pending' }), 'Waiting for HR'),
      h('span', null, h('span', { class: 'pip' }), 'Left'));
  }

  function requestForm() {
    var me = state.me;
    var today = me.today;
    var typeSel = h('select', { id: 'f-type', required: true },
      me.leaveTypes.map(function (t) { return h('option', { value: t.code, text: t.name }); }));
    var start = h('input', { id: 'f-start', type: 'date', required: true, value: today });
    var end = h('input', { id: 'f-end', type: 'date', required: true, value: today });
    var half = h('select', { id: 'f-half' },
      h('option', { value: '', text: 'Full day' }),
      h('option', { value: 'FIRST', text: 'First half (9–1 ET)' }),
      h('option', { value: 'SECOND', text: 'Second half (1–5 ET)' }));
    var halfField = h('div', { class: 'field' }, h('label', { for: 'f-half', text: 'Length' }), half);
    var note = h('textarea', { id: 'f-note', rows: 2, maxlength: 500 });
    var preview = h('p', { class: 'preview', 'aria-live': 'polite', hidden: true });
    var submit = h('button', { type: 'submit', class: 'button', text: 'Request leave' });

    function currentType() { return me.leaveTypes.filter(function (t) { return t.code === typeSel.value; })[0]; }
    function syncHalf() {
      var t = currentType();
      var canHalf = t && t.allowHalfDay && start.value && start.value === end.value;
      halfField.hidden = !canHalf;
      if (!canHalf) half.value = '';
    }
    var timer = null;
    function refreshPreview() {
      syncHalf();
      clearTimeout(timer);
      if (!start.value || !end.value) { preview.hidden = true; return; }
      if (end.value < start.value) { showPreview('The end date is before the start date.', true); return; }
      timer = setTimeout(function () {
        api('leave.preview', { type: typeSel.value, startDate: start.value, endDate: end.value, halfDay: half.value })
          .then(function (r) {
            var text = days(r.days) + ' of ' + currentType().name + '.';
            showPreview(r.warning ? text + ' ' + r.warning : text, !!r.warning);
          })
          .catch(function (err) { showPreview(err.message, true); });
      }, 350);
    }
    function showPreview(text, warn) { preview.textContent = text; preview.className = 'preview' + (warn ? ' warn' : ''); preview.hidden = false; }

    start.addEventListener('change', function () { if (!end.value || end.value < start.value) end.value = start.value; refreshPreview(); });
    [typeSel, end, half].forEach(function (el) { el.addEventListener('change', refreshPreview); });

    var form = h('form', { class: 'form', onsubmit: function (e) {
      e.preventDefault();
      submit.disabled = true;
      api('leave.create', { type: typeSel.value, startDate: start.value, endDate: end.value, halfDay: half.value, note: note.value })
        .then(function (r) {
          toast(r.warning ? 'Leave requested. ' + r.warning : (state.me.profile.isHr ? 'Leave requested. Another HR person or an admin will review it.' : 'Leave requested. HR will review it.'), !!r.warning);
          return refreshMe();
        })
        .catch(function (err) { toast(err.message, true); })
        .then(function () { submit.disabled = false; });
    } },
      h('div', { class: 'field' }, h('label', { for: 'f-type', text: 'Type' }), typeSel),
      h('div', { class: 'row' },
        h('div', { class: 'field' }, h('label', { for: 'f-start', text: 'From' }), start),
        h('div', { class: 'field' }, h('label', { for: 'f-end', text: 'To' }), end)),
      halfField,
      h('div', { class: 'field' },
        h('label', { for: 'f-note', text: 'Note for HR (optional)' }), note,
        h('p', { class: 'hint', text: 'Only HR sees this. You never need to give a reason or medical details.' })),
      preview,
      h('div', { class: 'form-actions' }, submit));
    setTimeout(refreshPreview, 0);
    return form;
  }

  function myRequests(list) {
    if (!list.length) return h('p', { class: 'empty', text: 'No requests yet. Your requests and their status will appear here.' });
    var today = state.me.today;
    return h('ul', { class: 'list' }, list.map(function (r) {
      var canCancel = r.status === 'PENDING' || (r.status === 'APPROVED' && r.startDate > today);
      return h('li', { class: 'item' },
        h('div', { class: 'item-top' },
          h('span', { class: 'dates', text: fmtRange(r.startDate, r.endDate) }),
          statusChip(r.status)),
        h('span', { class: 'muted', text: r.typeName + ', ' + days(r.days) + (r.halfDay ? ' (' + halfLabel(r.halfDay) + ')' : '') + (r.recordedByHr ? ', recorded by HR' : '') }),
        r.note ? h('p', { class: 'quote', text: 'Your note: ' + r.note }) : null,
        r.hrComment ? h('p', { class: 'quote', text: 'HR: ' + r.hrComment }) : null,
        canCancel ? h('div', null, h('button', { type: 'button', class: 'button quiet small', onclick: function (e) {
          e.target.disabled = true;
          api('leave.cancel', { id: r.id })
            .then(function () { toast('Request cancelled.'); return refreshMe(); })
            .catch(function (err) { toast(err.message, true); e.target.disabled = false; });
        } }, 'Cancel request')) : null);
    }));
  }

  /* ------------------------------- Team ------------------------------- */

  function renderTeam(main) {
    main.appendChild(h('div', { class: 'page-head' },
      h('h1', { text: 'My team' }),
      h('p', { text: 'Your direct reports: who is out today, leave in the next 90 days, and what they have left this year.' })));
    var holder = h('div', { class: 'loading', text: 'Loading your team…' });
    main.appendChild(holder);
    api('team.overview').then(function (data) {
      holder.replaceWith(peopleGrid(data.people, false));
    }).catch(function (err) { holder.textContent = err.message; });
  }

  function peopleGrid(people, clickable) {
    if (!people.length) return h('p', { class: 'empty', text: 'Nobody reports to you in the portal yet.' });
    return h('div', { class: 'people' }, people.map(function (p) {
      return h('article', { class: 'person' },
        h('div', { class: 'person-top' },
          h('h3', { text: p.name }),
          h('span', { class: 'muted small', text: p.country })),
        p.outToday ? h('p', { class: 'out-today', text: 'Out today' + (p.outToday.halfDay ? ' (half day)' : ', back after ' + fmtDate(p.outToday.until)) }) : null,
        p.upcoming.length ? h('ul', { class: 'list' }, p.upcoming.map(function (r) {
          return h('li', { class: 'item' },
            h('div', { class: 'item-top' }, h('span', { class: 'dates', text: fmtRange(r.startDate, r.endDate) }), statusChip(r.status)),
            h('span', { class: 'muted small', text: r.typeName + ', ' + days(r.days) }));
        })) : h('p', { class: 'muted small', text: 'No leave in the next 90 days.' }),
        miniBalances(p.balances));
    }));
  }

  function miniBalances(balances) {
    var tracked = (balances || []).filter(function (b) { return b.requiresBalance; });
    if (!tracked.length) return null;
    return h('div', { class: 'mini-balances' }, tracked.map(function (b) {
      return h('span', null, b.name + ' ', h('b', { text: String(Math.round(b.remaining * 2) / 2) }), ' left');
    }));
  }

  /* -------------------------------- HR -------------------------------- */

  function renderHr(main) {
    var tabs = [['queue', 'Approvals'], ['people', 'People'], ['payroll', 'Payroll export']];
    main.appendChild(h('div', { class: 'page-head' }, h('h1', { text: 'HR' })));
    main.appendChild(h('nav', { class: 'subtabs', 'aria-label': 'HR sections' }, tabs.map(function (t) {
      return h('button', { type: 'button', class: 'subtab', 'aria-current': state.hrTab === t[0] ? 'page' : false,
        onclick: function () { state.hrTab = t[0]; state.hrPerson = null; state.hrEditing = false; show('hr'); } }, t[1]);
    })));
    if (state.notice) {
      main.appendChild(h('div', { class: 'notice', role: 'status' }, state.notice.map(function (t) { return h('p', { text: t }); })));
      state.notice = null;
    }
    var body = h('div', { class: 'stack' });
    main.appendChild(body);
    if (state.hrTab === 'queue') hrQueue(body);
    if (state.hrTab === 'people') {
      if (state.hrPerson === NEW_PERSON) hrNewPerson(body);
      else if (state.hrPerson) hrPerson(body, state.hrPerson);
      else hrPeople(body);
    }
    if (state.hrTab === 'payroll') hrPayroll(body);
  }

  function hrQueue(body) {
    body.appendChild(h('div', { class: 'loading', text: 'Loading requests…' }));
    api('hr.queue').then(function (data) {
      clear(body);
      if (!data.pending.length) { body.appendChild(h('p', { class: 'empty', text: 'No requests are waiting. New ones appear here as soon as they are made.' })); return; }
      data.pending.forEach(function (r) { body.appendChild(approvalCard(r)); });
    }).catch(function (err) { clear(body).appendChild(h('p', { class: 'empty', text: err.message })); });
  }

  function approvalCard(r) {
    var comment = h('input', { type: 'text', maxlength: 500, placeholder: 'Comment for the employee (optional)', 'aria-label': 'Comment for ' + r.employeeName });
    function decide(decision, btn) {
      btn.disabled = true;
      api('hr.decide', { id: r.id, decision: decision, comment: comment.value })
        .then(function () { toast(decision === 'APPROVE' ? 'Approved.' : 'Declined.'); show('hr'); })
        .catch(function (err) { toast(err.message, true); btn.disabled = false; });
    }
    var ctx = r.balanceContext;
    return h('article', { class: 'approval' },
      h('div', { class: 'item-top' },
        h('h3', { text: r.employeeName }),
        h('span', { class: 'muted small', text: 'Requested ' + fmtStamp(r.createdAt) })),
      h('p', null, h('span', { class: 'dates', text: fmtRange(r.startDate, r.endDate) }),
        ', ' + r.typeName + ', ' + days(r.days) + (r.halfDay ? ' (' + halfLabel(r.halfDay) + ')' : '')),
      ctx ? h('p', { class: 'muted small', text: days(ctx.available) + ' available in ' + ctx.year + ' before this request' +
        (ctx.pending - r.days > 0 ? ', plus ' + days(ctx.pending - r.days) + ' in other waiting requests' : '') + '.' }) : null,
      r.note ? h('p', { class: 'quote', text: r.note }) : null,
      r.canDecide ? h('div', { class: 'approval-actions' }, comment,
        h('button', { type: 'button', class: 'button', onclick: function (e) { decide('APPROVE', e.target); } }, 'Approve'),
        h('button', { type: 'button', class: 'button quiet', onclick: function (e) { decide('DENY', e.target); } }, 'Decline'))
        : h('p', { class: r.approverWarning ? 'preview warn' : 'muted small', text: 'This is your own request. Another HR person or an admin needs to decide it.' + (r.approverWarning ? ' ' + r.approverWarning : '') }));
  }

  function hrPeople(body) {
    body.appendChild(h('div', { class: 'loading', text: 'Loading people…' }));
    api('hr.employees', { includeInactive: state.hrShowInactive }).then(function (data) {
      clear(body);
      state.hrOptions = data.options;
      var typeNames = [];
      data.people.forEach(function (p) { p.balances.forEach(function (b) { if (b.requiresBalance && typeNames.indexOf(b.name) === -1) typeNames.push(b.name); }); });
      var table = h('table', null,
        h('thead', null, h('tr', null, h('th', { text: 'Name' }), h('th', { text: 'Role' }), h('th', { text: 'Country' }), h('th', { text: 'Today' }),
          typeNames.map(function (n) { return h('th', { class: 'num', text: n + ' left' }); }))),
        h('tbody', null, data.people.map(function (p) {
          var byName = {};
          p.balances.forEach(function (b) { byName[b.name] = b; });
          var open = function () { state.hrPerson = p.email; state.hrPersonYear = null; state.hrEditing = false; show('hr'); };
          return h('tr', { class: 'clickable' + (p.active ? '' : ' inactive'), tabindex: 0, onclick: open, onkeydown: function (e) { if (e.key === 'Enter') open(); } },
            h('td', null, h('b', { text: p.name }), h('br'), h('span', { class: 'muted small', text: p.email })),
            h('td', { text: p.role === 'employee' ? '' : ROLE_TEXT[p.role] }),
            h('td', { text: p.country }),
            h('td', { text: !p.active ? 'Inactive' : p.outToday ? 'Out' : '' }),
            typeNames.map(function (n) { var b = byName[n]; return h('td', { class: 'num', text: b ? String(Math.round(b.remaining * 2) / 2) : '–' }); }));
        })));
      var showLeft = h('input', { type: 'checkbox', id: 'show-left', checked: state.hrShowInactive,
        onchange: function () { state.hrShowInactive = showLeft.checked; show('hr'); } });
      body.appendChild(h('section', { class: 'panel' },
        h('div', { class: 'toolbar' },
          h('label', { class: 'check', for: 'show-left' }, showLeft, 'Show people who are no longer active'),
          h('button', { type: 'button', class: 'button', onclick: function () { state.hrPerson = NEW_PERSON; show('hr'); } }, 'Add person')),
        h('p', { class: 'muted small', text: 'Select a person to see their history, change their details, record leave or adjust their balance. Balances are for ' + state.me.today.slice(0, 4) + '.' }),
        data.people.length ? h('div', { class: 'table-wrap' }, table) : h('p', { class: 'empty', text: 'Nobody is in the portal yet. Add the first person.' })));
    }).catch(function (err) { clear(body).appendChild(h('p', { class: 'empty', text: err.message })); });
  }

  function hrNewPerson(body) {
    var render = function (options) {
      clear(body);
      body.appendChild(backLink());
      body.appendChild(h('section', { class: 'panel narrow' },
        h('h2', { text: 'Add person' }),
        h('p', { class: 'muted', text: 'They can sign in as soon as you save, using the Google account with this email.' }),
        employeeForm('create', null, options)));
    };
    if (state.hrOptions) { render(state.hrOptions); return; }
    body.appendChild(h('div', { class: 'loading', text: 'Loading…' }));
    api('hr.employees').then(function (data) { state.hrOptions = data.options; render(data.options); })
      .catch(function (err) { clear(body).appendChild(h('p', { class: 'empty', text: err.message })); });
  }

  function backLink() {
    return h('div', null, h('button', { type: 'button', class: 'link-button', onclick: function () {
      state.hrPerson = null; state.hrEditing = false; show('hr');
    } }, 'Back to everyone'));
  }

  /** Add or edit one person. Role and active are locked where the server would refuse the change anyway. */
  function employeeForm(mode, p, options) {
    var me = state.me.profile;
    p = p || { email: '', name: '', country: '', holidayCalendar: '', managerEmail: '', role: 'employee', joinDate: '', active: true };
    var isSelf = mode === 'update' && p.email === me.email;
    var privileged = p.role === 'hr' || p.role === 'admin';
    var uid = 'e-' + mode;

    var email = mode === 'create'
      ? h('input', { id: uid + '-email', type: 'email', required: true, autocomplete: 'off' })
      : h('input', { id: uid + '-email', type: 'email', value: p.email, readonly: true });
    var name = h('input', { id: uid + '-name', type: 'text', required: true, maxlength: 100, value: p.name });
    var country = h('input', { id: uid + '-country', type: 'text', required: true, maxlength: 2, value: p.country,
      list: uid + '-countries', autocomplete: 'off', placeholder: 'IN' });
    var calendar = h('input', { id: uid + '-cal', type: 'text', maxlength: 20, value: p.holidayCalendar,
      list: uid + '-cals', autocomplete: 'off', placeholder: 'Same as country' });
    var manager = h('select', { id: uid + '-mgr' }, h('option', { value: '', text: 'No manager' }),
      options.managers.filter(function (m) { return m.email !== p.email; })
        .map(function (m) { return h('option', { value: m.email, text: m.name + ' (' + m.email + ')' }); }));
    manager.value = p.managerEmail || '';
    if (p.managerEmail && manager.value !== p.managerEmail) {
      manager.appendChild(h('option', { value: p.managerEmail, text: (p.managerName || p.managerEmail) + ' (inactive)' }));
      manager.value = p.managerEmail;
    }
    var roleLocked = !me.isAdmin || isSelf;
    var role = h('select', { id: uid + '-role', disabled: roleLocked },
      ['employee', 'hr', 'admin'].map(function (r) { return h('option', { value: r, text: ROLE_TEXT[r] }); }));
    role.value = p.role;
    var roleHint = isSelf ? 'You cannot change your own role.'
      : !me.isAdmin ? 'Only admins can give or remove the HR and admin roles.'
      : 'HR and admins can approve leave and manage people. Only admins can change these roles.';
    var join = h('input', { id: uid + '-join', type: 'date', value: p.joinDate });
    var activeLocked = isSelf || (!me.isAdmin && privileged && mode === 'update');
    var active = h('input', { id: uid + '-active', type: 'checkbox', checked: p.active, disabled: activeLocked });
    var save = h('button', { type: 'submit', class: 'button', text: mode === 'create' ? 'Add person' : 'Save changes' });

    return h('form', { class: 'form', onsubmit: function (e) {
      e.preventDefault();
      save.disabled = true;
      api('hr.saveEmployee', {
        mode: mode, email: email.value.trim(), name: name.value, country: country.value, holidayCalendar: calendar.value,
        managerEmail: manager.value, role: role.value, joinDate: join.value, active: active.checked
      }).then(function (r) {
        state.notice = [(mode === 'create' ? r.employee.name + ' was added.' : 'Changes saved.')].concat(r.warnings);
        state.hrOptions = null;
        state.hrPerson = r.employee.email;
        state.hrEditing = false;
        if (r.employee.email === me.email) return refreshMe().then(function () { show('hr'); });
        show('hr');
      }).catch(function (err) { toast(err.message, true); save.disabled = false; });
    } },
      h('div', { class: 'field' }, h('label', { for: uid + '-email', text: 'Work email' }), email,
        h('p', { class: 'hint', text: mode === 'create'
          ? 'The Google account they sign in with. It cannot be changed later.'
          : 'Emails cannot be changed. If someone moves to a new email, add them again and mark this record inactive.' })),
      h('div', { class: 'field' }, h('label', { for: uid + '-name', text: 'Name' }), name),
      h('div', { class: 'row' },
        h('div', { class: 'field' }, h('label', { for: uid + '-country', text: 'Country' }), country,
          h('datalist', { id: uid + '-countries' }, options.countries.map(function (c) { return h('option', { value: c }); })),
          h('p', { class: 'hint', text: 'Two letters. Decides which leave types apply.' })),
        h('div', { class: 'field' }, h('label', { for: uid + '-cal', text: 'Holiday calendar' }), calendar,
          h('datalist', { id: uid + '-cals' }, options.holidayCalendars.map(function (c) { return h('option', { value: c }); })),
          h('p', { class: 'hint', text: 'Which holidays they get. Leave blank to use their country.' }))),
      h('div', { class: 'field' }, h('label', { for: uid + '-mgr', text: 'Manager' }), manager,
        h('p', { class: 'hint', text: 'Their manager sees their leave and balance under My team.' })),
      h('div', { class: 'row' },
        h('div', { class: 'field' }, h('label', { for: uid + '-role', text: 'Role' }), role, h('p', { class: 'hint', text: roleHint })),
        h('div', { class: 'field' }, h('label', { for: uid + '-join', text: 'Join date' }), join,
          h('p', { class: 'hint', text: 'Their first year\'s allowance is pro-rated from this month.' }))),
      h('div', { class: 'field' },
        h('label', { class: 'check', for: uid + '-active' }, active, 'Active: can sign in and request leave'),
        activeLocked ? h('p', { class: 'hint', text: isSelf ? 'You cannot deactivate yourself.' : 'Only admins can deactivate HR or admin accounts.' }) : null),
      h('div', { class: 'form-actions' }, save,
        mode === 'update' ? h('button', { type: 'button', class: 'button quiet', onclick: function () { state.hrEditing = false; show('hr'); } }, 'Cancel') : null));
  }

  function hrPerson(body, email) {
    var year = state.hrPersonYear || Number(state.me.today.slice(0, 4));
    body.appendChild(h('div', { class: 'loading', text: 'Loading…' }));
    api('hr.employee', { email: email, year: year }).then(function (d) {
      clear(body);
      var p = d.profile;
      var isSelf = p.email === state.me.profile.email;
      body.appendChild(backLink());
      body.appendChild(h('div', { class: 'person-head' },
        h('div', { class: 'page-head' },
          h('h2', { text: p.name + (p.active ? '' : ' (inactive)') }),
          h('p', { text: [p.email, ROLE_TEXT[p.role], p.country, p.managerName ? 'reports to ' + p.managerName : 'no manager',
            p.joinDate ? 'joined ' + fmtStamp(p.joinDate + 'T12:00:00Z') : ''].filter(Boolean).join(', ') })),
        state.hrEditing ? null : h('button', { type: 'button', class: 'button quiet', onclick: function () { state.hrEditing = true; show('hr'); } }, 'Edit details')));
      if (state.hrEditing) {
        body.appendChild(h('section', { class: 'panel narrow' }, h('h3', { text: 'Edit details' }), employeeForm('update', p, d.options)));
      }

      var yearSwitch = h('div', { class: 'year-switch', role: 'group', 'aria-label': 'Year' }, [year - 1, year, year + 1].map(function (y) {
        return h('button', { type: 'button', 'aria-pressed': String(y === year), onclick: function () { state.hrPersonYear = y; show('hr'); } }, String(y));
      }));

      body.appendChild(h('div', { class: 'split' },
        h('div', { class: 'stack' },
          h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', { text: 'Balance' }), yearSwitch), balanceList(d.balances), pipLegend()),
          isSelf ? null : h('section', { class: 'panel' }, h('h3', { text: 'Record leave' }), recordForm(d)),
          h('section', { class: 'panel' }, h('h3', { text: 'Adjust balance' }), adjustForm(d, year))),
        h('div', { class: 'stack' },
          h('section', { class: 'panel' }, h('h3', { text: 'Requests' }), hrRequestList(d)),
          h('section', { class: 'panel' }, h('h3', { text: 'Ledger for ' + year }), ledgerTable(d.ledger)))));
    }).catch(function (err) { clear(body).appendChild(h('p', { class: 'empty', text: err.message })); });
  }

  function hrRequestList(d) {
    var list = d.requests;
    if (!list.length) return h('p', { class: 'empty', text: 'No requests.' });
    var isSelf = d.profile.email === state.me.profile.email;
    return h('ul', { class: 'list' }, list.map(function (r) {
      var open = r.status === 'PENDING' || r.status === 'APPROVED';
      var actions = [];
      if (open && !isSelf) {
        actions.push(h('button', { type: 'button', class: 'button quiet small', onclick: function () { changeRequestDialog(r, d); } }, 'Change'));
      }
      if (r.status === 'APPROVED') {
        actions.push(h('button', { type: 'button', class: 'button quiet small', onclick: function () {
          askReason('Revoke approved leave', 'The days go back to their balance and the calendar entry is removed.', function (reason) {
            api('hr.revoke', { id: r.id, comment: reason })
              .then(function (res) { toast('Leave revoked.' + payrollNote(res.payrollMonths)); show('hr'); })
              .catch(function (err) { toast(err.message, true); });
          });
        } }, 'Revoke'));
      }
      return h('li', { class: 'item' },
        h('div', { class: 'item-top' }, h('span', { class: 'dates', text: fmtRange(r.startDate, r.endDate) }), statusChip(r.status)),
        h('span', { class: 'muted small', text: r.typeName + ', ' + days(r.days) + (r.halfDay ? ' (' + halfLabel(r.halfDay) + ')' : '') +
          (r.recordedByHr ? ', recorded by ' + r.decidedBy : r.decidedBy ? ', decided by ' + r.decidedBy : '') }),
        r.note ? h('p', { class: 'quote', text: 'Note: ' + r.note }) : null,
        r.hrComment ? h('p', { class: 'quote', text: 'HR: ' + r.hrComment }) : null,
        actions.length ? h('div', { class: 'form-actions' }, actions) : null);
    }));
  }

  function payrollNote(months) {
    if (!months || !months.length) return '';
    return ' Payroll for ' + months.join(' and ') + ' may already be exported. Export ' + (months.length > 1 ? 'those months' : 'it') + ' again.';
  }

  /** Type, dates and half day, shared by "Record leave" and "Change request". */
  function leaveFields(uid, types, initial) {
    initial = initial || {};
    var today = state.me.today;
    var typeSel = h('select', { id: uid + '-type', required: true }, types.map(function (t) { return h('option', { value: t.code, text: t.name }); }));
    if (initial.type) typeSel.value = initial.type;
    var start = h('input', { id: uid + '-start', type: 'date', required: true, value: initial.startDate || today });
    var end = h('input', { id: uid + '-end', type: 'date', required: true, value: initial.endDate || initial.startDate || today });
    var half = h('select', { id: uid + '-half' },
      h('option', { value: '', text: 'Full day' }),
      h('option', { value: 'FIRST', text: 'First half (9–1 ET)' }),
      h('option', { value: 'SECOND', text: 'Second half (1–5 ET)' }));
    half.value = initial.halfDay || '';
    var halfField = h('div', { class: 'field' }, h('label', { for: uid + '-half', text: 'Length' }), half);
    function syncHalf() {
      var t = types.filter(function (x) { return x.code === typeSel.value; })[0];
      var canHalf = t && t.allowHalfDay && start.value && start.value === end.value;
      halfField.hidden = !canHalf;
      if (!canHalf) half.value = '';
    }
    start.addEventListener('change', function () { if (!end.value || end.value < start.value) end.value = start.value; });
    [typeSel, start, end, half].forEach(function (el) { el.addEventListener('change', syncHalf); });
    syncHalf();
    return {
      nodes: [
        h('div', { class: 'field' }, h('label', { for: uid + '-type', text: 'Type' }), typeSel),
        h('div', { class: 'row' },
          h('div', { class: 'field' }, h('label', { for: uid + '-start', text: 'From' }), start),
          h('div', { class: 'field' }, h('label', { for: uid + '-end', text: 'To' }), end)),
        halfField],
      values: function () { return { type: typeSel.value, startDate: start.value, endDate: end.value, halfDay: half.value }; },
      typeName: function () { return typeSel.options[typeSel.selectedIndex] ? typeSel.options[typeSel.selectedIndex].text : ''; },
      onChange: function (fn) { [typeSel, start, end, half].forEach(function (el) { el.addEventListener('change', fn); }); }
    };
  }

  function recordForm(d) {
    if (!d.leaveTypes.length) return h('p', { class: 'empty', text: 'No leave types apply to this person.' });
    var f = leaveFields('r', d.leaveTypes, { type: (d.leaveTypes.filter(function (t) { return t.code === 'SICK'; })[0] || d.leaveTypes[0]).code });
    var reason = h('input', { id: 'r-reason', type: 'text', maxlength: 500, required: true, placeholder: 'e.g. Called in sick on Discord' });
    var preview = h('p', { class: 'preview', 'aria-live': 'polite', hidden: true });
    var btn = h('button', { type: 'submit', class: 'button', text: 'Record leave' });
    var timer = null;
    function refresh() {
      clearTimeout(timer);
      var v = f.values();
      if (!v.startDate || !v.endDate) { preview.hidden = true; return; }
      timer = setTimeout(function () {
        api('hr.recordLeave', Object.assign({ preview: true, email: d.profile.email }, v)).then(function (r) {
          var text = days(r.days) + ' of ' + f.typeName() + '.' + (r.warning ? ' ' + r.warning : '') + payrollNote(r.payrollMonths);
          preview.textContent = text;
          preview.className = 'preview' + (r.warning || r.payrollMonths.length ? ' warn' : '');
          preview.hidden = false;
        }).catch(function (err) { preview.textContent = err.message; preview.className = 'preview warn'; preview.hidden = false; });
      }, 350);
    }
    f.onChange(refresh);
    setTimeout(refresh, 0);
    return h('form', { class: 'form', onsubmit: function (e) {
      e.preventDefault();
      btn.disabled = true;
      api('hr.recordLeave', Object.assign({ email: d.profile.email, comment: reason.value }, f.values()))
        .then(function (r) { state.notice = ['Leave recorded and approved.' + payrollNote(r.payrollMonths)]; show('hr'); })
        .catch(function (err) { toast(err.message, true); btn.disabled = false; });
    } },
      h('p', { class: 'hint', text: 'For leave they did not request, such as a sick day reported by message. It is approved straight away and can be up to two years in the past.' }),
      f.nodes,
      h('div', { class: 'field' }, h('label', { for: 'r-reason', text: 'Reason' }), reason,
        h('p', { class: 'hint', text: 'They see this on their request.' })),
      preview,
      h('div', { class: 'form-actions' }, btn));
  }

  function changeRequestDialog(r, d) {
    var f = leaveFields('c', d.leaveTypes, r);
    var reason = h('textarea', { id: 'c-reason', rows: 2, maxlength: 500, required: true });
    openDialog('Change request', r.status === 'APPROVED'
      ? 'This leave is approved. The old days go back to their balance and the new days are taken. The calendar is updated and they are told.'
      : 'This request is still waiting. It stays waiting with the new details.',
      [f.nodes, h('div', { class: 'field' }, h('label', { for: 'c-reason', text: 'Reason' }), reason,
        h('p', { class: 'hint', text: 'They see this on their request.' }))],
      'Save change',
      function () {
        return api('hr.editRequest', Object.assign({ id: r.id, comment: reason.value }, f.values())).then(function (res) {
          state.notice = ['Request changed.' + payrollNote(res.payrollMonths)];
          show('hr');
        });
      });
  }

  /* ------------------------------ Report a problem ------------------------------ */

  /** Where the person is, without any names or emails. */
  function currentPage() {
    var labels = { mine: 'My leave', team: 'My team', hr: 'HR' };
    var parts = [labels[state.tab] || state.tab];
    if (state.tab === 'hr') {
      parts.push({ queue: 'Approvals', people: 'People', payroll: 'Payroll export' }[state.hrTab] || state.hrTab);
      if (state.hrTab === 'people' && state.hrPerson) parts.push(state.hrPerson === NEW_PERSON ? 'Add person' : state.hrEditing ? 'Edit details' : 'Person page');
    }
    return parts.join(' > ');
  }

  var BUG_STATUS_CLASS = { 'New': 'PENDING', 'Investigating': 'PENDING', 'Fixed': 'APPROVED' };

  function openBugDialog() {
    var page = currentPage();
    var lastError = state.lastError;
    var summary = h('input', { id: 'b-summary', type: 'text', required: true, maxlength: 120, placeholder: 'e.g. My balance shows the wrong number of days' });
    var details = h('textarea', { id: 'b-details', rows: 5, required: true, maxlength: 4000,
      placeholder: 'What were you doing, what did you expect, and what happened instead?' });
    var include = lastError ? h('input', { type: 'checkbox', id: 'b-error', checked: true }) : null;
    var mine = h('div', { class: 'stack-tight' }, h('p', { class: 'muted small', text: 'Loading your reports…' }));

    api('bugs.mine').then(function (r) {
      clear(mine);
      if (!r.reports.length) { mine.appendChild(h('p', { class: 'muted small', text: 'You have not reported anything yet.' })); return; }
      mine.appendChild(h('ul', { class: 'list' }, r.reports.map(function (b) {
        return h('li', { class: 'item' },
          h('div', { class: 'item-top' },
            h('span', null, h('b', { text: b.summary }), h('span', { class: 'muted small', text: ' ' + fmtStamp(b.createdAt) })),
            h('span', { class: 'status ' + (BUG_STATUS_CLASS[b.status] || 'CANCELLED'), text: b.status })),
          b.reply ? h('p', { class: 'quote', text: 'Reply: ' + b.reply }) : null);
      })));
    }).catch(function (err) { clear(mine).appendChild(h('p', { class: 'muted small', text: err.message })); });

    openDialog('Report a problem', 'Tell us what went wrong. The people who look after the portal read every report.', [
      h('div', { class: 'field' }, h('label', { for: 'b-summary', text: 'Summary' }), summary),
      h('div', { class: 'field' }, h('label', { for: 'b-details', text: 'What happened?' }), details),
      include ? h('div', { class: 'field' },
        h('label', { class: 'check', for: 'b-error' }, include, 'Include the last error message'),
        h('p', { class: 'quote small', text: lastError })) : null,
      h('p', { class: 'hint', text: 'Sent with your name, the screen you are on (' + page + '), your browser and the portal version. Please leave out medical details and anything private.' })
    ], 'Send report', function () {
      return api('bugs.report', {
        summary: summary.value, details: details.value, page: page,
        browser: navigator.userAgent + ', window ' + window.innerWidth + 'x' + window.innerHeight,
        appVersion: APP_VERSION, lastError: include && include.checked ? lastError : ''
      }).then(function () {
        state.lastError = null;
        toast('Report sent. Thank you. You can follow it under Report a problem.');
      });
    }, [h('h3', { text: 'Your reports' }), mine], 'Close');
  }

  /** A modal form. onConfirm returns a promise; errors are shown inside the dialog. */
  function openDialog(title, help, nodes, confirmLabel, onConfirm, after, closeLabel) {
    var dlg = h('dialog', { class: 'wide' });
    var err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    var confirm = h('button', { type: 'submit', class: 'button', text: confirmLabel });
    dlg.appendChild(h('form', { class: 'dialog-form', onsubmit: function (e) {
      e.preventDefault();
      confirm.disabled = true;
      err.hidden = true;
      onConfirm().then(function () { dlg.close(); }, function (x) {
        err.textContent = x.message;
        err.hidden = false;
        confirm.disabled = false;
      });
    } },
      h('h2', { text: title }),
      help ? h('p', { class: 'muted', text: help }) : null,
      nodes,
      err,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'button quiet', onclick: function () { dlg.close(); } }, closeLabel || 'Keep it as it is'),
        confirm)));
    if (after) dlg.appendChild(h('div', { class: 'dialog-after' }, after));
    dlg.addEventListener('close', function () { dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  function ledgerTable(rows) {
    if (!rows.length) return h('p', { class: 'empty', text: 'No balance changes this year.' });
    var REASON = { ALLOCATION: 'Allowance', CARRY_FORWARD: 'Carried over', LEAVE: 'Leave taken', REVERSAL: 'Returned', ADJUSTMENT: 'HR adjustment' };
    return h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', { text: 'Date' }), h('th', { text: 'Type' }), h('th', { text: 'Change' }), h('th', { class: 'num', text: 'Days' }), h('th', { text: 'Details' }))),
      h('tbody', null, rows.map(function (l) {
        return h('tr', null,
          h('td', { text: fmtStamp(l.createdAt) }), h('td', { text: l.type }), h('td', { text: REASON[l.reason] || l.reason }),
          h('td', { class: 'num', text: (l.amount > 0 ? '+' : '') + l.amount }),
          h('td', { class: 'small', text: [l.comment, l.requestId, l.createdBy].filter(Boolean).join(', ') }));
      }))));
  }

  function adjustForm(d, year) {
    var tracked = d.leaveTypes.filter(function (t) { return t.requiresBalance; });
    if (!tracked.length) return h('p', { class: 'empty', text: 'No balance-tracked leave types apply to this person.' });
    var type = h('select', { id: 'a-type' }, tracked.map(function (t) { return h('option', { value: t.code, text: t.name }); }));
    var amount = h('input', { id: 'a-amount', type: 'number', step: '0.5', required: true, placeholder: 'e.g. 2 or -1.5' });
    var reason = h('input', { id: 'a-reason', type: 'text', maxlength: 500, required: true });
    var btn = h('button', { type: 'submit', class: 'button', text: 'Save adjustment' });
    return h('form', { class: 'form', onsubmit: function (e) {
      e.preventDefault();
      btn.disabled = true;
      api('hr.adjust', { email: d.profile.email, type: type.value, year: year, amount: Number(amount.value), comment: reason.value })
        .then(function () { toast('Adjustment saved.'); show('hr'); })
        .catch(function (err) { toast(err.message, true); btn.disabled = false; });
    } },
      h('div', { class: 'row' },
        h('div', { class: 'field' }, h('label', { for: 'a-type', text: 'Type' }), type),
        h('div', { class: 'field' }, h('label', { for: 'a-amount', text: 'Days (+ or −)' }), amount)),
      h('div', { class: 'field' }, h('label', { for: 'a-reason', text: 'Reason' }), reason,
        h('p', { class: 'hint', text: 'Applies to ' + year + '. Shown in the ledger and the audit log.' })),
      h('div', { class: 'form-actions' }, btn));
  }

  function hrPayroll(body) {
    var today = state.me.today;
    var d = isoToDate(today.slice(0, 7) + '-01');
    d.setUTCDate(0);
    var lastMonth = d.toISOString().slice(0, 7);
    var month = h('input', { id: 'p-month', type: 'month', value: lastMonth, required: true });
    var result = h('p', { class: 'preview', hidden: true, 'aria-live': 'polite' });
    var btn = h('button', { type: 'submit', class: 'button', text: 'Export to payroll sheet' });
    body.appendChild(h('section', { class: 'panel' },
      h('h2', { text: 'Payroll export' }),
      h('p', { class: 'muted', text: 'Writes approved leave days per person and type for one month into the payroll spreadsheet. It runs automatically on the 1st for the month before. Exporting a month again replaces its rows, so re-run it after late approvals or revocations.' }),
      h('form', { class: 'form', onsubmit: function (e) {
        e.preventDefault();
        btn.disabled = true;
        api('hr.payrollExport', { month: month.value })
          .then(function (r) { result.textContent = 'Exported ' + r.rows + ' rows for ' + r.month + '.'; result.hidden = false; })
          .catch(function (err) { toast(err.message, true); })
          .then(function () { btn.disabled = false; });
      } },
        h('div', { class: 'field' }, h('label', { for: 'p-month', text: 'Month' }), month),
        h('div', { class: 'form-actions' }, btn),
        result)));
  }

  /* ------------------------------ Reason dialog ------------------------------ */

  function askReason(title, help, onConfirm) {
    var dlg = $('reason-dialog');
    $('reason-title').textContent = title;
    $('reason-help').textContent = help;
    var input = $('reason-input');
    input.value = '';
    $('reason-cancel').onclick = function () { dlg.close(); };
    dlg.onclose = function () {
      if (dlg.returnValue === 'confirm' && input.value.trim()) onConfirm(input.value.trim());
      dlg.returnValue = '';
    };
    dlg.showModal();
    input.focus();
  }

  /* -------------------------------- Boot -------------------------------- */

  $('signout').addEventListener('click', function () { signOut(); });
  $('report-bug').addEventListener('click', openBugDialog);
  window.addEventListener('error', function (e) { state.lastError = 'Page error: ' + (e.message || 'unknown'); });

  function boot() {
    if (!CONFIG.API_URL || /REPLACE_WITH/.test(CONFIG.API_URL + CONFIG.CLIENT_ID)) {
      showSignIn('This portal is not configured yet: set API_URL and CLIENT_ID in config.js.');
      return;
    }
    var saved = null;
    // Local preview only (test/preview-server.js): accept a session from the URL.
    if (CONFIG.API_URL === '/api' && /^#session=[a-f0-9]{64}$/.test(location.hash)) {
      try { sessionStorage.setItem(SESSION_KEY, location.hash.slice(9)); } catch (e) {}
      history.replaceState(null, '', location.pathname);
    }
    try { saved = sessionStorage.getItem(SESSION_KEY); } catch (e) {}
    if (!saved) { showSignIn(); return; }
    state.session = saved;
    api('me.get').then(startApp).catch(function (err) { if (err.code !== 'SESSION') showSignIn(err.message); });
  }

  boot();
})();
