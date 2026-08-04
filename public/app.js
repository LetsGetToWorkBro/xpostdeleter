/**
 * PostCleaner front-end.
 *
 * Deliberately dependency-free: no framework, no build step, no CDN. The whole
 * app is three files the Worker serves straight from the edge.
 *
 * The one rule worth remembering while reading this: client-side filtering is a
 * *preview*. The server re-applies every filter before it deletes anything, so
 * a bug in here can only ever show you the wrong list, never delete the wrong
 * thing.
 */

import { readArchive, analyzeFacebookExport } from '/archive.js';

/* ------------------------------------------------------------------ utils */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const fmtNum = (n) => (Number(n) || 0).toLocaleString();
const fmtMoney = (n) => `$${(Number(n) || 0).toFixed(2)}`;

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins} min`;
  const hours = mins / 60;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hr`;
  return `${(hours / 24).toFixed(1)} days`;
}

function fmtWhen(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const diff = ts - Date.now();
  if (diff > 0 && diff < 20 * 3600_000) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
}

/**
 * Icons went away with the 1999 restyle — a page of this vintage has no
 * iconography, and the SVG sprite went with it. This stays as a no-op rather
 * than being deleted from ~20 call sites: the generated markup then matches
 * index.html exactly, and there is no second place to keep in sync.
 */
function icon() {
  return '';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/** Avoid emitting <img src=""> — an empty src re-requests the current page. */
function avatarImg(url) {
  return url
    ? `<img class="avatar" src="${escapeHtml(url)}" alt="" />`
    : '<span class="avatar" aria-hidden="true"></span>';
}

const TOASTS = $('#toasts');
function toast(message, kind = 'info', ms = 5200) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  const ico = kind === 'error' ? 'i-warn' : kind === 'success' ? 'i-check' : 'i-info';
  node.innerHTML = `${icon(ico, 17)}<div>${escapeHtml(message)}</div>`;
  TOASTS.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s, transform .2s';
    node.style.opacity = '0';
    node.style.transform = 'translateX(12px)';
    setTimeout(() => node.remove(), 220);
  }, ms);
}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Request failed (${res.status}).`);
    // Callers branch on these — e.g. a 402 is a checkout prompt, not a failure.
    err.code = data?.error?.code;
    err.details = data?.error?.details;
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ------------------------------------------------------------------ state */

const state = {
  session: null,
  x: { source: 'archive', items: [], filtered: [], account: null, jobId: null, mode: 'managed' },
  billing: { pricing: null, wallet: null, quote: null },
  threads: { jobId: null },
  facebook: { pages: [], selectedPage: null, jobId: null },
};

const LS = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`postcleaner:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`postcleaner:${key}`, JSON.stringify(value));
    } catch {
      /* private mode — not important enough to warn about */
    }
  },
};

/* There is no theme. The page is black text on a white background, the same
 * way the counter next door is, and there is nothing to toggle. The stored
 * `postcleaner:theme` preference from the old design is simply ignored. */

/* ------------------------------------------------------------------- tabs */

function showView(name) {
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === name)));
  $$('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
  LS.set('view', name);
  if (name === 'jobs') renderJobs();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$$('.tab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));

/* ------------------------------------------------------------------ modal */

const modal = {
  el: $('#modal'),
  open({ title, sub, body, confirmLabel = 'Delete permanently', requirePhrase = null, danger = true }) {
    return new Promise((resolve) => {
      $('#modal-title').textContent = title;
      $('#modal-sub').textContent = sub ?? '';
      $('#modal-body').innerHTML = body ?? '';
      const confirmBtn = $('#modal-confirm');
      confirmBtn.textContent = confirmLabel;
      confirmBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';

      if (requirePhrase) {
        const field = document.createElement('div');
        field.className = 'field';
        field.innerHTML = `<label for="modal-phrase">Type <code>${escapeHtml(requirePhrase)}</code> to confirm</label>
          <input type="text" id="modal-phrase" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(requirePhrase)}" />`;
        $('#modal-body').append(field);
        confirmBtn.disabled = true;
        const input = $('#modal-phrase');
        input.addEventListener('input', () => {
          confirmBtn.disabled = input.value.trim().toUpperCase() !== requirePhrase.toUpperCase();
        });
        setTimeout(() => input.focus(), 60);
      } else {
        confirmBtn.disabled = false;
        setTimeout(() => confirmBtn.focus(), 60);
      }

      const cancelBtn = $('#modal-cancel');
      const onConfirm = () => close(true);
      const onCancel = () => close(false);
      const onKey = (e) => { if (e.key === 'Escape') close(false); };
      const onBackdrop = (e) => { if (e.target === this.el) close(false); };

      // Every listener is removed on close — a stray backdrop handler would
      // otherwise dismiss the *next* modal the moment it opened.
      const close = (result) => {
        this.el.hidden = true;
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        this.el.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      };

      this.el.hidden = false;
      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      this.el.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
    });
  },
};

/* -------------------------------------------------------------- job monitor */

/**
 * Live progress for one job. Prefers a WebSocket (the Durable Object pushes on
 * every change) and silently falls back to polling if the socket can't open —
 * some corporate proxies still break WS.
 */
class JobMonitor {
  constructor(prefix, { onFinish } = {}) {
    this.p = prefix;
    this.onFinish = onFinish;
    this.jobId = null;
    this.socket = null;
    this.timer = null;
    this.dryRun = false;
    this.bind();
  }

  el(suffix) {
    return $(`#${this.p}-${suffix}`);
  }

  bind() {
    this.el('job-pause')?.addEventListener('click', () => this.control(this.paused ? 'resume' : 'pause'));
    this.el('job-cancel')?.addEventListener('click', async () => {
      const ok = await modal.open({
        title: 'Cancel this job?',
        sub: 'Anything already deleted stays deleted. The rest is left alone.',
        confirmLabel: 'Cancel job',
      });
      if (ok) this.control('cancel');
    });
    this.el('job-export')?.addEventListener('click', () => {
      if (this.jobId) window.open(`/api/jobs/${this.jobId}/log?format=csv`, '_blank', 'noopener');
    });
  }

  attach(jobId) {
    this.detach();
    this.jobId = jobId;
    LS.set(`job:${this.p}`, jobId);
    this.el('step-progress').hidden = false;
    this.el('step-progress').scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.openSocket();
    this.poll();
  }

  detach() {
    if (this.socket) {
      try { this.socket.close(); } catch { /* already gone */ }
      this.socket = null;
    }
    clearTimeout(this.timer);
    this.timer = null;
  }

  openSocket() {
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/api/jobs/${this.jobId}/ws`);
      ws.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'progress' && payload.job) this.render(payload.job);
        } catch { /* ignore malformed frame */ }
      });
      ws.addEventListener('close', () => { this.socket = null; });
      ws.addEventListener('error', () => { this.socket = null; });
      this.socket = ws;
    } catch {
      this.socket = null; // polling covers us
    }
  }

  async poll() {
    if (!this.jobId) return;
    try {
      const { job } = await api(`/api/jobs/${this.jobId}`);
      this.render(job);
      if (['completed', 'cancelled', 'failed'].includes(job.status)) {
        this.detach();
        return;
      }
    } catch (err) {
      // A transient failure shouldn't kill the monitor; the job runs regardless.
      console.warn('poll failed', err);
    }
    // Slow the poll right down when a socket is doing the real-time work.
    this.timer = setTimeout(() => this.poll(), this.socket ? 15000 : 2500);
  }

  async control(action) {
    if (!this.jobId) return;
    try {
      const { job } = await api(`/api/jobs/${this.jobId}/${action}`, { method: 'POST', body: {} });
      this.render(job);
      if (action === 'cancel') this.detach();
      if (action === 'resume' && !this.timer) this.poll();
      toast(
        action === 'pause' ? 'Job paused.' : action === 'resume' ? 'Job resumed.' : 'Job cancelled.',
        'info',
      );
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  render(job) {
    if (!job) return;
    this.dryRun = job.dryRun;
    this.paused = job.status === 'paused';

    const remaining = Math.max(0, job.total - job.cursor);
    const pct = job.total > 0 ? Math.min(100, (job.cursor / job.total) * 100) : job.status === 'discovering' ? 6 : 0;

    const bar = this.el('job-bar');
    bar.style.width = `${pct}%`;
    const meter = bar.parentElement;
    meter.classList.toggle('is-running', ['running', 'discovering', 'queued'].includes(job.status));
    meter.classList.toggle('done', job.status === 'completed');

    const setText = (suffix, value) => { const n = this.el(suffix); if (n) n.textContent = value; };
    setText('v-deleted', fmtNum(job.deleted));
    setText('v-remaining', fmtNum(remaining));
    setText('v-skipped', fmtNum(job.skipped));
    setText('v-failed', fmtNum(job.failed));
    setText('k-deleted', job.dryRun ? 'Would delete' : 'Deleted');
    setText('v-eta', job.status === 'completed' ? 'Done' : job.etaMs ? fmtWhen(job.etaMs) : '—');

    const titles = {
      draft: 'Ready to start',
      queued: 'Starting…',
      discovering: 'Finding your posts…',
      running: job.dryRun ? 'Dry run in progress' : 'Deleting',
      paused: 'Paused',
      completed: job.dryRun ? 'Dry run complete' : 'All done',
      cancelled: 'Cancelled',
      failed: 'Stopped after repeated errors',
    };
    setText('job-title', titles[job.status] ?? job.status);

    const kindLabel = {
      x_posts: 'posts on X',
      x_likes: 'likes on X',
      threads_posts: 'Threads posts',
      facebook_page_posts: 'Page posts',
      facebook_page_comments: 'Page comments',
    }[job.kind] ?? job.kind;

    let sub;
    if (job.status === 'discovering') {
      sub = `Enumerating ${kindLabel} — ${fmtNum(job.total)} found so far.`;
    } else if (job.status === 'completed') {
      sub = job.dryRun
        ? `${fmtNum(job.deleted)} ${kindLabel} matched. Nothing was deleted — export the list, then turn off dry run when you're happy.`
        : `${fmtNum(job.deleted)} ${kindLabel} deleted. ${job.failed ? `${fmtNum(job.failed)} could not be removed.` : ''}`;
    } else if (job.status === 'paused') {
      sub = `Paused at ${fmtNum(job.cursor)} of ${fmtNum(job.total)}. Resume whenever you like — nothing expires.`;
    } else {
      sub = `${fmtNum(job.cursor)} of ${fmtNum(job.total)} processed · ${fmtNum(job.ratePerHour)}/hour ceiling · runs even with this tab closed.`;
    }
    setText('job-sub', sub);

    const stateBadge = this.el('job-state');
    if (stateBadge) {
      const cls = { completed: 'good', failed: 'warn', cancelled: '', paused: '' }[job.status] ?? 'info';
      const live = ['running', 'discovering'].includes(job.status) ? '<span class="pulse-dot"></span>' : '';
      stateBadge.innerHTML = `${live}<span class="badge ${cls}">${escapeHtml(job.status)}</span>`;
    }

    const pauseBtn = this.el('job-pause');
    if (pauseBtn) {
      const done = ['completed', 'cancelled', 'failed'].includes(job.status);
      pauseBtn.disabled = done;
      pauseBtn.innerHTML = this.paused
        ? `${icon('i-play')} Resume`
        : `${icon('i-pause')} Pause`;
      const cancelBtn = this.el('job-cancel');
      if (cancelBtn) cancelBtn.disabled = done;
    }

    const quotaBox = this.el('job-quota');
    if (quotaBox) {
      quotaBox.innerHTML = job.metered && job.allowance
        ? `<div class="notice info">${icon('i-info', 17)}<div>
             Metered job: <strong>${fmtNum(job.billableRequests)}</strong> of
             <strong>${fmtNum(job.allowance)}</strong> purchased deletions used.
             ${job.status === 'completed' ? 'Anything unused has been returned to your balance.' : 'Unused quota comes back when the job ends.'}
           </div></div>`
        : '';
    }

    const errBox = this.el('job-error');
    if (errBox) {
      if (job.lastError && job.status !== 'completed') {
        errBox.innerHTML = `<div class="notice warn">${icon('i-warn', 17)}<div><strong>Last issue:</strong> ${escapeHtml(job.lastError)}</div></div>`;
      } else if (job.costEstimateUsd) {
        errBox.innerHTML = `<div class="notice info">${icon('i-info', 17)}<div>Estimated X API usage so far: <strong>${fmtMoney(job.costEstimateUsd)}</strong>. Indicative only — your developer dashboard is the source of truth.</div></div>`;
      } else {
        errBox.innerHTML = '';
      }
    }

    const logBox = this.el('job-log');
    if (logBox && job.recentLog) {
      logBox.innerHTML = job.recentLog.length
        ? [...job.recentLog].reverse().map((e) => `
            <div class="log-line">
              <span class="id">${escapeHtml(e.id)}</span>
              <span class="txt">${escapeHtml(e.text || e.error || '')}</span>
              <span class="out ${escapeHtml(e.outcome)}">${e.outcome === 'would_delete' ? 'would delete' : escapeHtml(e.outcome)}</span>
            </div>`).join('')
        : '<div class="empty">Nothing yet.</div>';
    }

    if (['completed', 'cancelled', 'failed'].includes(job.status)) {
      this.onFinish?.(job);
      if (job.status === 'completed' && !this.announced) {
        this.announced = true;
        toast(job.dryRun ? 'Dry run finished — export the list to review it.' : 'Job finished.', 'success', 8000);
      }
    }
  }
}


/* ============================================================= BILLING ==== */

/**
 * Managed mode means we run the deletions on our own X app — no developer
 * account for the user, but X bills us per delete. So the price is quoted from
 * the exact archive count (which we already have, for free, client-side) before
 * anything runs, and quota is reserved up front so a job can never overspend.
 */

function billingAvailable() {
  return Boolean(state.session?.capabilities?.billing && state.session?.capabilities?.xManagedApp);
}

function isManagedConnection() {
  return state.session?.connections?.x?.managed === true;
}

async function loadPricing() {
  try {
    state.billing.pricing = await api('/api/billing/pricing');
  } catch {
    state.billing.pricing = null;
  }
}

async function loadWallet() {
  if (!state.session?.connections?.x) {
    state.billing.wallet = null;
    return null;
  }
  try {
    state.billing.wallet = await api('/api/billing/wallet');
  } catch {
    state.billing.wallet = null;
  }
  return state.billing.wallet;
}

function renderPricingTable() {
  const box = $('#x-pricing-table');
  if (!box) return;
  const pricing = state.billing.pricing;
  if (!pricing?.enabled || !pricing.tiers?.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `
    <div class="preview" style="max-height:none">
      <table>
        <thead><tr><th>Pack</th><th>Posts</th><th style="text-align:right">Price</th></tr></thead>
        <tbody>
          ${pricing.tiers.map((t) => `
            <tr>
              <td>${escapeHtml(t.label)}</td>
              <td class="num">up to ${fmtNum(t.quota)}</td>
              <td class="num" style="text-align:right">${fmtMoney(t.priceCents / 100)}</td>
            </tr>`).join('')}
          <tr>
            <td>Beyond that</td>
            <td class="num">any size</td>
            <td class="num" style="text-align:right">${fmtMoney(pricing.overageCentsPerDelete / 100)}/post</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="tiny faint" style="margin-top:8px">
      One-time, no subscription. Unused deletions stay in your balance, and a dry run is always free.
    </p>`;
}

/** How many deletions this job will need to reserve. */
function neededForCurrentJob() {
  return state.x.source === 'archive' ? state.x.filtered.length : Number($('#x-api-max').value) || 0;
}

/**
 * The quota panel on the run step. Three states: nothing to say (BYO or dry
 * run), covered by existing balance, or short and needing a purchase.
 */
async function renderQuotaPanel() {
  const panel = $('#x-quota-panel');
  if (!panel) return;

  const managed = isManagedConnection();
  const dryRun = $('#x-dry-run').checked;

  if (!managed || dryRun) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }

  const needed = neededForCurrentJob();
  const wallet = state.billing.wallet ?? (await loadWallet());
  const balance = wallet?.balance ?? 0;
  panel.hidden = false;

  if (!needed) {
    panel.innerHTML = `<div class="notice info">${icon('i-info', 17)}<div>
      Set how many posts to scan, or load an archive, and the exact price appears here before anything runs.
    </div></div>`;
    return;
  }

  if (balance >= needed) {
    panel.innerHTML = `<div class="notice success">${icon('i-check', 17)}<div>
      <strong>Covered by your balance.</strong> This job needs ${fmtNum(needed)} deletions and you have
      ${fmtNum(balance)} left. They are reserved when the job starts and anything unused comes straight back.
    </div></div>`;
    return;
  }

  const shortfall = needed - balance;
  let quote = null;
  try {
    quote = (await api('/api/billing/quote', { method: 'POST', body: { count: shortfall } })).quote;
  } catch {
    /* fall through to a priceless panel rather than blocking */
  }
  state.billing.quote = quote;

  panel.innerHTML = `
    <div class="notice info">${icon('i-info', 17)}<div>
      <strong>${fmtNum(needed)} posts selected${balance ? `, ${fmtNum(balance)} already in your balance` : ''}.</strong>
      ${quote ? `You need ${fmtNum(shortfall)} more — the ${escapeHtml(quote.tierLabel)} pack covers ${fmtNum(quote.quota)} for <strong>${fmtMoney(quote.priceCents / 100)}</strong>.` : ''}
      <div class="tiny faint" style="margin-top:6px">
        X charges us for every post we delete for you, and retired its free tier in February 2026. This is that cost plus our margin —
        no subscription, and a dry run costs nothing.
      </div>
      <button class="btn btn-primary btn-sm" id="x-buy" style="margin-top:11px">
        ${icon('i-link', 14)} ${quote ? `Buy ${fmtNum(quote.quota)} deletions — ${fmtMoney(quote.priceCents / 100)}` : 'Buy deletions'}
      </button>
    </div>`;

  $('#x-buy')?.addEventListener('click', () => startCheckout(shortfall));
}

async function startCheckout(count) {
  const btn = $('#x-buy');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Opening checkout…`;
  }
  try {
    const { url } = await api('/api/billing/checkout', { method: 'POST', body: { count } });
    // Full redirect, not a popup — popups get blocked and Stripe wants the top frame.
    location.href = url;
  } catch (err) {
    toast(err.message, 'error', 9000);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Buy deletions';
    }
  }
}

/**
 * Credit a purchase the moment the browser returns from Stripe, so the balance
 * is there before the page settles. The webhook does the same thing server-side
 * and the wallet dedupes, so neither path can double-credit.
 */
async function confirmPurchase(checkoutSessionId) {
  try {
    const result = await api('/api/billing/confirm', { method: 'POST', body: { sessionId: checkoutSessionId } });
    await loadWallet();
    toast(
      result.duplicate
        ? 'Payment already applied — your balance is up to date.'
        : `Payment received. ${fmtNum(result.credited)} deletions added to your balance.`,
      'success',
      9000,
    );
  } catch (err) {
    toast(`${err.message} If you were charged, your balance will update within a minute.`, 'error', 12000);
  }
  await renderQuotaPanel();
}

/* ============================================================== X FLOW ==== */

const xMonitor = new JobMonitor('x');

function setStepState(id, mode) {
  const card = $(`#${id}`);
  if (!card) return;
  card.classList.toggle('is-locked', mode === 'locked');
  card.classList.toggle('is-active', mode === 'active');
  card.classList.toggle('is-done', mode === 'done');
}

function xConnected() {
  return Boolean(state.session?.connections?.x);
}

function renderXConnection() {
  const conn = state.session?.connections?.x;
  const badge = $('#x-conn-badge');

  if (conn) {
    $('#x-connected').hidden = false;
    $('#x-disconnected').hidden = true;
    $('#x-connect-foot').hidden = true;
    // An empty src re-requests the page itself, so only set it when we have one.
    if (conn.avatarUrl) $('#x-avatar').src = conn.avatarUrl;
    $('#x-avatar').alt = `${conn.username} avatar`;
    $('#x-username').textContent = `@${conn.username}`;
    $('#x-scopes').textContent = `Permissions: ${conn.scopes.join(', ')}`;
    badge.innerHTML = conn.managed
      ? `<span class="badge info">managed</span><span class="badge good">Connected</span>`
      : `<span class="badge">your own app</span><span class="badge good">Connected</span>`;
    setStepState('x-step-connect', 'done');
    setStepState('x-step-source', 'active');
  } else {
    $('#x-connected').hidden = true;
    $('#x-disconnected').hidden = false;
    $('#x-connect-foot').hidden = false;
    badge.innerHTML = '';
    setStepState('x-step-connect', 'active');
    setStepState('x-step-source', 'locked');
    setStepState('x-step-filter', 'locked');
    setStepState('x-step-run', 'locked');
  }

  const hint = state.session?.capabilities?.xClientHint;
  if (hint) {
    $('#x-client-id').placeholder = `Saved: ${hint}`;
  }
  $('#x-redirect-uri').value = state.session?.redirectUris?.x ?? '';

  // The instant-connect door only exists if the operator configured both a
  // shared X app and payments. Otherwise it is bring-your-own-app only.
  const chooser = $('#x-mode-choices');
  if (billingAvailable()) {
    chooser.hidden = false;
    setXMode(LS.get('xMode', 'managed'));
  } else {
    chooser.hidden = true;
    setXMode('byo');
    $('#x-mode-managed').hidden = true;
    $('#x-mode-byo').hidden = false;
  }
}

$('#x-app-help-toggle').addEventListener('click', (e) => {
  e.preventDefault();
  const box = $('#x-app-help');
  box.hidden = !box.hidden;
  e.target.textContent = box.hidden ? 'Show me how →' : 'Hide the walkthrough';
});

$$('[data-copy]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const input = $(btn.dataset.copy);
    try {
      await navigator.clipboard.writeText(input.value);
      toast('Copied to clipboard.', 'success', 2500);
    } catch {
      input.select();
      toast('Press Cmd/Ctrl+C to copy.', 'info');
    }
  }),
);

function setXMode(mode) {
  state.x.mode = mode;
  $$('#x-mode-choices .choice').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.mode === mode)));
  $('#x-mode-managed').hidden = mode !== 'managed';
  $('#x-mode-byo').hidden = mode !== 'byo';
  const btn = $('#x-connect-btn');
  if (btn) {
    btn.innerHTML = `${icon('i-link')} ${mode === 'managed' ? 'Connect with X' : 'Connect with my own app'}`;
  }
  LS.set('xMode', mode);
}

$$('#x-mode-choices .choice').forEach((choice) =>
  choice.addEventListener('click', () => setXMode(choice.dataset.mode)),
);

$('#x-connect-btn').addEventListener('click', async () => {
  const managedAvailable = billingAvailable();
  const mode = managedAvailable ? state.x.mode : 'byo';
  const clientId = $('#x-client-id').value.trim();
  const clientSecret = $('#x-client-secret').value.trim();
  const btn = $('#x-connect-btn');
  btn.disabled = true;

  try {
    if (mode === 'byo') {
      if (clientId) {
        await api('/api/x/app', { method: 'POST', body: { clientId, clientSecret } });
      } else if (!state.session?.capabilities?.xUserApp) {
        toast('Enter your X app Client ID first — the walkthrough above shows where to find it.', 'error');
        btn.disabled = false;
        return;
      }
    }
    location.href = `/auth/x/start?mode=${mode}`;
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
});

$('#x-disconnect').addEventListener('click', async () => {
  const ok = await modal.open({
    title: 'Disconnect X?',
    sub: 'PostCleaner will drop its copy of your token. Any running job for this account will stop at its next step.',
    confirmLabel: 'Disconnect',
    danger: false,
  });
  if (!ok) return;
  await api('/api/connections/x/disconnect', { method: 'POST', body: {} });
  await loadSession();
  toast('Disconnected. You can also revoke access from x.com → Settings → Connected apps.', 'success', 8000);
});

/* ---- source selection ---- */

$$('#x-step-source .choice').forEach((choice) =>
  choice.addEventListener('click', () => {
    state.x.source = choice.dataset.source;
    $$('#x-step-source .choice').forEach((c) => c.setAttribute('aria-pressed', String(c === choice)));
    $('#x-source-archive').hidden = state.x.source !== 'archive';
    $('#x-source-api').hidden = state.x.source !== 'api';
    updateXStepGate();
  }),
);

/* ---- archive upload ---- */

const dropzone = $('#x-dropzone');
const fileInput = $('#x-file');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
['dragenter', 'dragover'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('is-over'); }),
);
['dragleave', 'drop'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('is-over'); }),
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) handleArchive(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) handleArchive(fileInput.files[0]);
});

async function handleArchive(file) {
  const want = $('#x-archive-target').value === 'likes' ? 'likes' : 'tweets';
  $('#x-archive-progress').hidden = false;
  $('#x-archive-result').hidden = true;

  const onProgress = ({ detail, percent }) => {
    $('#x-archive-status').textContent = detail;
    $('#x-archive-pct').textContent = `${percent}%`;
    $('#x-archive-bar').style.width = `${percent}%`;
  };

  try {
    const { items, account } = await readArchive(file, { want, onProgress });
    if (!items.length) {
      throw new Error('That archive contains no items of the type you selected.');
    }
    state.x.items = items;
    state.x.account = account;
    state.x.archiveTarget = want;

    const oldest = items.filter((i) => i.createdAt).at(-1)?.createdAt;
    const newest = items.find((i) => i.createdAt)?.createdAt;

    $('#x-archive-result').hidden = false;
    $('#x-archive-result').innerHTML = `
      <div class="notice success">${icon('i-check', 17)}<div>
        <strong>${fmtNum(items.length)} ${want === 'likes' ? 'likes' : 'posts'} found${account?.username ? ` for @${escapeHtml(account.username)}` : ''}.</strong>
        ${oldest && newest ? `Spanning ${escapeHtml(fmtDate(oldest))} → ${escapeHtml(fmtDate(newest))}.` : ''}
        Nothing has been uploaded — this all happened in your browser.
      </div></div>`;

    setStepState('x-step-source', 'done');
    setStepState('x-step-filter', 'active');
    // Likes carry no timestamp in the archive, so date filters can't apply.
    const dateDisabled = want === 'likes';
    $('#f-from').disabled = dateDisabled;
    $('#f-to').disabled = dateDisabled;
    applyXFilters();
  } catch (err) {
    $('#x-archive-progress').hidden = true;
    toast(err.message, 'error', 9000);
  } finally {
    $('#x-archive-progress').hidden = true;
    fileInput.value = '';
  }
}

/* ---- filters ---- */

function readFilters() {
  const words = (id) =>
    $(id).value.split(',').map((s) => s.trim()).filter(Boolean);
  const maxLikesRaw = $('#f-maxlikes').value.trim();
  return {
    from: $('#f-from').value || undefined,
    to: $('#f-to').value || undefined,
    keywords: words('#f-keywords'),
    excludeKeywords: words('#f-exclude'),
    media: $('#f-media').value,
    includeOriginals: $('#f-originals').checked,
    includeReplies: $('#f-replies').checked,
    includeRetweets: $('#f-retweets').checked,
    maxLikes: maxLikesRaw === '' ? undefined : Math.max(0, Number(maxLikesRaw) || 0),
  };
}

/** Mirror of src/lib/filters.ts — kept intentionally simple and identical. */
function matches(item, f) {
  if (f.from || f.to) {
    if (!item.createdAt) return false;
    const ts = Date.parse(item.createdAt);
    if (f.from && ts < Date.parse(`${f.from}T00:00:00.000Z`)) return false;
    if (f.to && ts > Date.parse(`${f.to}T23:59:59.999Z`)) return false;
  }
  const kind = item.isRetweet ? 'retweet' : item.isReply ? 'reply' : 'original';
  if (kind === 'retweet' && !f.includeRetweets) return false;
  if (kind === 'reply' && !f.includeReplies) return false;
  if (kind === 'original' && !f.includeOriginals) return false;
  if (f.media === 'only' && !item.hasMedia) return false;
  if (f.media === 'none' && item.hasMedia) return false;
  if (f.maxLikes !== undefined && typeof item.likes === 'number' && item.likes > f.maxLikes) return false;

  if (f.keywords.length || f.excludeKeywords.length) {
    const hay = (item.text ?? '').toLowerCase();
    if (f.excludeKeywords.some((k) => hay.includes(k.toLowerCase()))) return false;
    if (f.keywords.length && !f.keywords.some((k) => hay.includes(k.toLowerCase()))) return false;
  }
  return true;
}

function applyXFilters() {
  const f = readFilters();
  state.x.filters = f;
  state.x.filtered = state.x.items.filter((i) => matches(i, f));

  $('#x-filter-count').textContent = `${fmtNum(state.x.filtered.length)} selected`;
  renderXPreview();
  updateEstimate();
  updateXStepGate();
  renderQuotaPanel();
}

function renderXPreview() {
  const rows = state.x.filtered.slice(0, 100);
  const box = $('#x-preview');
  if (!state.x.items.length) {
    box.innerHTML = '<div class="empty">Load a source in step 2 to see what would be deleted.</div>';
    $('#x-preview-note').textContent = '';
    return;
  }
  if (!rows.length) {
    box.innerHTML = '<div class="empty">Nothing matches these filters. Loosen them a little.</div>';
    $('#x-preview-note').textContent = '';
    return;
  }
  $('#x-preview-note').textContent =
    state.x.filtered.length > 100
      ? `Showing 100 of ${fmtNum(state.x.filtered.length)} matches`
      : `Showing all ${fmtNum(rows.length)} matches`;

  box.innerHTML = `
    <table>
      <thead><tr><th>Date</th><th>Content</th><th>Type</th><th style="text-align:right">Likes</th></tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td class="t-date">${escapeHtml(fmtDate(r.createdAt))}</td>
            <td class="t-text"><div>${escapeHtml(r.text || '(no text)')}</div></td>
            <td class="t-kind"><span class="badge">${r.isRetweet ? 'repost' : r.isReply ? 'reply' : 'post'}</span></td>
            <td class="num faint" style="text-align:right">${r.likes ?? 0}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

['#f-from', '#f-to', '#f-keywords', '#f-exclude', '#f-media', '#f-maxlikes', '#f-originals', '#f-replies', '#f-retweets']
  .forEach((sel) => {
    const node = $(sel);
    node.addEventListener('change', applyXFilters);
    node.addEventListener('input', debounce(applyXFilters, 250));
  });

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---- estimate + gating ---- */

function currentXKind() {
  if (state.x.source === 'archive') return state.x.archiveTarget === 'likes' ? 'x_likes' : 'x_posts';
  return $('#x-api-target').value;
}

async function updateEstimate() {
  const count = state.x.source === 'archive' ? state.x.filtered.length : Number($('#x-api-max').value) || 3200;
  const dryRun = $('#x-dry-run').checked;
  $('#est-count').textContent = fmtNum(count);

  try {
    const est = await api('/api/estimate', {
      method: 'POST',
      body: {
        kind: currentXKind(),
        count,
        discoveryReads: state.x.source === 'api' ? count : 0,
        dryRun,
      },
    });
    $('#est-rate').innerHTML = `${est.perWindow}<span class="small faint"> /${Math.round(est.windowMs / 60000)}m</span>`;
    $('#est-time').textContent = dryRun ? 'minutes' : fmtDuration(est.durationMs);

    // The cost stat means different things in the two modes, and showing our
    // wholesale cost next to the user's price would be nonsense. In managed
    // mode this is what *they* pay; in BYO it's what X will bill them.
    const costLabel = $('#est-cost')?.closest('.stat')?.querySelector('.k');
    if (dryRun) {
      if (costLabel) costLabel.textContent = 'Cost';
      $('#est-cost').textContent = '$0';
    } else if (isManagedConnection()) {
      const balance = state.billing.wallet?.balance ?? 0;
      const shortfall = Math.max(0, count - balance);
      if (costLabel) costLabel.textContent = 'Your price';
      if (!shortfall) {
        $('#est-cost').textContent = 'Covered';
      } else {
        const q = (await api('/api/billing/quote', { method: 'POST', body: { count: shortfall } })).quote;
        $('#est-cost').textContent = fmtMoney(q.priceCents / 100);
      }
    } else {
      if (costLabel) costLabel.textContent = 'Your X API cost';
      $('#est-cost').textContent = fmtMoney(est.costEstimateUsd);
    }
  } catch {
    /* estimate is decoration; never block on it */
  }
}

function updateXStepGate() {
  const ready =
    xConnected() && (state.x.source === 'api' || state.x.filtered.length > 0);
  setStepState('x-step-filter', state.x.items.length || state.x.source === 'api' ? 'active' : 'locked');
  setStepState('x-step-run', ready ? 'active' : 'locked');

  const dry = $('#x-dry-run').checked;
  const label = $('#x-start-label');
  if (label) {
    label.textContent = dry
      ? 'Start dry run'
      : state.x.source === 'archive'
        ? `Delete ${fmtNum(state.x.filtered.length)} items`
        : 'Scan and delete';
  }
  $('#x-start').className = dry ? 'btn btn-primary btn-lg' : 'btn btn-danger btn-lg';
  $('#x-start').disabled = !ready;
}

$('#x-dry-run').addEventListener('change', () => { updateXStepGate(); updateEstimate(); renderQuotaPanel(); });
$('#x-api-target').addEventListener('change', () => { updateEstimate(); updateXStepGate(); });
$('#x-api-max').addEventListener('input', debounce(updateEstimate, 300));
$('#x-archive-target').addEventListener('change', () => {
  state.x.items = [];
  state.x.filtered = [];
  $('#x-archive-result').hidden = true;
  applyXFilters();
});

/* ---- start ---- */

$('#x-start').addEventListener('click', async () => {
  const dryRun = $('#x-dry-run').checked;
  const kind = currentXKind();
  const isArchive = state.x.source === 'archive';
  const count = isArchive ? state.x.filtered.length : Number($('#x-api-max').value) || 0;

  if (isArchive && !count) {
    toast('Nothing selected — adjust the filters in step 3.', 'error');
    return;
  }

  if (!dryRun) {
    const label = kind === 'x_likes' ? 'likes' : 'posts';
    const ok = await modal.open({
      title: isArchive ? `Permanently delete ${fmtNum(count)} ${label}?` : `Delete every matching ${label} found?`,
      sub: 'X has no undo and no trash folder. Once this runs, they are gone.',
      body: `<div class="notice danger">${icon('i-warn', 17)}<div>
          This will run for roughly <strong>${escapeHtml(fmtDuration(Math.ceil(count / 50) * 15 * 60000))}</strong> at X's
          limit of 50 deletions per 15 minutes. You can pause or cancel at any time, and everything already deleted stays deleted.
        </div></div>`,
      requirePhrase: 'DELETE',
      confirmLabel: `Delete ${label}`,
    });
    if (!ok) return;
  }

  const btn = $('#x-start');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Creating job…`;

  try {
    const first = isArchive ? state.x.filtered.slice(0, 5000) : [];
    const { job } = await api('/api/jobs', {
      method: 'POST',
      body: {
        kind,
        source: isArchive ? 'archive' : 'api',
        dryRun,
        filters: state.x.filters ?? readFilters(),
        items: first,
        // Items upload in chunks after this call, so the server needs the full
        // size up front to reserve the right amount of quota.
        expectedTotal: isArchive ? state.x.filtered.length : 0,
        maxItems: isArchive ? 0 : Number($('#x-api-max').value) || 0,
        label: isArchive ? `Archive · ${kind}` : `API scan · ${kind}`,
      },
    });

    // Upload the rest in chunks so a 40k-post archive doesn't need one huge body.
    if (isArchive && state.x.filtered.length > 5000) {
      for (let i = 5000; i < state.x.filtered.length; i += 5000) {
        btn.innerHTML = `<span class="spinner"></span> Uploading ${fmtNum(i)} / ${fmtNum(state.x.filtered.length)}…`;
        await api(`/api/jobs/${job.id}/items`, {
          method: 'POST',
          body: { items: state.x.filtered.slice(i, i + 5000) },
        });
      }
    }

    await api(`/api/jobs/${job.id}/start`, { method: 'POST', body: {} });
    state.x.jobId = job.id;
    xMonitor.announced = false;
    xMonitor.attach(job.id);
    toast(dryRun ? 'Dry run started.' : 'Deletion job started. You can close this tab.', 'success', 7000);
  } catch (err) {
    if (err.code === 'insufficient_quota') {
      // Not an error so much as a checkout prompt.
      await loadWallet();
      await renderQuotaPanel();
      const q = err.details?.quote;
      const proceed = await modal.open({
        title: 'You need more deletions first',
        sub: q
          ? `This job needs ${fmtNum(err.details.needed)}. The ${q.tierLabel} pack covers ${fmtNum(q.quota)} for ${fmtMoney(q.priceCents / 100)}.`
          : 'Top up your balance to run this job.',
        body: `<div class="notice info">${icon('i-info', 17)}<div>
            X bills us for every post we delete on your behalf. You are charged once, for the exact number you selected —
            and anything you do not use stays in your balance.
          </div></div>`,
        confirmLabel: q ? `Buy ${fmtNum(q.quota)} — ${fmtMoney(q.priceCents / 100)}` : 'Buy deletions',
        danger: false,
      });
      if (proceed) await startCheckout(err.details?.shortfall ?? neededForCurrentJob());
    } else {
      toast(err.message, 'error', 9000);
    }
  } finally {
    // Restore the label element *before* gating — updateXStepGate() writes into it.
    btn.innerHTML = `${icon('i-play')} <span id="x-start-label"></span>`;
    btn.disabled = false;
    updateXStepGate();
    renderQuotaPanel();
  }
});

$('#x-job-new').addEventListener('click', () => {
  xMonitor.detach();
  $('#x-step-progress').hidden = true;
  LS.set('job:x', null);
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* ========================================================= THREADS FLOW === */

const thMonitor = new JobMonitor('th');

function renderThreads() {
  const caps = state.session?.capabilities ?? {};
  const conn = state.session?.connections?.threads;
  const body = $('#th-connect-body');
  const badge = $('#th-conn-badge');

  if (!caps.threads) {
    badge.innerHTML = '<span class="badge warn">Not configured</span>';
    body.innerHTML = `<div class="notice warn">${icon('i-warn', 17)}<div>
      <strong>Threads is not enabled on this deployment.</strong> The operator needs to create a Meta app with the
      Threads API use case and set <code>THREADS_APP_ID</code> and <code>THREADS_APP_SECRET</code>. See the README.
    </div></div>`;
    setStepState('th-step-run', 'locked');
    return;
  }

  if (conn) {
    badge.innerHTML = '<span class="badge good">Connected</span>';
    body.innerHTML = `
      <div class="row">
        ${avatarImg(conn.avatarUrl)}
        <div><strong>@${escapeHtml(conn.username)}</strong><div class="tiny faint">Permissions: ${escapeHtml(conn.scopes.join(', '))}</div></div>
        <div class="spacer"></div>
        <button class="btn btn-sm" id="th-disconnect">Disconnect</button>
      </div>`;
    $('#th-disconnect').addEventListener('click', async () => {
      await api('/api/connections/threads/disconnect', { method: 'POST', body: {} });
      await loadSession();
    });
    setStepState('th-step-run', 'active');
  } else {
    badge.innerHTML = '';
    body.innerHTML = `
      <div class="notice info">${icon('i-info', 17)}<div>
        You'll be asked to grant <code>threads_basic</code> (read your posts) and <code>threads_delete</code> (remove them).
        Nothing else — PostCleaner cannot post as you.
      </div></div>
      <a class="btn btn-primary" href="/auth/threads/start" style="margin-top:14px;align-self:flex-start">
        ${icon('i-threads')} Connect Threads
      </a>`;
    setStepState('th-step-run', 'locked');
  }
}

$('#th-dry-run').addEventListener('change', () => {
  const dry = $('#th-dry-run').checked;
  const btn = $('#th-start');
  btn.innerHTML = `${icon('i-play')} ${dry ? 'Start dry run' : 'Delete Threads posts'}`;
  btn.className = dry ? 'btn btn-primary' : 'btn btn-danger';
});

$('#th-start').addEventListener('click', async () => {
  const dryRun = $('#th-dry-run').checked;
  const words = (id) => $(id).value.split(',').map((s) => s.trim()).filter(Boolean);

  if (!dryRun) {
    const ok = await modal.open({
      title: 'Permanently delete matching Threads posts?',
      sub: 'Meta allows 100 deletions per profile per 24 hours, so this will take days for a large profile.',
      requirePhrase: 'DELETE',
      confirmLabel: 'Delete posts',
    });
    if (!ok) return;
  }

  const btn = $('#th-start');
  btn.disabled = true;
  try {
    const { job } = await api('/api/jobs', {
      method: 'POST',
      body: {
        kind: 'threads_posts',
        source: 'api',
        dryRun,
        label: 'Threads cleanup',
        filters: {
          from: $('#th-from').value || undefined,
          to: $('#th-to').value || undefined,
          keywords: words('#th-keywords'),
          excludeKeywords: words('#th-exclude'),
        },
      },
    });
    await api(`/api/jobs/${job.id}/start`, { method: 'POST', body: {} });
    thMonitor.announced = false;
    thMonitor.attach(job.id);
    toast(dryRun ? 'Dry run started.' : 'Threads job started.', 'success');
  } catch (err) {
    toast(err.message, 'error', 9000);
  } finally {
    btn.disabled = false;
  }
});

/* ======================================================== FACEBOOK FLOW === */

const fbMonitor = new JobMonitor('fb');

function renderFacebook() {
  const caps = state.session?.capabilities ?? {};
  const conn = state.session?.connections?.facebook;
  const body = $('#fb-pages-body');
  const badge = $('#fb-conn-badge');

  if (!caps.facebook) {
    badge.innerHTML = '<span class="badge warn">Not configured</span>';
    body.innerHTML = `<div class="notice warn">${icon('i-warn', 17)}<div>
      <strong>Facebook Pages support is not enabled on this deployment.</strong>
      The operator needs a Meta app with Facebook Login and <code>FACEBOOK_APP_ID</code> / <code>FACEBOOK_APP_SECRET</code> set.
      The guides below work regardless.
    </div></div>`;
    return;
  }

  if (!conn) {
    badge.innerHTML = '';
    body.innerHTML = `
      <div class="notice info">${icon('i-info', 17)}<div>
        <strong>What you'll be granting:</strong>
        <ul>
          <li><code>pages_show_list</code> — see which Pages you administer.</li>
          <li><code>pages_read_engagement</code> — read those Pages' posts so they can be listed.</li>
          <li><code>pages_manage_posts</code> — delete Page posts.</li>
          <li><code>pages_manage_engagement</code> — delete comments on those Pages.</li>
        </ul>
        No access to your personal timeline, friends, messages or photos is requested — and Meta would not grant it if it were.
      </div></div>
      <a class="btn btn-primary" href="/auth/facebook/start" style="margin-top:14px;align-self:flex-start">
        ${icon('i-facebook')} Connect Facebook
      </a>`;
    return;
  }

  badge.innerHTML = '<span class="badge good">Connected</span>';
  const pages = conn.pages ?? [];

  if (!pages.length) {
    body.innerHTML = `
      <div class="row">
        ${avatarImg(conn.avatarUrl)}
        <div><strong>${escapeHtml(conn.displayName || conn.username)}</strong><div class="tiny faint">Connected</div></div>
        <div class="spacer"></div>
        <button class="btn btn-sm" id="fb-disconnect">Disconnect</button>
      </div>
      <div class="notice warn" style="margin-top:14px">${icon('i-warn', 17)}<div>
        <strong>No Pages found.</strong> This account doesn't administer any Facebook Pages, so there is nothing here PostCleaner can
        delete automatically. Use the Manage Activity guide below for your personal timeline.
      </div></div>`;
  } else {
    body.innerHTML = `
      <div class="row">
        ${avatarImg(conn.avatarUrl)}
        <div><strong>${escapeHtml(conn.displayName || conn.username)}</strong><div class="tiny faint">${pages.length} Page${pages.length === 1 ? '' : 's'} available</div></div>
        <div class="spacer"></div>
        <button class="btn btn-sm" id="fb-disconnect">Disconnect</button>
      </div>
      <div class="field" style="margin-top:16px">
        <label for="fb-page">Page to clean</label>
        <select id="fb-page">${pages.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}</select>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="fb-kind">What to delete</label>
          <select id="fb-kind">
            <option value="facebook_page_posts">Posts published by the Page</option>
            <option value="facebook_page_comments">Comments the Page left on its own posts</option>
          </select>
        </div>
        <div class="field">
          <label for="fb-maxlikes">Keep posts above N likes</label>
          <input type="number" id="fb-maxlikes" min="0" placeholder="No limit" />
        </div>
      </div>
      <div class="grid-2">
        <div class="field"><label for="fb-from">Posted on or after</label><input type="date" id="fb-from" /></div>
        <div class="field"><label for="fb-to">Posted on or before</label><input type="date" id="fb-to" /></div>
      </div>
      <div class="field">
        <label for="fb-keywords">Only if it contains</label>
        <input type="text" id="fb-keywords" placeholder="comma separated" />
      </div>
      <label class="switch" style="margin-top:6px">
        <input type="checkbox" id="fb-dry-run" checked />
        <span class="track"></span>
        <span class="label">Dry run<small>List what would be deleted, delete nothing.</small></span>
      </label>
      <div class="notice warn">${icon('i-warn', 17)}<div>
        Page posts are deleted permanently and immediately — unlike personal posts, they do not go to a bin.
        PostCleaner paces at ${escapeHtml(String(state.session?.limits?.facebookPagePerHour ?? 180))} deletions per hour to stay well inside Meta's platform budget.
      </div></div>
      <button class="btn btn-primary" id="fb-start" style="align-self:flex-start">${icon('i-play')} Start dry run</button>`;

    $('#fb-dry-run').addEventListener('change', () => {
      const dry = $('#fb-dry-run').checked;
      const btn = $('#fb-start');
      btn.innerHTML = `${icon('i-play')} ${dry ? 'Start dry run' : 'Delete permanently'}`;
      btn.className = dry ? 'btn btn-primary' : 'btn btn-danger';
    });

    $('#fb-start').addEventListener('click', startFacebookJob);
  }

  $('#fb-disconnect')?.addEventListener('click', async () => {
    await api('/api/connections/facebook/disconnect', { method: 'POST', body: {} });
    await loadSession();
  });
}

async function startFacebookJob() {
  const dryRun = $('#fb-dry-run').checked;
  const kind = $('#fb-kind').value;
  const pageId = $('#fb-page').value;
  const pageName = $('#fb-page').selectedOptions[0]?.textContent ?? 'Page';

  if (!dryRun) {
    const ok = await modal.open({
      title: `Permanently delete from “${pageName}”?`,
      sub: 'Page content is removed immediately — Meta provides no bin or undo for Pages.',
      requirePhrase: 'DELETE',
      confirmLabel: 'Delete permanently',
    });
    if (!ok) return;
  }

  const btn = $('#fb-start');
  btn.disabled = true;
  try {
    const maxLikesRaw = $('#fb-maxlikes').value.trim();
    const { job } = await api('/api/jobs', {
      method: 'POST',
      body: {
        kind,
        source: 'api',
        dryRun,
        pageId,
        label: `${pageName} · ${kind === 'facebook_page_posts' ? 'posts' : 'comments'}`,
        filters: {
          from: $('#fb-from').value || undefined,
          to: $('#fb-to').value || undefined,
          keywords: $('#fb-keywords').value.split(',').map((s) => s.trim()).filter(Boolean),
          maxLikes: maxLikesRaw === '' ? undefined : Number(maxLikesRaw) || 0,
        },
      },
    });
    await api(`/api/jobs/${job.id}/start`, { method: 'POST', body: {} });
    fbMonitor.announced = false;
    fbMonitor.attach(job.id);
    toast(dryRun ? 'Dry run started.' : 'Deletion job started.', 'success');
  } catch (err) {
    toast(err.message, 'error', 9000);
  } finally {
    btn.disabled = false;
  }
}

/* ---- Facebook DYI analyser ---- */

const fbDrop = $('#fb-dropzone');
const fbFile = $('#fb-file');
fbDrop.addEventListener('click', () => fbFile.click());
fbDrop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fbFile.click(); }
});
['dragenter', 'dragover'].forEach((evt) =>
  fbDrop.addEventListener(evt, (e) => { e.preventDefault(); fbDrop.classList.add('is-over'); }),
);
['dragleave', 'drop'].forEach((evt) =>
  fbDrop.addEventListener(evt, (e) => { e.preventDefault(); fbDrop.classList.remove('is-over'); }),
);
fbDrop.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) analyzeFacebook(file);
});
fbFile.addEventListener('change', () => {
  if (fbFile.files?.[0]) analyzeFacebook(fbFile.files[0]);
});

async function analyzeFacebook(file) {
  $('#fb-archive-progress').hidden = false;
  $('#fb-archive-result').innerHTML = '';
  const onProgress = ({ detail, percent }) => {
    $('#fb-archive-status').textContent = detail;
    $('#fb-archive-pct').textContent = `${percent}%`;
    $('#fb-archive-bar').style.width = `${percent}%`;
  };

  try {
    const report = await analyzeFacebookExport(file, { onProgress });
    const maxYear = Math.max(...report.years.map((y) => y.posts + y.comments), 1);

    $('#fb-archive-result').innerHTML = `
      <div class="stats" style="margin-bottom:14px">
        <div class="stat"><div class="k">Total items</div><div class="v">${fmtNum(report.total)}</div></div>
        <div class="stat"><div class="k">Posts</div><div class="v">${fmtNum(report.posts)}</div></div>
        <div class="stat"><div class="k">Comments</div><div class="v">${fmtNum(report.comments)}</div></div>
        <div class="stat muted"><div class="k">At 50/batch</div><div class="v" style="font-size:1.1rem">${fmtNum(Math.ceil(report.total / 50))} batches</div></div>
      </div>
      <div class="preview" style="max-height:300px">
        <table>
          <thead><tr><th>Year</th><th>Posts</th><th>Comments</th><th style="width:45%">Share</th></tr></thead>
          <tbody>
            ${report.years.map((y) => `
              <tr>
                <td class="num">${y.year}</td>
                <td class="num">${fmtNum(y.posts)}</td>
                <td class="num">${fmtNum(y.comments)}</td>
                <td><div class="meter" style="height:6px"><i style="width:${Math.round(((y.posts + y.comments) / maxYear) * 100)}%"></i></div></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn" id="fb-export-csv">${icon('i-download')} Export checklist (CSV)</button>
        <span class="tiny faint">Use it to track which years you've cleared in Manage Activity.</span>
      </div>`;

    $('#fb-export-csv').addEventListener('click', () => {
      const rows = [
        'year,posts,comments,total,batches_at_50,cleared',
        ...report.years.map((y) =>
          [y.year, y.posts, y.comments, y.posts + y.comments, Math.ceil((y.posts + y.comments) / 50), 'no'].join(','),
        ),
      ];
      const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'facebook-cleanup-checklist.csv';
      a.click();
      URL.revokeObjectURL(url);
    });
  } catch (err) {
    toast(err.message, 'error', 9000);
  } finally {
    $('#fb-archive-progress').hidden = true;
    fbFile.value = '';
  }
}

/* ============================================================= JOBS LIST == */

async function renderJobs() {
  const box = $('#jobs-list');
  try {
    const { jobs } = await api('/api/jobs');
    if (!jobs.length) {
      box.innerHTML = '<div class="card"><div class="empty">No jobs yet. Start one from the X, Threads or Facebook tab.</div></div>';
      return;
    }
    const kindLabel = {
      x_posts: 'X posts', x_likes: 'X likes', threads_posts: 'Threads posts',
      facebook_page_posts: 'Page posts', facebook_page_comments: 'Page comments',
    };
    box.innerHTML = jobs.map((j) => `
      <article class="card">
        <div class="card-head">
          <div style="min-width:0">
            <h2 style="display:flex;gap:8px;align-items:center">
              ${escapeHtml(j.label || kindLabel[j.kind] || j.kind)}
              ${j.dryRun ? '<span class="badge info">dry run</span>' : ''}
              <span class="badge ${j.status === 'completed' ? 'good' : j.status === 'failed' ? 'warn' : ''}">${escapeHtml(j.status)}</span>
            </h2>
            <p class="small muted">${fmtNum(j.deleted)} of ${fmtNum(j.total)} processed · started ${escapeHtml(fmtWhen(j.createdAt))}</p>
          </div>
          <div class="head-aside">
            <button class="btn btn-sm" data-job-log="${escapeHtml(j.jobId)}">${icon('i-download', 14)} Log</button>
          </div>
        </div>
      </article>`).join('');

    $$('[data-job-log]').forEach((btn) =>
      btn.addEventListener('click', () =>
        window.open(`/api/jobs/${btn.dataset.jobLog}/log?format=csv`, '_blank', 'noopener'),
      ),
    );
  } catch (err) {
    box.innerHTML = `<div class="card"><div class="empty">${escapeHtml(err.message)}</div></div>`;
  }
}

/* ================================================================= BOOT === */

async function loadSession() {
  state.session = await api('/api/session');
  renderXConnection();
  renderThreads();
  renderFacebook();

  if (state.session.connections?.x) await loadWallet();

  const limit = state.session.limits?.xDeletePer15Min ?? 50;
  $('#x-limit-chip').textContent = `${limit} deletes / 15 min`;
  const readPrice = state.session.pricing?.postReadUsd ?? 0.005;
  $('#x-read-cost').textContent = fmtMoney(3200 * readPrice);

  updateXStepGate();
}

/** OAuth callbacks return with `#auth=…`; surface the result then clean the URL. */
function consumeHash() {
  if (!location.hash || location.hash.length < 2) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const auth = params.get('auth');
  if (!auth) return;

  const provider = params.get('provider');
  if (auth === 'connected') {
    const mode = params.get('mode');
    toast(
      `Connected${params.get('username') ? ` as @${params.get('username')}` : ''}${mode === 'managed' ? ' — nothing else to set up.' : '.'}`,
      'success',
    );
    if (provider === 'threads') showView('threads');
    else if (provider === 'facebook') showView('facebook');
  } else if (auth === 'error') {
    toast(params.get('message') || 'Sign-in failed.', 'error', 11000);
  }
  history.replaceState(null, '', location.pathname + location.search);
}

/** Stripe sends the browser back to `#billing=success&session_id=cs_…`. */
function consumeBillingHash() {
  if (!location.hash || location.hash.length < 2) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const billing = params.get('billing');
  if (!billing) return null;
  const sessionId = params.get('session_id');
  history.replaceState(null, '', location.pathname + location.search);

  if (billing === 'cancelled') {
    toast('Checkout cancelled — nothing was charged.', 'info');
    return null;
  }
  return billing === 'success' && sessionId ? sessionId : null;
}

async function resumeJobs() {
  for (const [prefix, monitor] of [['x', xMonitor], ['th', thMonitor], ['fb', fbMonitor]]) {
    const jobId = LS.get(`job:${prefix}`, null);
    if (!jobId) continue;
    try {
      const { job } = await api(`/api/jobs/${jobId}`);
      if (['running', 'discovering', 'queued', 'paused'].includes(job.status)) {
        monitor.attach(jobId);
        monitor.render(job);
        toast('Picked up a job that was still running.', 'info', 6000);
      } else {
        LS.set(`job:${prefix}`, null);
      }
    } catch {
      LS.set(`job:${prefix}`, null);
    }
  }
}

(async function boot() {
  showView(LS.get('view', 'x'));
  // Read the OAuth / billing result out of the URL first so the session we then
  // load already reflects whatever just happened.
  consumeHash();
  const paidSessionId = consumeBillingHash();

  try {
    await loadSession();
  } catch (err) {
    toast(err.message, 'error', 12000);
  }

  await Promise.all([loadPricing(), loadWallet()]);
  renderPricingTable();
  if (paidSessionId) await confirmPurchase(paidSessionId);
  await renderQuotaPanel();

  await resumeJobs();
})();
