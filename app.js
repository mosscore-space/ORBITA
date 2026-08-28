/* =========================================================
   Part 0: Login gate
   ---------------------------------------------------------
   The password is never stored as plain text here — only its
   SHA-256 hash. On submit we hash whatever was typed and
   compare hashes. This keeps the password out of the page's
   source, but it is NOT real security: this is a static page,
   so anyone with the URL can read this file and see exactly
   how the check works. Treat it as a "keep out" sign for
   casual visitors, not a lock — the real privacy boundary is
   which repo/URL you actually share.
   ========================================================= */
const ORBITA_AUTH = {
  user: 'Shaiman',
  // SHA-256 of the account password — the password itself is not in this file.
  hash: '1995f6ddc8b63c7cbdb4fd8931ea2dab54daecac20a696afb113852fb11c739c',
};
const SESSION_KEY = 'orbita-authed';

async function sha256Hex(message){
  if(!(window.crypto && window.crypto.subtle)){
    throw new Error('This browser cannot check the password securely (needs HTTPS or localhost).');
  }
  const bytes = new TextEncoder().encode(message);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function showDesktop(){
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('shutdown-screen').classList.add('hidden');
  document.getElementById('desktop').classList.remove('hidden');
}
function showLogin(){
  document.getElementById('desktop').classList.add('hidden');
  document.getElementById('shutdown-screen').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  const pw = document.getElementById('login-password');
  pw.value = '';
  setTimeout(()=>pw.focus(), 30);
}

var bootedOnce = false;
async function boot(){
  if(bootedOnce) return;
  bootedOnce = true;
  document.getElementById('main').innerHTML = '<div class="empty"><div class="t">Loading Orbita…</div></div>';
  await loadState();
  render();
  startClock();
}
function logOff(){
  sessionStorage.removeItem(SESSION_KEY);
  bootedOnce = false;
  showLogin();
}

function wireLogin(){
  const form = document.getElementById('login-form');
  const err = document.getElementById('login-error');
  const pwInput = document.getElementById('login-password');

  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    err.textContent = '';
    let hash;
    try{ hash = await sha256Hex(pwInput.value); }
    catch(ex){ err.textContent = ex.message; return; }
    if(hash === ORBITA_AUTH.hash){
      sessionStorage.setItem(SESSION_KEY, '1');
      showDesktop();
      boot();
    } else {
      err.textContent = 'That password is incorrect. Try again.';
      pwInput.value = '';
      pwInput.focus();
    }
  });

  document.getElementById('login-cancel-btn').addEventListener('click', ()=>{
    err.textContent = 'You must log on to use Orbita.';
    pwInput.value = '';
  });
}

/* NOTE: initAuth() is deliberately NOT called here. It runs at the very end
   of app.js (after js11), once every module's top-level `var` initializers
   (state, route, ACTIONS, etc.) have executed. Calling boot() this early
   would run before `var state = defaultState()` in the data module, and a
   plain var assignment would then silently overwrite whatever boot() just
   loaded. */
function initAuth(){
  wireLogin();
  if(sessionStorage.getItem(SESSION_KEY) === '1'){
    showDesktop();
    boot();
  } else {
    showLogin();
  }
}
/* =========================================================
   ORBITA — personal finance
   Part 1: data model, storage, utilities
   ========================================================= */
const STORAGE_KEY = 'orbita-state-v1';
const CURRENCIES = ['MVR','USD','EUR'];
const uid = (p) => (p||'id') + '_' + Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-4);

function defaultState(){
  return {
    version: 1,
    settings: {
      accountTypes: ['Salary Account','Savings Account','Sinking Fund','Spending Account','Credit Card'],
      exchangeRates: { USD: 15.42, EUR: null },
      monthlyBudget: 0,
      incomeCodes: ['salary','bonus'],
    },
    tagGroups: [
      { id: uid('tg'), name:'Shop', savings:false, entries:[] },
      { id: uid('tg'), name:'Subscription', savings:false, entries:[] },
      { id: uid('tg'), name:'Internal Transfer', savings:false, excludeFromSpending:true, entries:[] },
    ],
    accounts: [],
    liabilities: [],
  };
}

var state = defaultState();
var saveTimer = null;
var dataReady = false;
var githubSyncTimer = null;
var githubFileSha = null;
var githubLastSync = null; // {ok, time, message}

/* ---------------- local storage (always on, this device only) ---------------- */
function mergeIntoState(parsed){
  state = Object.assign(defaultState(), parsed);
  state.settings = Object.assign(defaultState().settings, parsed.settings||{});
  if(!state.tagGroups || !state.tagGroups.length) state.tagGroups = defaultState().tagGroups;
}
function loadLocal(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw) mergeIntoState(JSON.parse(raw));
    return true;
  }catch(e){ return false; }
}
function saveLocal(){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return true; }
  catch(e){ console.error('Orbita local save failed', e); return false; }
}

/* ---------------- GitHub private-repo sync (opt-in, configured in Settings) ----------------
   Nothing here is ever hardcoded or shipped in this file. The owner/repo/token are
   typed into Settings by whoever uses this copy of the app, and live only in this
   browser's localStorage — they are never part of the page's source. */
const GH_CFG_KEY = 'orbita-github-cfg';
function loadGithubConfig(){
  try{ return JSON.parse(localStorage.getItem(GH_CFG_KEY) || 'null'); }catch(e){ return null; }
}
function saveGithubConfig(cfg){ localStorage.setItem(GH_CFG_KEY, JSON.stringify(cfg)); }
function clearGithubConfig(){ localStorage.removeItem(GH_CFG_KEY); githubFileSha = null; }

function utf8ToBase64(str){
  const bytes = new TextEncoder().encode(str);
  let bin = ''; bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}
function base64ToUtf8(b64){
  const bin = atob((b64||'').replace(/\n/g,''));
  const bytes = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function githubContentsUrl(cfg){
  return `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${encodeURIComponent(cfg.path||'orbita-data.json')}`;
}
async function githubFetchFile(cfg){
  const res = await fetch(githubContentsUrl(cfg), {
    headers:{ 'Authorization':`Bearer ${cfg.token}`, 'Accept':'application/vnd.github+json' }
  });
  if(res.status===404) return null;
  if(!res.ok) throw new Error(`GitHub responded ${res.status}`);
  return res.json();
}
async function githubLoadState(cfg){
  const data = await githubFetchFile(cfg);
  if(!data) return null;
  githubFileSha = data.sha;
  return JSON.parse(base64ToUtf8(data.content));
}
async function githubSaveState(cfg){
  const body = { message: 'Orbita save '+new Date().toISOString(), content: utf8ToBase64(JSON.stringify(state)) };
  if(githubFileSha) body.sha = githubFileSha;
  let res = await fetch(githubContentsUrl(cfg), {
    method:'PUT',
    headers:{ 'Authorization':`Bearer ${cfg.token}`, 'Accept':'application/vnd.github+json', 'Content-Type':'application/json' },
    body: JSON.stringify(body)
  });
  if(res.status===409){ // our sha was stale — refetch once and retry
    const fresh = await githubFetchFile(cfg);
    if(fresh){ githubFileSha = fresh.sha; body.sha = fresh.sha;
      res = await fetch(githubContentsUrl(cfg), {
        method:'PUT',
        headers:{ 'Authorization':`Bearer ${cfg.token}`, 'Accept':'application/vnd.github+json', 'Content-Type':'application/json' },
        body: JSON.stringify(body)
      });
    }
  }
  if(!res.ok){ const t = await res.text().catch(()=>''); throw new Error(`GitHub save failed (${res.status}) ${t.slice(0,180)}`); }
  const data = await res.json();
  githubFileSha = data.content.sha;
}
async function githubTestConnection(cfg){
  const data = await githubFetchFile(cfg);
  return { exists: !!data };
}

/* ---------------- combined load/save ---------------- */
async function loadState(){
  loadLocal(); // fast local cache first, always available offline
  const cfg = loadGithubConfig();
  if(cfg && cfg.token && cfg.owner && cfg.repo){
    try{
      const remote = await githubLoadState(cfg);
      if(remote) mergeIntoState(remote);
      githubLastSync = { ok:true, time:new Date().toISOString() };
    }catch(e){
      githubLastSync = { ok:false, time:new Date().toISOString(), message:e.message };
      console.warn('Orbita: GitHub load failed, using local copy instead —', e.message);
    }
  }
  dataReady = true;
}

function scheduleSave(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 350);
}
async function saveNow(){
  if(!saveLocal()) toast('Could not save — your browser storage may be full', 'error');
  const cfg = loadGithubConfig();
  if(cfg && cfg.token && cfg.autoSync){
    clearTimeout(githubSyncTimer);
    githubSyncTimer = setTimeout(async ()=>{
      try{ await githubSaveState(cfg); githubLastSync = { ok:true, time:new Date().toISOString() }; }
      catch(e){ githubLastSync = { ok:false, time:new Date().toISOString(), message:e.message }; toast('GitHub sync failed — your data is still saved locally', 'error'); }
      if(route.view==='settings') render();
    }, 1400);
  }
}

/* ---------------- formatting helpers ---------------- */
function fmtMoney(n, cur){
  const v = (Math.round((n||0)*100)/100);
  const neg = v < 0;
  const abs = Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  return (neg?'-':'') + (cur?cur+' ':'') + abs;
}
function fmtDate(iso){
  if(!iso) return '';
  const d = new Date(iso+'T00:00:00');
  if(isNaN(d)) return iso;
  return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
}
function monthKey(iso){ return (iso||'').slice(0,7); }
function todayIso(){ return new Date().toISOString().slice(0,10); }
function currentMonthKey(){ return todayIso().slice(0,7); }
function monthLabel(mk){
  const [y,m] = mk.split('-').map(Number);
  return new Date(y, m-1, 1).toLocaleDateString('en-US',{month:'short',year:'numeric'});
}
function escapeHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function cleanCsvField(raw){
  if(raw==null) return '';
  let s = String(raw).trim();
  const m = s.match(/^="(.*)"$/s);
  if(m) return m[1].trim();
  return s.trim();
}
function toIsoDate(s){
  // input like 2026/03/29 -> 2026-03-29
  if(!s) return '';
  const t = s.trim().replace(/\./g,'/').replace(/-/g,'/');
  const parts = t.split('/');
  if(parts.length===3){
    let [y,mo,da] = parts;
    if(y.length!==4){ // maybe dd/mm/yyyy
      [da,mo,y] = parts;
    }
    return `${y.padStart(4,'0')}-${mo.padStart(2,'0')}-${da.padStart(2,'0')}`;
  }
  return s;
}
function parseAmount(s){
  if(s==null || s==='') return 0;
  const n = parseFloat(String(s).replace(/,/g,''));
  return isNaN(n) ? 0 : n;
}
function daysBetween(a,b){
  return Math.abs((new Date(a) - new Date(b)) / 86400000);
}

/* ---------------- toasts ---------------- */
function toast(msg, kind){
  const root = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' '+kind : '');
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(()=>{ el.style.transition='opacity .25s'; el.style.opacity='0'; setTimeout(()=>el.remove(),250); }, 3200);
}

/* ---------------- account computations ---------------- */
function getAccount(id){ return state.accounts.find(a=>a.id===id); }
function liveTx(acc){ return (acc.transactions||[]).filter(t=>!t.excluded); }

function accountTotal(acc){
  let t = acc.startingBalance || 0;
  for(const tx of liveTx(acc)){ t += (tx.credit||0) - (tx.debit||0); }
  return t;
}
function envelopeSum(acc){
  return (acc.envelopes||[]).reduce((s,e)=>s+(e.balance||0),0);
}
function unassignedBalance(acc){
  return accountTotal(acc) - envelopeSum(acc);
}
function tagLookup(tagGroupId, tagEntryId){
  const g = state.tagGroups.find(g=>g.id===tagGroupId);
  if(!g) return null;
  const e = g.entries.find(e=>e.id===tagEntryId);
  if(!e) return null;
  return { group:g, entry:e };
}
function txDisplayDescription(tx){
  return tx.descriptionOverride || tx.description || tx.altDescription || tx.code || '(no description)';
}
function autoTagForDescription(desc){
  if(!desc) return null;
  const up = desc.toUpperCase();
  for(const g of state.tagGroups){
    for(const e of g.entries){
      for(const kw of (e.matches||[])){
        if(kw && up.includes(kw.toUpperCase())) return { tagGroupId:g.id, tagEntryId:e.id };
      }
    }
  }
  return null;
}
function isIncomeCode(code){
  if(!code) return false;
  return state.settings.incomeCodes.some(c => c.toLowerCase() === code.toLowerCase());
}
function isExcludedFromSpending(tx){
  if(!tx.tagGroupId) return false;
  const g = state.tagGroups.find(g=>g.id===tx.tagGroupId);
  return !!(g && g.excludeFromSpending);
}
function convertToMVR(amount, currency){
  if(currency==='MVR') return amount;
  if(currency==='USD') return amount * (state.settings.exchangeRates.USD||0);
  if(currency==='EUR') return state.settings.exchangeRates.EUR ? amount*state.settings.exchangeRates.EUR : null;
  return amount;
}
/* =========================================================
   Part 2: shell — nav, router, modal helpers
   ========================================================= */
const ICONS = {
  dashboard:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="12" width="8" height="9" rx="2"/><rect x="3" y="14" width="8" height="7" rx="2"/></svg>',
  accounts:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2.5" y="6" width="19" height="13" rx="2.5"/><path d="M2.5 10h19"/><path d="M6 14.5h4"/></svg>',
  liabilities:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  flow:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h6l3 12h9"/><path d="M3 12h6"/><path d="M3 18h4"/></svg>',
  settings:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.5a7.9 7.9 0 0 0 0-3l2-1.6-2-3.4-2.4 1a8 8 0 0 0-2.6-1.5L14 2h-4l-.4 2.5a8 8 0 0 0-2.6 1.5l-2.4-1-2 3.4 2 1.6a7.9 7.9 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 2.6 1.5L10 22h4l.4-2.5a8 8 0 0 0 2.6-1.5l2.4 1 2-3.4z"/></svg>',
};

const NAV_ITEMS = [
  { key:'dashboard', label:'Dashboard' },
  { key:'accounts', label:'Accounts' },
  { key:'liabilities', label:'Liabilities' },
  { key:'flow', label:'Yearly Flow' },
  { key:'settings', label:'Settings' },
];

var route = { view:'dashboard', params:{} };

function go(view, params){
  route = { view, params: params||{} };
  render();
  window.scrollTo(0,0);
}

function renderNav(){
  const el = document.getElementById('navlist');
  el.innerHTML = NAV_ITEMS.map(n => `
    <div class="navitem ${route.view===n.key?'active':''}" data-action="nav" data-view="${n.key}">
      ${ICONS[n.key]}<span>${n.label}</span><span class="navdot"></span>
    </div>`).join('');
}

function renderPage(titleHtml, subHtml, actionsHtml, bodyHtml){
  return `
    <div class="topbar">
      <div>
        <div class="pagetitle">${titleHtml}</div>
        ${subHtml ? `<div class="pagesub">${subHtml}</div>` : ''}
      </div>
      ${actionsHtml ? `<div class="topbar-actions">${actionsHtml}</div>` : ''}
    </div>
    ${bodyHtml}
  `;
}

function render(){
  renderNav();
  const main = document.getElementById('main');
  if(route.view==='dashboard') main.innerHTML = renderDashboard();
  else if(route.view==='accounts') main.innerHTML = route.params.id ? renderAccountDetail(route.params.id) : renderAccountsList();
  else if(route.view==='liabilities') main.innerHTML = route.params.id ? renderLiabilityDetail(route.params.id) : renderLiabilitiesList();
  else if(route.view==='flow') main.innerHTML = renderFlow();
  else if(route.view==='settings') main.innerHTML = renderSettings();
  afterRender();
}

/* ---------------- modal helpers ---------------- */
function openModal(html, opts){
  const root = document.getElementById('modal-root');
  const wide = opts && opts.wide ? ' wide' : '';
  root.innerHTML = `<div class="modal-overlay" data-action="closeModalBg"><div class="modal${wide}" onclick="event.stopPropagation()">${html}</div></div>`;
  const firstInput = root.querySelector('input,select,textarea');
  if(firstInput) setTimeout(()=>firstInput.focus(), 30);
}
function closeModal(){
  document.getElementById('modal-root').innerHTML = '';
}
function confirmDialog(title, msg, onYes, yesLabel, danger){
  openModal(`
    <div class="modal-head"><div class="modal-title">${escapeHtml(title)}</div></div>
    <div class="muted" style="font-size:13.5px;line-height:1.55">${msg}</div>
    <div class="modal-actions">
      <button class="btn ghost" data-action="closeModal">Cancel</button>
      <button class="btn ${danger?'danger':'primary'}" id="confirm-yes-btn">${yesLabel||'Confirm'}</button>
    </div>
  `);
  document.getElementById('confirm-yes-btn').onclick = () => { closeModal(); onYes(); };
}

/* ---------------- global click delegation ---------------- */
document.addEventListener('click', (e)=>{
  const t = e.target.closest('[data-action]');
  if(!t) return;
  const action = t.dataset.action;
  if(action==='closeModalBg' && e.target === t){ closeModal(); return; }
  if(action==='closeModal'){ closeModal(); return; }
  if(action==='nav'){ go(t.dataset.view); return; }
  if(typeof ACTIONS[action] === 'function'){ ACTIONS[action](t, e); }
});

var ACTIONS = {}; // populated by later parts

function afterRender(){
  Object.keys(AFTER_RENDER_HOOKS).forEach(k=>{
    if(route.view===k) AFTER_RENDER_HOOKS[k]();
  });
}
var AFTER_RENDER_HOOKS = {};
/* =========================================================
   Part 3: Dashboard
   ========================================================= */
var dashboardMonth = currentMonthKey();

function collectUnmatched(){
  const items = [];
  for(const l of state.liabilities){
    for(const p of (l.payments||[])){
      if(!p.matched) items.push({ type:'liability payment', label:`${l.name} — ${fmtMoney(p.amount)} on ${fmtDate(p.date)}`, liabId:l.id });
    }
  }
  for(const a of state.accounts){
    for(const tx of liveTx(a)){
      if(tx.source==='manual' && !tx.matched){
        items.push({ type:'manual entry', label:`${txDisplayDescription(tx)} — ${fmtMoney(tx.debit||tx.credit)} on ${fmtDate(tx.date)} (${a.name})`, accId:a.id });
      }
    }
  }
  return items;
}

function monthDelta(mk, delta){
  const [y,m] = mk.split('-').map(Number);
  const d = new Date(y, m-1+delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
}

function renderDashboard(){
  const mk = dashboardMonth;
  let salary=0, spent=0;
  const placeMap = {}, purposeMap = {};
  const monthly = {}; // last 6 months spend

  for(let i=5;i>=0;i--) monthly[monthDelta(currentMonthKey(),-i)] = 0;

  for(const acc of state.accounts){
    for(const tx of liveTx(acc)){
      const tmk = monthKey(tx.date);
      const excluded = isExcludedFromSpending(tx);
      if(tmk===mk){
        if(tx.credit && tx.isIncome) salary += convertToMVR(tx.credit, acc.currency) || 0;
        if(tx.debit && !excluded){
          const mvr = convertToMVR(tx.debit, acc.currency) || 0;
          spent += mvr;
          const place = txDisplayDescription(tx);
          placeMap[place] = (placeMap[place]||0) + mvr;
          const lk = tagLookup(tx.tagGroupId, tx.tagEntryId);
          const purpose = lk ? lk.group.name : 'Untagged';
          purposeMap[purpose] = (purposeMap[purpose]||0) + mvr;
        }
      }
      if(monthly.hasOwnProperty(tmk) && tx.debit && !excluded){
        monthly[tmk] += convertToMVR(tx.debit, acc.currency) || 0;
      }
    }
  }

  const budget = state.settings.monthlyBudget || 0;
  const left = budget - spent;
  const pct = budget>0 ? Math.min(100, (spent/budget)*100) : 0;

  const netWorthMVR = state.accounts.filter(a=>!a.closed).reduce((s,a)=>{
    const conv = convertToMVR(accountTotal(a), a.currency);
    return s + (conv==null?0:conv);
  },0);
  const eurAccounts = state.accounts.filter(a=>!a.closed && a.currency==='EUR');

  const topPlaces = Object.entries(placeMap).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const topPurposes = Object.entries(purposeMap).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const maxPlace = Math.max(1, ...topPlaces.map(p=>p[1]));
  const maxPurpose = Math.max(1, ...topPurposes.map(p=>p[1]));

  const unmatched = collectUnmatched();

  const monthNav = `
    <button class="btn icon ghost" data-action="dashPrevMonth" title="Previous month">‹</button>
    <div class="badge grad" style="min-width:110px;justify-content:center">${monthLabel(mk)}</div>
    <button class="btn icon ghost" data-action="dashNextMonth" title="Next month" ${mk>=currentMonthKey()?'disabled':''}>›</button>
  `;

  const body = `
    ${unmatched.length ? `<div class="banner">
      ⚠️ ${unmatched.length} transaction${unmatched.length>1?'s':''} need reconciling against your statement.
      <button class="btn sm" data-action="showUnmatched">Review</button>
    </div>` : ''}

    <div class="grid grid-4" style="margin-bottom:18px;">
      <div class="card stat-card">
        <div class="stat-label">Salary received</div>
        <div class="stat-value">${fmtMoney(salary)}<small>MVR</small></div>
        <div class="stat-foot">${monthLabel(mk)}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Spent</div>
        <div class="stat-value">${fmtMoney(spent)}<small>MVR</small></div>
        <div class="stat-foot">${monthLabel(mk)}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Left to spend</div>
        <div class="stat-value" style="${left<0?'color:var(--red)':''}">${fmtMoney(left)}<small>MVR</small></div>
        <div class="stat-foot ${left<0?'down':''}">${budget>0?'of '+fmtMoney(budget)+' budget':'set a budget in Settings'}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Net worth</div>
        <div class="stat-value">${fmtMoney(netWorthMVR)}<small>MVR≈</small></div>
        <div class="stat-foot">${eurAccounts.length? eurAccounts.length+' EUR account(s) not converted':'across all open accounts'}</div>
      </div>
    </div>

    <div class="grid grid-3" style="align-items:stretch;">
      <div class="card" style="display:flex;flex-direction:column;align-items:center;gap:14px;">
        <div class="section-title sm" style="align-self:flex-start;">Budget used</div>
        <div class="orbit-wrap">${orbitRingSvg(pct)}
          <div class="orbit-center">
            <div class="pct">${budget>0?Math.round(pct)+'%':'—'}</div>
            <div class="lbl">${monthLabel(mk)}</div>
          </div>
        </div>
        <div style="display:flex;gap:10px;align-items:center;">${monthNav}</div>
      </div>

      <div class="card">
        <div class="section-title sm" style="margin-bottom:14px;">Top places</div>
        ${topPlaces.length ? `<div class="barlist">${topPlaces.map(([label,val])=>`
          <div class="barlist-row">
            <div class="lbl" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
            <div class="barlist-track"><div class="barlist-fill" style="width:${(val/maxPlace*100).toFixed(1)}%"></div></div>
            <div class="barlist-val">${fmtMoney(val)}</div>
          </div>`).join('')}</div>` : `<div class="faint" style="font-size:12.5px;">No spending yet this month.</div>`}
      </div>

      <div class="card">
        <div class="section-title sm" style="margin-bottom:14px;">Top purposes</div>
        ${topPurposes.length ? `<div class="barlist">${topPurposes.map(([label,val])=>`
          <div class="barlist-row">
            <div class="lbl" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
            <div class="barlist-track"><div class="barlist-fill" style="width:${(val/maxPurpose*100).toFixed(1)}%"></div></div>
            <div class="barlist-val">${fmtMoney(val)}</div>
          </div>`).join('')}</div>` : `<div class="faint" style="font-size:12.5px;">No tagged spending yet.</div>`}
      </div>
    </div>

    <div class="card" style="margin-top:16px;">
      <div class="section-title sm" style="margin-bottom:14px;">Spending, last 6 months</div>
      <div style="height:220px;"><canvas id="monthlyChart"></canvas></div>
    </div>
  `;

  window.__dashMonthlyData = monthly;
  return renderPage('Dashboard', 'A quick look at where things stand.', '', body);
}

function orbitRingSvg(pct){
  const r = 62, cx=75, cy=75, circ = 2*Math.PI*r;
  const dash = (Math.max(0,Math.min(100,pct))/100) * circ;
  return `<svg viewBox="0 0 150 150">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#0d3322" stroke-width="10"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#39ff6a" stroke-width="10"
      stroke-linecap="butt" stroke-dasharray="${dash} ${circ-dash}" style="filter:drop-shadow(0 0 4px #39ff6a);"/>
  </svg>`;
}

var monthlyChartInstance = null;
function drawMonthlyChart(){
  const canvas = document.getElementById('monthlyChart');
  if(!canvas || !window.__dashMonthlyData) return;
  const data = window.__dashMonthlyData;
  const labels = Object.keys(data).map(monthLabel);
  const values = Object.values(data).map(v=>Math.round(v*100)/100);
  if(monthlyChartInstance) monthlyChartInstance.destroy();
  monthlyChartInstance = new Chart(canvas.getContext('2d'), {
    type:'bar',
    data:{ labels, datasets:[{ data:values, backgroundColor:'#000080', borderColor:'#000000', borderWidth:1, borderRadius:0, maxBarThickness:34 }] },
    options:{
      plugins:{ legend:{display:false}, tooltip:{callbacks:{label:(c)=>' '+fmtMoney(c.parsed.y)+' MVR'}} },
      scales:{
        x:{ grid:{display:false}, ticks:{ color:'#000000', font:{family:'Tahoma',size:11} } },
        y:{ grid:{color:'#a8a8a8'}, ticks:{ color:'#000000', font:{family:'Consolas',size:10} } }
      }
    }
  });
}

function showUnmatchedModal(){
  const items = collectUnmatched();
  openModal(`
    <div class="modal-head"><div class="modal-title">Needs reconciling</div><span class="x-close" data-action="closeModal">✕</span></div>
    ${items.length ? items.map(it=>`
      <div class="settings-item" style="margin-bottom:8px;">
        <div>
          <div style="font-size:13px;">${escapeHtml(it.label)}</div>
          <div class="faint" style="font-size:11px;text-transform:uppercase;">${it.type}</div>
        </div>
        <button class="btn sm" data-action="${it.liabId?'openLiability':'openAccount'}" data-id="${it.liabId||it.accId}">Open</button>
      </div>`).join('') : `<div class="faint">All caught up — nothing to reconcile.</div>`}
  `, {wide:true});
}

AFTER_RENDER_HOOKS.dashboard = drawMonthlyChart;
ACTIONS.dashPrevMonth = ()=>{ dashboardMonth = monthDelta(dashboardMonth,-1); render(); };
ACTIONS.dashNextMonth = ()=>{ if(dashboardMonth<currentMonthKey()){ dashboardMonth = monthDelta(dashboardMonth,1); render(); } };
ACTIONS.showUnmatched = showUnmatchedModal;
ACTIONS.openLiability = (t)=>{ closeModal(); go('liabilities',{id:t.dataset.id}); };
ACTIONS.openAccount = (t)=>{ closeModal(); go('accounts',{id:t.dataset.id}); };
/* =========================================================
   Part 4: Accounts — list view + create/edit modals
   ========================================================= */
var showClosedAccounts = false;

function renderAccountsList(){
  const visible = state.accounts.filter(a=>!a.isSinking && (!a.closed || showClosedAccounts));
  const cards = visible.map(a => accountCardHtml(a)).join('');
  const closedCount = state.accounts.filter(a=>!a.isSinking && a.closed).length;

  const body = `
    ${visible.length ? `<div class="grid grid-3">${cards}</div>` : `
      <div class="empty">
        <div class="t">No accounts yet</div>
        <div style="font-size:12.5px;margin-bottom:14px;">Add your salary account to get started.</div>
        <button class="btn primary" data-action="newAccount">+ New account</button>
      </div>`}
    ${closedCount ? `<div style="margin-top:16px;">
      <button class="btn ghost sm" data-action="toggleClosedAccounts">${showClosedAccounts?'Hide':'Show'} closed accounts (${closedCount})</button>
    </div>` : ''}
  `;
  return renderPage('Accounts','Everything you hold, split the way you actually think about it.',
    `<button class="btn primary" data-action="newAccount">+ New account</button>`, body);
}

function accountCardHtml(a){
  const total = accountTotal(a);
  const unassigned = unassignedBalance(a);
  const envs = a.envelopes||[];
  const showUnassignedLine = unassigned > 0.004 || envs.length===0;
  return `
    <div class="card acct-card ${a.closed?'faint':''}" data-action="openAccount" data-id="${a.id}">
      <div class="top">
        <div>
          <div class="acct-name">${escapeHtml(a.name)}</div>
          <div class="acct-meta">${escapeHtml(a.type)}${a.accountNumber?' · '+escapeHtml(a.accountNumber):''}</div>
        </div>
        <div style="display:flex;gap:6px;">
          ${a.isMain?'<span class="badge grad">Main</span>':''}
          ${a.isSalary?'<span class="badge green">Salary</span>':''}
          ${a.closed?'<span class="badge">Closed</span>':''}
        </div>
      </div>
      <div class="acct-balance"><span class="cur">${a.currency}</span>${fmtMoney(showUnassignedLine?unassigned:0)}</div>
      ${envs.length ? `<div class="envelope-row">
        ${envs.map(e=>`<div class="env-chip">${escapeHtml(e.name)} <b>${fmtMoney(e.balance)}</b></div>`).join('')}
      </div>` : ''}
      ${!showUnassignedLine && envs.length ? `<div class="faint" style="font-size:11px;margin-top:8px;">fully allocated to envelopes · total ${fmtMoney(total)}</div>` : ''}
    </div>
  `;
}

function accountTypeOptions(selected){
  return state.settings.accountTypes.map(t=>`<option value="${escapeHtml(t)}" ${t===selected?'selected':''}>${escapeHtml(t)}</option>`).join('');
}

function openNewAccountModal(){
  openModal(`
    <div class="modal-head"><div class="modal-title">New account</div><span class="x-close" data-action="closeModal">✕</span></div>
    <form id="new-acct-form">
      <div class="field"><label>Account name</label><input type="text" name="name" placeholder="e.g. Salary Account" required></div>
      <div class="row">
        <div class="field"><label>Account number (optional)</label><input type="text" name="accountNumber" placeholder="7730-XXXXXXX"></div>
        <div class="field"><label>Currency</label><select name="currency">${CURRENCIES.map(c=>`<option>${c}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Type</label><select name="type">${accountTypeOptions()}</select></div>
      <div class="row">
        <div class="field"><label>Starting balance</label><input type="number" step="0.01" name="startingBalance" value="0"></div>
        <div class="field"><label>As of date</label><input type="date" name="startingDate" value="${todayIso()}"></div>
      </div>
      <div class="field" style="gap:10px;">
        <label class="checkline"><input type="checkbox" name="isMain"> This is my main account</label>
        <label class="checkline"><input type="checkbox" name="isSalary"> This is my salary account</label>
        <label class="checkline"><input type="checkbox" name="isSinking"> Sinking fund — hide from Accounts, manage from Settings</label>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-action="closeModal">Cancel</button>
        <button type="submit" class="btn primary">Create account</button>
      </div>
    </form>
  `);
  document.getElementById('new-acct-form').onsubmit = (e)=>{
    e.preventDefault();
    const f = new FormData(e.target);
    const acc = {
      id: uid('acc'),
      name: f.get('name').trim(),
      accountNumber: f.get('accountNumber').trim(),
      currency: f.get('currency'),
      type: f.get('type'),
      isMain: !!f.get('isMain'),
      isSalary: !!f.get('isSalary'),
      isSinking: !!f.get('isSinking'),
      closed: false,
      startingBalance: parseAmount(f.get('startingBalance')),
      startingDate: f.get('startingDate') || todayIso(),
      envelopes: [],
      transactions: [],
    };
    if(acc.isMain) state.accounts.forEach(a=>a.isMain=false);
    if(acc.isSalary) state.accounts.forEach(a=>a.isSalary=false);
    state.accounts.push(acc);
    scheduleSave();
    closeModal();
    toast('Account created','success');
    go('accounts', {id:acc.id});
  };
}

function openEditAccountModal(id){
  const a = getAccount(id); if(!a) return;
  openModal(`
    <div class="modal-head"><div class="modal-title">Edit account</div><span class="x-close" data-action="closeModal">✕</span></div>
    <form id="edit-acct-form">
      <div class="field"><label>Account name</label><input type="text" name="name" value="${escapeHtml(a.name)}" required></div>
      <div class="row">
        <div class="field"><label>Account number</label><input type="text" name="accountNumber" value="${escapeHtml(a.accountNumber||'')}"></div>
        <div class="field"><label>Currency</label><select name="currency">${CURRENCIES.map(c=>`<option ${c===a.currency?'selected':''}>${c}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Type</label><select name="type">${accountTypeOptions(a.type)}</select></div>
      <div class="row">
        <div class="field"><label>Starting balance</label><input type="number" step="0.01" name="startingBalance" value="${a.startingBalance}"></div>
        <div class="field"><label>As of date</label><input type="date" name="startingDate" value="${a.startingDate}"></div>
      </div>
      <div class="field" style="gap:10px;">
        <label class="checkline"><input type="checkbox" name="isMain" ${a.isMain?'checked':''}> Main account</label>
        <label class="checkline"><input type="checkbox" name="isSalary" ${a.isSalary?'checked':''}> Salary account</label>
        <label class="checkline"><input type="checkbox" name="isSinking" ${a.isSinking?'checked':''}> Sinking fund (hidden)</label>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn danger" data-action="closeAccountConfirm" data-id="${a.id}">Close account</button>
        <button type="submit" class="btn primary">Save changes</button>
      </div>
    </form>
  `);
  document.getElementById('edit-acct-form').onsubmit = (e)=>{
    e.preventDefault();
    const f = new FormData(e.target);
    if(f.get('isMain')) state.accounts.forEach(x=>x.isMain=false);
    if(f.get('isSalary')) state.accounts.forEach(x=>x.isSalary=false);
    Object.assign(a, {
      name: f.get('name').trim(),
      accountNumber: f.get('accountNumber').trim(),
      currency: f.get('currency'),
      type: f.get('type'),
      isMain: !!f.get('isMain'),
      isSalary: !!f.get('isSalary'),
      isSinking: !!f.get('isSinking'),
      startingBalance: parseAmount(f.get('startingBalance')),
      startingDate: f.get('startingDate'),
    });
    scheduleSave();
    closeModal();
    render();
    toast('Account updated','success');
  };
}

ACTIONS.newAccount = openNewAccountModal;
ACTIONS.openAccount = (t)=> go('accounts', {id:t.dataset.id});
ACTIONS.editAccount = (t)=> openEditAccountModal(t.dataset.id);
ACTIONS.toggleClosedAccounts = ()=>{ showClosedAccounts = !showClosedAccounts; render(); };
ACTIONS.closeAccountConfirm = (t)=>{
  const id = t.dataset.id;
  confirmDialog('Close this account?','Closed accounts are kept for your records but hidden from the main list. You can reopen them later from Settings history.',()=>{
    const a = getAccount(id); a.closed = true; scheduleSave(); go('accounts');
    toast('Account closed','success');
  }, 'Close account', true);
};
ACTIONS.reopenAccount = (t)=>{ const a=getAccount(t.dataset.id); a.closed=false; scheduleSave(); render(); toast('Account reopened','success'); };
/* =========================================================
   Part 5: Account detail — envelopes + statement
   ========================================================= */
var txFilters = { accId:null, q:'', code:'', tag:'', unmatchedOnly:false };

function resetFiltersIfNeeded(accId){
  if(txFilters.accId !== accId){ txFilters = { accId, q:'', code:'', tag:'', unmatchedOnly:false }; }
}

function renderAccountDetail(id){
  const a = getAccount(id);
  if(!a) return renderAccountsList();
  resetFiltersIfNeeded(id);

  const total = accountTotal(a);
  const unassigned = unassignedBalance(a);
  const envs = a.envelopes || [];
  const showUnassignedLine = unassigned > 0.004 || envs.length===0;

  const codes = [...new Set(liveTx(a).map(t=>t.code).filter(Boolean))].sort();

  const rows = filteredTransactions(a);

  const body = `
    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px;">
        <div>
          <div style="display:flex;align-items:center;gap:9px;">
            <div class="acct-name" style="font-size:20px;">${escapeHtml(a.name)}</div>
            ${a.isMain?'<span class="badge grad">Main</span>':''}
            ${a.isSalary?'<span class="badge green">Salary</span>':''}
            ${a.isSinking?'<span class="badge amber">Sinking</span>':''}
            ${a.closed?'<span class="badge">Closed</span>':''}
          </div>
          <div class="acct-meta" style="margin-top:4px;">${escapeHtml(a.type)}${a.accountNumber?' · '+escapeHtml(a.accountNumber):''} · opened ${fmtDate(a.startingDate)}</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn ghost sm" data-action="editAccount" data-id="${a.id}">Edit</button>
          <button class="btn sm" data-action="openImport" data-id="${a.id}">⇩ Import statement</button>
          <button class="btn primary sm" data-action="newTx" data-id="${a.id}">+ Add transaction</button>
        </div>
      </div>

      <div style="display:flex;gap:32px;flex-wrap:wrap;margin-top:20px;">
        ${showUnassignedLine ? `<div>
          <div class="stat-label">Account balance</div>
          <div class="acct-balance"><span class="cur">${a.currency}</span>${fmtMoney(unassigned)}</div>
        </div>` : ''}
        <div>
          <div class="stat-label">Total in account</div>
          <div class="acct-balance" style="font-size:17px;color:var(--text-dim);">${a.currency} ${fmtMoney(total)}</div>
        </div>
      </div>

      <div class="envelope-row" style="margin-top:18px;">
        ${envs.map(e=>`
          <div class="env-chip" style="cursor:pointer;padding:7px 12px;" data-action="openEnvelope" data-id="${a.id}" data-env="${e.id}">
            ${escapeHtml(e.name)} <b>${fmtMoney(e.balance)}</b>
            ${e.goal?`<span class="faint">/ ${fmtMoney(e.goal)}</span>`:''}
          </div>`).join('')}
        <button class="btn ghost sm" data-action="newEnvelope" data-id="${a.id}">+ Envelope</button>
      </div>
    </div>

    <div class="card">
      <div class="section-head">
        <div class="section-title">Statement</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <input type="text" id="tx-search" placeholder="Search description…" value="${escapeHtml(txFilters.q)}" style="width:180px;">
          <select id="tx-code-filter"><option value="">All types</option>${codes.map(c=>`<option value="${escapeHtml(c)}" ${txFilters.code===c?'selected':''}>${escapeHtml(c)}</option>`).join('')}</select>
          <select id="tx-tag-filter"><option value="">All tags</option>${state.tagGroups.map(g=>`<option value="${g.id}" ${txFilters.tag===g.id?'selected':''}>${escapeHtml(g.name)}</option>`).join('')}<option value="__none__" ${txFilters.tag==='__none__'?'selected':''}>Untagged</option></select>
          <label class="checkline"><input type="checkbox" id="tx-unmatched" ${txFilters.unmatchedOnly?'checked':''}> Unmatched only</label>
        </div>
      </div>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Description</th><th>Type</th><th>Tag</th><th>Envelope</th><th style="text-align:right;">Amount</th><th></th></tr></thead>
        <tbody>${rows.map(tx=>transactionRowHtml(a, tx)).join('')}</tbody>
      </table></div>` : `<div class="empty"><div class="t">No transactions match</div><div style="font-size:12.5px;">Import a statement or add one manually.</div></div>`}
    </div>
  `;

  return renderPage(
    `<span data-action="backToAccounts" style="cursor:pointer;color:var(--text-faint);">Accounts</span> <span class="faint">/</span> ${escapeHtml(a.name)}`,
    '', '', body
  );
}

function filteredTransactions(a){
  let rows = liveTx(a).slice();
  if(txFilters.q) rows = rows.filter(t=>txDisplayDescription(t).toLowerCase().includes(txFilters.q.toLowerCase()));
  if(txFilters.code) rows = rows.filter(t=>t.code===txFilters.code);
  if(txFilters.tag==='__none__') rows = rows.filter(t=>!t.tagGroupId);
  else if(txFilters.tag) rows = rows.filter(t=>t.tagGroupId===txFilters.tag);
  if(txFilters.unmatchedOnly) rows = rows.filter(t=>!t.matched);
  rows.sort((x,y)=> y.date.localeCompare(x.date) || (y._seq||0)-(x._seq||0));
  return rows;
}

function transactionRowHtml(a, tx){
  const lk = tagLookup(tx.tagGroupId, tx.tagEntryId);
  const env = (a.envelopes||[]).find(e=>e.id===tx.envelopeId);
  return `
    <tr>
      <td class="num" style="white-space:nowrap;color:var(--text-dim);">${fmtDate(tx.date)}</td>
      <td style="min-width:180px;">
        <input class="desc-edit" value="${escapeHtml(txDisplayDescription(tx))}" data-id="${a.id}" data-tx="${tx.id}">
        ${!tx.matched?'<span class="badge amber" style="margin-top:4px;">unmatched</span>':''}
      </td>
      <td><span class="badge">${escapeHtml(tx.code||'—')}</span></td>
      <td>
        <span class="tagchip ${lk?'':'empty'}" data-action="tagTx" data-id="${a.id}" data-tx="${tx.id}">
          ${lk?`<span class="swatch"></span>${escapeHtml(lk.entry.name)}`:'+ tag'}
        </span>
      </td>
      <td>
        <select data-action="setEnvelope" data-id="${a.id}" data-tx="${tx.id}" style="padding:4px 7px;font-size:11.5px;width:auto;">
          <option value="">—</option>
          ${(a.envelopes||[]).map(e=>`<option value="${e.id}" ${tx.envelopeId===e.id?'selected':''}>${escapeHtml(e.name)}</option>`).join('')}
        </select>
      </td>
      <td class="amt ${tx.credit?'credit':'debit'}">
        ${tx.credit? '+'+fmtMoney(tx.credit) : '−'+fmtMoney(tx.debit)}
        ${tx.credit ? `<div><span class="badge ${tx.isIncome?'green':''}" style="cursor:pointer;margin-top:4px;" data-action="toggleIncome" data-id="${a.id}" data-tx="${tx.id}">${tx.isIncome?'income':'not income'}</span></div>` : ''}
      </td>
      <td><span class="x-close" data-action="deleteTx" data-id="${a.id}" data-tx="${tx.id}" title="Remove">✕</span></td>
    </tr>
  `;
}

/* ---------------- envelopes ---------------- */
function openNewEnvelopeModal(accId){
  openModal(`
    <div class="modal-head"><div class="modal-title">New envelope</div><span class="x-close" data-action="closeModal">✕</span></div>
    <form id="new-env-form">
      <div class="field"><label>Name</label><input type="text" name="name" placeholder="e.g. Travel" required></div>
      <div class="field"><label>Goal amount (optional)</label><input type="number" step="0.01" name="goal" placeholder="0"></div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-action="closeModal">Cancel</button>
        <button type="submit" class="btn primary">Create</button>
      </div>
    </form>
  `);
  document.getElementById('new-env-form').onsubmit = (e)=>{
    e.preventDefault();
    const f = new FormData(e.target);
    const a = getAccount(accId);
    a.envelopes = a.envelopes || [];
    a.envelopes.push({ id: uid('env'), name: f.get('name').trim(), balance:0, goal: parseAmount(f.get('goal'))||null });
    scheduleSave(); closeModal(); render();
  };
}

function openEnvelopeModal(accId, envId){
  const a = getAccount(accId); const e = (a.envelopes||[]).find(x=>x.id===envId); if(!e) return;
  const unassigned = unassignedBalance(a);
  openModal(`
    <div class="modal-head"><div class="modal-title">${escapeHtml(e.name)}</div><span class="x-close" data-action="closeModal">✕</span></div>
    <div class="kv"><div class="k">Envelope balance</div><div class="v">${a.currency} ${fmtMoney(e.balance)}</div></div>
    ${e.goal?`<div class="kv"><div class="k">Goal</div><div class="v">${a.currency} ${fmtMoney(e.goal)}</div></div>
    <div class="progress"><div style="width:${Math.min(100,e.balance/e.goal*100)}%"></div></div>`:''}
    <div style="margin-top:18px;">
      <div class="section-title sm" style="margin-bottom:10px;">Move money</div>
      <form id="env-move-form">
        <div class="row">
          <div class="field"><label>Direction</label>
            <select name="dir">
              <option value="in">From account balance → ${escapeHtml(e.name)}</option>
              <option value="out">From ${escapeHtml(e.name)} → account balance</option>
            </select>
          </div>
          <div class="field"><label>Amount</label><input type="number" step="0.01" name="amount" required></div>
        </div>
        <div class="hint" style="margin-bottom:10px;">Unassigned account balance: ${fmtMoney(unassigned)}</div>
        <div class="modal-actions" style="justify-content:space-between;">
          <button type="button" class="btn danger sm" data-action="deleteEnvelopeConfirm" data-id="${accId}" data-env="${envId}">Delete envelope</button>
          <div style="display:flex;gap:8px;">
            <button type="button" class="btn ghost" data-action="closeModal">Close</button>
            <button type="submit" class="btn primary">Move</button>
          </div>
        </div>
      </form>
    </div>
  `);
  document.getElementById('env-move-form').onsubmit = (ev)=>{
    ev.preventDefault();
    const f = new FormData(ev.target);
    const amt = parseAmount(f.get('amount'));
    const dir = f.get('dir');
    if(amt<=0) return;
    if(dir==='in'){
      if(amt > unassignedBalance(a)+0.001){ toast('Not enough unassigned balance','error'); return; }
      e.balance += amt;
    } else {
      if(amt > e.balance+0.001){ toast('Envelope does not have that much','error'); return; }
      e.balance -= amt;
    }
    scheduleSave(); closeModal(); render();
  };
}

ACTIONS.newEnvelope = (t)=> openNewEnvelopeModal(t.dataset.id);
ACTIONS.openEnvelope = (t)=> openEnvelopeModal(t.dataset.id, t.dataset.env);
ACTIONS.deleteEnvelopeConfirm = (t)=>{
  const accId=t.dataset.id, envId=t.dataset.env;
  confirmDialog('Delete this envelope?','Its balance will fold back into the unassigned account balance.',()=>{
    const a = getAccount(accId);
    a.envelopes = a.envelopes.filter(e=>e.id!==envId);
    a.transactions.forEach(tx=>{ if(tx.envelopeId===envId) tx.envelopeId=null; });
    scheduleSave(); closeModal(); render();
  }, 'Delete', true);
};
ACTIONS.backToAccounts = ()=> go('accounts');
ACTIONS.toggleIncome = (t)=>{
  const a = getAccount(t.dataset.id); const tx = a.transactions.find(x=>x.id===t.dataset.tx);
  tx.isIncome = !tx.isIncome; scheduleSave(); render();
};
ACTIONS.setEnvelope = (t)=>{
  const a = getAccount(t.dataset.id); const tx = a.transactions.find(x=>x.id===t.dataset.tx);
  tx.envelopeId = t.value || null; scheduleSave();
};
ACTIONS.deleteTx = (t)=>{
  const a = getAccount(t.dataset.id); const tx = a.transactions.find(x=>x.id===t.dataset.tx);
  confirmDialog('Remove this transaction?', tx.source==='import' ? 'It will be hidden and excluded from totals. Re-importing the same statement will not bring it back.' : 'This manual entry will be deleted for good.', ()=>{
    if(tx.source==='import') tx.excluded = true;
    else a.transactions = a.transactions.filter(x=>x.id!==tx.id);
    scheduleSave(); render();
  }, 'Remove', true);
};

/* filter input wiring (delegated via input events, set up per render) */
AFTER_RENDER_HOOKS.accounts = function(){
  const s = document.getElementById('tx-search');
  const c = document.getElementById('tx-code-filter');
  const g = document.getElementById('tx-tag-filter');
  const u = document.getElementById('tx-unmatched');
  if(s) s.oninput = ()=>{ txFilters.q = s.value; renderInPlaceStatement(); };
  if(c) c.onchange = ()=>{ txFilters.code = c.value; render(); };
  if(g) g.onchange = ()=>{ txFilters.tag = g.value; render(); };
  if(u) u.onchange = ()=>{ txFilters.unmatchedOnly = u.checked; render(); };
  // description inline editing
  document.querySelectorAll('.desc-edit').forEach(inp=>{
    inp.addEventListener('change', ()=>{
      const a = getAccount(inp.dataset.id); const tx = a.transactions.find(x=>x.id===inp.dataset.tx);
      tx.descriptionOverride = inp.value.trim() || null;
      scheduleSave();
    });
  });
};
function renderInPlaceStatement(){ render(); }
/* =========================================================
   Part 6: manual transactions + tagging
   ========================================================= */
function findPossibleDuplicate(a, date, amount, isDebit){
  return liveTx(a).find(t=>{
    if(daysBetween(t.date, date) > 2) return false;
    const amt = isDebit ? t.debit : t.credit;
    return Math.abs((amt||0) - amount) < 0.005 && (isDebit ? t.debit>0 : t.credit>0);
  });
}

function openNewTxModal(accId){
  const a = getAccount(accId);
  openModal(`
    <div class="modal-head"><div class="modal-title">Add transaction</div><span class="x-close" data-action="closeModal">✕</span></div>
    <form id="new-tx-form">
      <div class="row">
        <div class="field"><label>Date</label><input type="date" name="date" value="${todayIso()}" required></div>
        <div class="field"><label>Type</label>
          <div class="segmented" id="tx-dir-seg">
            <button type="button" class="active" data-v="debit">Expense</button>
            <button type="button" data-v="credit">Income</button>
          </div>
          <input type="hidden" name="dir" value="debit">
        </div>
      </div>
      <div class="field"><label>Description</label><input type="text" name="description" placeholder="e.g. Nisal Mart" required></div>
      <div class="row">
        <div class="field"><label>Amount (${a.currency})</label><input type="number" step="0.01" name="amount" required></div>
        <div class="field"><label>Category code (optional)</label><input type="text" name="code" placeholder="e.g. Purchase"></div>
      </div>
      <div class="field"><label>Envelope (optional)</label>
        <select name="envelopeId"><option value="">—</option>${(a.envelopes||[]).map(e=>`<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('')}</select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-action="closeModal">Cancel</button>
        <button type="submit" class="btn primary">Add transaction</button>
      </div>
    </form>
  `);
  const seg = document.getElementById('tx-dir-seg');
  seg.querySelectorAll('button').forEach(b=>b.onclick = ()=>{
    seg.querySelectorAll('button').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    document.querySelector('#new-tx-form input[name=dir]').value = b.dataset.v;
  });
  document.getElementById('new-tx-form').onsubmit = (e)=>{
    e.preventDefault();
    const f = new FormData(e.target);
    const dir = f.get('dir');
    const amount = parseAmount(f.get('amount'));
    const date = f.get('date');
    const desc = f.get('description').trim();
    const doAdd = ()=>{
      const auto = autoTagForDescription(desc);
      const tx = {
        id: uid('tx'), date, code: f.get('code').trim()||'Manual',
        uniqueId:null, description: desc, altDescription:'', descriptionOverride:null,
        debit: dir==='debit'?amount:0, credit: dir==='credit'?amount:0,
        balance:null, tagGroupId: auto?auto.tagGroupId:null, tagEntryId: auto?auto.tagEntryId:null,
        envelopeId: f.get('envelopeId')||null, source:'manual', matched:false,
        isIncome: dir==='credit' && isIncomeCode(f.get('code').trim()||'Manual'), _seq: Date.now(),
      };
      a.transactions.push(tx);
      scheduleSave(); closeModal(); render();
      toast('Transaction added','success');
    };
    const dup = findPossibleDuplicate(a, date, amount, dir==='debit');
    if(dup){
      confirmDialog('Possible duplicate', `There is already a transaction of ${fmtMoney(amount)} around ${fmtDate(date)} (${escapeHtml(txDisplayDescription(dup))}). Add this one anyway?`, doAdd, 'Add anyway');
    } else doAdd();
  };
}

/* ---------------- tagging ---------------- */
function openTagModal(accId, txId){
  const a = getAccount(accId); const tx = a.transactions.find(x=>x.id===txId);
  const desc = tx.description || tx.altDescription || '';
  openModal(`
    <div class="modal-head"><div class="modal-title">Tag transaction</div><span class="x-close" data-action="closeModal">✕</span></div>
    <div class="faint" style="font-size:12px;margin-bottom:14px;">${escapeHtml(txDisplayDescription(tx))}</div>
    <div id="tag-groups-wrap">${state.tagGroups.map(g=>tagGroupBlockHtml(g, accId, txId)).join('')}</div>
    <div class="field" style="margin-top:14px;">
      <label>New tag group</label>
      <div class="row">
        <input type="text" id="new-group-name" placeholder="e.g. Groceries" style="flex:1;">
        <button class="btn sm" data-action="addTagGroup" data-id="${accId}" data-tx="${txId}">Add</button>
      </div>
    </div>
    ${tx.tagGroupId ? `<div class="modal-actions" style="justify-content:flex-start;"><button class="btn ghost sm" data-action="clearTag" data-id="${accId}" data-tx="${txId}">Remove current tag</button></div>` : ''}
  `, {wide:true});
}

function tagGroupBlockHtml(g, accId, txId){
  return `
    <div class="tag-group-block">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-weight:700;font-size:13px;">${escapeHtml(g.name)}</div>
        ${g.savings?'<span class="badge green">savings</span>':''}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:7px;margin-bottom:8px;">
        ${g.entries.map(e=>`<span class="tagchip" data-action="pickTagEntry" data-id="${accId}" data-tx="${txId}" data-group="${g.id}" data-entry="${e.id}"><span class="swatch"></span>${escapeHtml(e.name)}</span>`).join('') || '<span class="faint" style="font-size:12px;">No places yet.</span>'}
      </div>
      <div class="row">
        <input type="text" placeholder="+ add a place / entry" class="new-entry-input" data-group="${g.id}" style="flex:1;">
        <button class="btn sm" data-action="addTagEntry" data-id="${accId}" data-tx="${txId}" data-group="${g.id}">Add</button>
      </div>
    </div>
  `;
}

function maybeLearnAndAssign(accId, txId, groupId, entryId){
  const a = getAccount(accId); const tx = a.transactions.find(x=>x.id===txId);
  const g = state.tagGroups.find(x=>x.id===groupId); const entry = g.entries.find(x=>x.id===entryId);
  const desc = (tx.description || tx.altDescription || '').trim();
  const already = desc && entry.matches.some(m=>desc.toUpperCase().includes(m.toUpperCase()));
  const assign = ()=>{ tx.tagGroupId=groupId; tx.tagEntryId=entryId; scheduleSave(); closeModal(); render(); };
  if(desc && !already){
    confirmDialog('Make this permanent?', `Always tag future transactions from <b>${escapeHtml(desc)}</b> as <b>${escapeHtml(entry.name)}</b>?`, ()=>{
      entry.matches.push(desc.toUpperCase()); assign();
    }, 'Yes, always');
    // also allow "just this once" — wire cancel to assign without learning
    setTimeout(()=>{
      const cancelBtn = document.querySelector('.modal-actions .btn.ghost');
      if(cancelBtn) cancelBtn.onclick = assign;
    }, 0);
  } else assign();
}

ACTIONS.newTx = (t)=> openNewTxModal(t.dataset.id);
ACTIONS.tagTx = (t)=> openTagModal(t.dataset.id, t.dataset.tx);
ACTIONS.pickTagEntry = (t)=> maybeLearnAndAssign(t.dataset.id, t.dataset.tx, t.dataset.group, t.dataset.entry);
ACTIONS.clearTag = (t)=>{ const a=getAccount(t.dataset.id); const tx=a.transactions.find(x=>x.id===t.dataset.tx); tx.tagGroupId=null; tx.tagEntryId=null; scheduleSave(); closeModal(); render(); };
ACTIONS.addTagGroup = (t)=>{
  const input = document.getElementById('new-group-name'); const name = input.value.trim();
  if(!name) return;
  const g = { id: uid('tg'), name, savings:false, entries:[] };
  state.tagGroups.push(g); scheduleSave();
  openTagModal(t.dataset.id, t.dataset.tx);
};
ACTIONS.addTagEntry = (t)=>{
  const wrap = t.closest('.tag-group-block');
  const input = wrap.querySelector('.new-entry-input'); const name = input.value.trim();
  if(!name) return;
  const g = state.tagGroups.find(x=>x.id===t.dataset.group);
  const a = getAccount(t.dataset.id); const tx = a.transactions.find(x=>x.id===t.dataset.tx);
  const desc = (tx.description || tx.altDescription || '').trim();
  const entry = { id: uid('te'), name, matches: desc ? [desc.toUpperCase()] : [] };
  g.entries.push(entry);
  tx.tagGroupId = g.id; tx.tagEntryId = entry.id;
  scheduleSave(); closeModal(); render();
  toast(`Tagged as ${name}`,'success');
};
/* =========================================================
   Part 7: CSV statement import
   ========================================================= */
function parseStatementCSV(text){
  const parsed = Papa.parse(text.trim(), { skipEmptyLines:true });
  const out = [];
  for(const r of parsed.data){
    if(!r || !r[0]) continue;
    const date = toIsoDate(cleanCsvField(r[0]));
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // skip header/garbage rows
    out.push({
      date,
      code: cleanCsvField(r[2]),
      uniqueId: cleanCsvField(r[3]),
      altDescription: cleanCsvField(r[5]),
      description: cleanCsvField(r[6]),
      debit: parseAmount(cleanCsvField(r[8])),
      credit: parseAmount(cleanCsvField(r[9])),
      balance: r[10]!==undefined ? parseAmount(cleanCsvField(r[10])) : null,
    });
  }
  return out;
}

function openImportModal(accId){
  const a = getAccount(accId);
  openModal(`
    <div class="modal-head"><div class="modal-title">Import statement — ${escapeHtml(a.name)}</div><span class="x-close" data-action="closeModal">✕</span></div>
    <div class="field">
      <label>CSV export from BML internet banking</label>
      <input type="file" id="csv-file" accept=".csv,text/csv">
      <div class="hint">Columns expected: date, code, unique ID, description, debit, credit — same layout as your BML statement export.</div>
    </div>
    <div id="import-preview"></div>
  `, {wide:true});
  document.getElementById('csv-file').addEventListener('change', (e)=>{
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let rows;
      try{ rows = parseStatementCSV(reader.result); }
      catch(err){ document.getElementById('import-preview').innerHTML = `<div class="banner">Could not read that file as a statement CSV.</div>`; return; }
      if(!rows.length){ document.getElementById('import-preview').innerHTML = `<div class="banner">No recognizable transaction rows found.</div>`; return; }
      renderImportPreview(accId, rows);
    };
    reader.readAsText(file);
  });
}

function classifyRows(a, rows){
  const existingIds = new Set(a.transactions.filter(t=>t.uniqueId).map(t=>t.uniqueId));
  const toAdd = [], toMerge = [];
  let skipped = 0;
  for(const row of rows){
    if(row.uniqueId && existingIds.has(row.uniqueId)){ skipped++; continue; }
    const isDebit = row.debit > 0;
    const manualMatch = a.transactions.find(t =>
      t.source==='manual' && !t.matched &&
      Math.abs(((isDebit?t.debit:t.credit)||0) - (isDebit?row.debit:row.credit)) < 0.005 &&
      daysBetween(t.date, row.date) <= 5
    );
    if(manualMatch) toMerge.push({row, manualMatch});
    else toAdd.push(row);
  }
  return { toAdd, toMerge, skipped };
}

function renderImportPreview(accId, rows){
  const a = getAccount(accId);
  const { toAdd, toMerge, skipped } = classifyRows(a, rows);
  document.getElementById('import-preview').innerHTML = `
    <div class="grid grid-3" style="margin:14px 0;">
      <div class="card card-tight"><div class="stat-label">New</div><div class="stat-value" style="font-size:20px;">${toAdd.length}</div></div>
      <div class="card card-tight"><div class="stat-label">Matched to manual entries</div><div class="stat-value" style="font-size:20px;">${toMerge.length}</div></div>
      <div class="card card-tight"><div class="stat-label">Already imported</div><div class="stat-value" style="font-size:20px;">${skipped}</div></div>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" data-action="closeModal">Cancel</button>
      <button class="btn primary" data-action="confirmImport" data-id="${accId}">Import ${toAdd.length + toMerge.length} transaction${(toAdd.length+toMerge.length)!==1?'s':''}</button>
    </div>
  `;
  window.__pendingImport = { accId, rows };
}

function commitImport(accId, rows){
  const a = getAccount(accId);
  const { toAdd, toMerge, skipped } = classifyRows(a, rows);
  for(const {row, manualMatch} of toMerge){
    manualMatch.uniqueId = row.uniqueId || null;
    manualMatch.code = row.code || manualMatch.code;
    manualMatch.description = row.description || manualMatch.description;
    manualMatch.altDescription = row.altDescription;
    manualMatch.balance = row.balance;
    manualMatch.source = 'import';
    manualMatch.matched = true;
    if(manualMatch.isIncome===undefined) manualMatch.isIncome = isIncomeCode(row.code);
    if(!manualMatch.tagGroupId){
      const auto = autoTagForDescription(row.description);
      if(auto){ manualMatch.tagGroupId = auto.tagGroupId; manualMatch.tagEntryId = auto.tagEntryId; }
    }
  }
  for(const row of toAdd){
    const auto = autoTagForDescription(row.description);
    a.transactions.push({
      id: uid('tx'), date: row.date, code: row.code, uniqueId: row.uniqueId||null,
      description: row.description, altDescription: row.altDescription, descriptionOverride:null,
      debit: row.debit, credit: row.credit, balance: row.balance,
      tagGroupId: auto?auto.tagGroupId:null, tagEntryId: auto?auto.tagEntryId:null,
      envelopeId:null, source:'import', matched:true, isIncome: isIncomeCode(row.code), _seq: Date.now()+Math.random(),
    });
  }
  scheduleSave();
  closeModal();
  render();
  toast(`Imported ${toAdd.length} new, matched ${toMerge.length}, skipped ${skipped} duplicate${skipped!==1?'s':''}`, 'success');
}

ACTIONS.openImport = (t)=> openImportModal(t.dataset.id);
ACTIONS.confirmImport = (t)=>{
  const p = window.__pendingImport;
  if(p) commitImport(p.accId, p.rows);
};
/* =========================================================
   Part 8: Liabilities
   ========================================================= */
function renderLiabilitiesList(){
  const open = state.liabilities.filter(l=>!l.closed);
  const closed = state.liabilities.filter(l=>l.closed);
  const body = `
    ${open.length ? `<div class="grid grid-3">${open.map(liabilityCardHtml).join('')}</div>` : `
      <div class="empty"><div class="t">No liabilities tracked</div><div style="font-size:12.5px;margin-bottom:14px;">Add a loan or something you owe someone.</div>
      <button class="btn primary" data-action="newLiability">+ New liability</button></div>`}
    ${closed.length ? `<div style="margin-top:26px;">
      <div class="section-title sm" style="margin-bottom:10px;">Paid off</div>
      <div class="grid grid-3">${closed.map(liabilityCardHtml).join('')}</div>
    </div>` : ''}
  `;
  return renderPage('Liabilities','Loans and debts, tracked to zero.',
    open.length||closed.length ? `<button class="btn primary" data-action="newLiability">+ New liability</button>` : '', body);
}

function liabilityCardHtml(l){
  const pct = l.principal>0 ? Math.min(100, (l.totalPaid/l.principal)*100) : 0;
  const acc = getAccount(l.repaymentAccountId);
  return `
    <div class="card liab-card ${l.closed?'faint':''}" data-action="openLiability" data-id="${l.id}" style="cursor:pointer;">
      <div class="acct-name">${escapeHtml(l.name)}</div>
      <div class="acct-meta">${acc?escapeHtml(acc.name):'no account set'} · ${fmtMoney(l.monthlyRepayment)}/mo</div>
      <div class="acct-balance" style="font-size:20px;margin-top:12px;">${fmtMoney(Math.max(0,l.principal-l.totalPaid))}<span style="font-size:12px;color:var(--text-dim);"> remaining</span></div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      <div class="liab-row"><span>${fmtMoney(l.totalPaid)} paid</span><span>${fmtMoney(l.principal)} total</span></div>
      ${l.closed?`<div style="margin-top:10px;"><span class="badge green">Paid off</span> ${l.interestPaid>0?`<span class="badge amber">${fmtMoney(l.interestPaid)} interest</span>`:''}</div>`:''}
    </div>
  `;
}

function openNewLiabilityModal(){
  openModal(`
    <div class="modal-head"><div class="modal-title">New liability</div><span class="x-close" data-action="closeModal">✕</span></div>
    <form id="new-liab-form">
      <div class="field"><label>Name</label><input type="text" name="name" placeholder="e.g. Car loan / Pay back Ali" required></div>
      <div class="row">
        <div class="field"><label>Total amount owed</label><input type="number" step="0.01" name="principal" required></div>
        <div class="field"><label>Monthly repayment</label><input type="number" step="0.01" name="monthlyRepayment" required></div>
      </div>
      <div class="field"><label>Repayment account</label>
        <select name="repaymentAccountId">${state.accounts.filter(a=>!a.closed).map(a=>`<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}</select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-action="closeModal">Cancel</button>
        <button type="submit" class="btn primary">Add liability</button>
      </div>
    </form>
  `);
  document.getElementById('new-liab-form').onsubmit = (e)=>{
    e.preventDefault();
    const f = new FormData(e.target);
    state.liabilities.push({
      id: uid('liab'), name: f.get('name').trim(), principal: parseAmount(f.get('principal')),
      monthlyRepayment: parseAmount(f.get('monthlyRepayment')), repaymentAccountId: f.get('repaymentAccountId'),
      totalPaid:0, interestPaid:0, payments:[], closed:false,
    });
    scheduleSave(); closeModal(); render();
    toast('Liability added','success');
  };
}

function renderLiabilityDetail(id){
  const l = state.liabilities.find(x=>x.id===id);
  if(!l) return renderLiabilitiesList();
  const acc = getAccount(l.repaymentAccountId);
  const remaining = Math.max(0, l.principal - l.totalPaid);
  const pct = l.principal>0 ? Math.min(100,(l.totalPaid/l.principal)*100) : 0;
  const payments = l.payments.slice().sort((a,b)=>b.date.localeCompare(a.date));

  const body = `
    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:14px;">
        <div>
          <div class="acct-name" style="font-size:19px;">${escapeHtml(l.name)}</div>
          <div class="acct-meta">Repaid from ${acc?escapeHtml(acc.name):'—'} · ${fmtMoney(l.monthlyRepayment)} / month</div>
        </div>
        <div style="display:flex;gap:8px;">
          ${!l.closed?`<button class="btn primary sm" data-action="logPayment" data-id="${l.id}">+ Log payment</button>`:''}
          ${!l.closed?`<button class="btn ghost sm" data-action="closeLiabilityConfirm" data-id="${l.id}">Close out</button>`:''}
        </div>
      </div>
      <div style="display:flex;gap:32px;flex-wrap:wrap;margin-top:18px;">
        <div><div class="stat-label">Remaining</div><div class="acct-balance">${fmtMoney(remaining)}</div></div>
        <div><div class="stat-label">Paid so far</div><div class="acct-balance" style="font-size:17px;color:var(--text-dim);">${fmtMoney(l.totalPaid)}</div></div>
        <div><div class="stat-label">Original amount</div><div class="acct-balance" style="font-size:17px;color:var(--text-dim);">${fmtMoney(l.principal)}</div></div>
        ${l.closed?`<div><div class="stat-label">Interest paid</div><div class="acct-balance" style="font-size:17px;color:var(--amber);">${fmtMoney(l.interestPaid)}</div></div>`:''}
      </div>
      <div class="progress" style="margin-top:16px;"><div style="width:${pct}%"></div></div>
      ${l.closed?`<div style="margin-top:12px;"><span class="badge green">Paid off in full</span></div>`:''}
    </div>
    <div class="card">
      <div class="section-title" style="margin-bottom:12px;">Payment history</div>
      ${payments.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Amount</th><th>Account</th><th>Status</th><th></th></tr></thead>
        <tbody>${payments.map(p=>`
          <tr>
            <td>${fmtDate(p.date)}</td>
            <td class="amt debit">−${fmtMoney(p.amount)}</td>
            <td>${escapeHtml(getAccount(p.accountId)?.name||'—')}</td>
            <td>${p.matched?'<span class="badge green">matched</span>':'<span class="badge amber">pending</span>'}</td>
            <td>${!p.matched?`<button class="btn ghost sm" data-action="linkPayment" data-id="${l.id}" data-p="${p.id}">Link…</button>`:''}</td>
          </tr>`).join('')}</tbody>
      </table></div>` : `<div class="empty"><div class="t">No payments logged yet</div></div>`}
    </div>
  `;
  return renderPage(
    `<span data-action="backToLiabilities" style="cursor:pointer;color:var(--text-faint);">Liabilities</span> <span class="faint">/</span> ${escapeHtml(l.name)}`,
    '', '', body
  );
}

function openLogPaymentModal(liabId){
  const l = state.liabilities.find(x=>x.id===liabId);
  openModal(`
    <div class="modal-head"><div class="modal-title">Log a payment</div><span class="x-close" data-action="closeModal">✕</span></div>
    <form id="log-payment-form">
      <div class="row">
        <div class="field"><label>Date</label><input type="date" name="date" value="${todayIso()}" required></div>
        <div class="field"><label>Amount</label><input type="number" step="0.01" name="amount" value="${l.monthlyRepayment}" required></div>
      </div>
      <div class="field"><label>Paid from</label>
        <select name="accountId">${state.accounts.filter(a=>!a.closed).map(a=>`<option value="${a.id}" ${a.id===l.repaymentAccountId?'selected':''}>${escapeHtml(a.name)}</option>`).join('')}</select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-action="closeModal">Cancel</button>
        <button type="submit" class="btn primary">Log payment</button>
      </div>
    </form>
  `);
  document.getElementById('log-payment-form').onsubmit = (e)=>{
    e.preventDefault();
    const f = new FormData(e.target);
    const date = f.get('date'), amount = parseAmount(f.get('amount')), accountId = f.get('accountId');
    const acc = getAccount(accountId);
    const linkedTxIds = new Set(l.payments.filter(p=>p.txId).map(p=>p.txId));
    const match = acc.transactions.find(t => !linkedTxIds.has(t.id) && t.debit>0 &&
      Math.abs(t.debit-amount)<0.005 && daysBetween(t.date,date)<=5);
    const payment = { id: uid('pay'), date, amount, accountId, txId: match?match.id:null, matched: !!match };
    l.payments.push(payment);
    l.totalPaid += amount;
    if(l.totalPaid > l.principal) l.interestPaid = l.totalPaid - l.principal;
    scheduleSave(); closeModal(); render();
    toast(match?'Payment logged and matched to your statement':'Payment logged — not yet matched to a statement row','success');
  };
}

function openLinkPaymentModal(liabId, payId){
  const l = state.liabilities.find(x=>x.id===liabId); const p = l.payments.find(x=>x.id===payId);
  const acc = getAccount(p.accountId);
  const linkedTxIds = new Set(l.payments.filter(pp=>pp.txId && pp.id!==p.id).map(pp=>pp.txId));
  const candidates = liveTx(acc).filter(t=> !linkedTxIds.has(t.id) && t.debit>0 && daysBetween(t.date,p.date)<=10)
    .sort((a,b)=>Math.abs(a.debit-p.amount)-Math.abs(b.debit-p.amount)).slice(0,8);
  openModal(`
    <div class="modal-head"><div class="modal-title">Link payment to a statement row</div><span class="x-close" data-action="closeModal">✕</span></div>
    <div class="faint" style="font-size:12px;margin-bottom:12px;">Looking near ${fmtDate(p.date)} for ${fmtMoney(p.amount)}. Amounts can differ slightly due to holds or exchange rates.</div>
    ${candidates.length ? candidates.map(t=>`
      <div class="settings-item" style="margin-bottom:7px;">
        <div><div style="font-size:13px;">${escapeHtml(txDisplayDescription(t))}</div><div class="faint" style="font-size:11px;">${fmtDate(t.date)}</div></div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="num" style="font-size:13px;">${fmtMoney(t.debit)}</span>
          <button class="btn sm" data-action="doLinkPayment" data-liab="${liabId}" data-p="${payId}" data-tx="${t.id}">Link</button>
        </div>
      </div>`).join('') : `<div class="faint">No close matches found in that account yet — try importing the statement first.</div>`}
  `, {wide:true});
}

function closeLiability(id){
  const l = state.liabilities.find(x=>x.id===id);
  l.closed = true;
  l.interestPaid = Math.max(0, l.totalPaid - l.principal);
  scheduleSave(); render();
  toast('Liability closed out — nicely done','success');
}

ACTIONS.newLiability = openNewLiabilityModal;
ACTIONS.openLiability = (t)=> go('liabilities',{id:t.dataset.id});
ACTIONS.backToLiabilities = ()=> go('liabilities');
ACTIONS.logPayment = (t)=> openLogPaymentModal(t.dataset.id);
ACTIONS.linkPayment = (t)=> openLinkPaymentModal(t.dataset.id, t.dataset.p);
ACTIONS.doLinkPayment = (t)=>{
  const l = state.liabilities.find(x=>x.id===t.dataset.liab); const p = l.payments.find(x=>x.id===t.dataset.p);
  p.txId = t.dataset.tx; p.matched = true;
  scheduleSave(); closeModal(); render(); toast('Linked','success');
};
ACTIONS.closeLiabilityConfirm = (t)=>{
  const id = t.dataset.id;
  confirmDialog('Close this liability?','If you have paid more than the original amount, the difference will be recorded as interest paid.',()=>closeLiability(id),'Close out');
};
/* =========================================================
   Part 9: Yearly Flow (Sankey)
   ========================================================= */
var flowYear = new Date().getFullYear();
const FLOW_PALETTE = ['#000080','#800080','#008080','#808000','#800000','#0000ff','#ff00ff','#808080'];

function yearsWithData(){
  const set = new Set();
  for(const acc of state.accounts) for(const tx of liveTx(acc)) set.add(Number(tx.date.slice(0,4)));
  set.add(new Date().getFullYear());
  return [...set].sort((a,b)=>b-a);
}

function computeYearFlow(year){
  const cats = {};
  let income = 0;
  for(const acc of state.accounts){
    for(const tx of liveTx(acc)){
      if(Number(tx.date.slice(0,4)) !== year) continue;
      if(tx.credit && tx.isIncome) income += convertToMVR(tx.credit, acc.currency) || 0;
      if(tx.debit){
        const mvr = convertToMVR(tx.debit, acc.currency) || 0;
        const g = tx.tagGroupId ? state.tagGroups.find(x=>x.id===tx.tagGroupId) : null;
        const key = g ? g.id : '__untagged__';
        if(!cats[key]) cats[key] = { name: g?g.name:'Untagged', savings: g?!!g.savings:false, amount:0 };
        cats[key].amount += mvr;
      }
    }
  }
  return { income, categories: Object.values(cats).filter(c=>c.amount>0.005) };
}

function renderFlow(){
  const { income, categories } = computeYearFlow(flowYear);
  categories.sort((a,b)=> (b.savings-a.savings) || (b.amount-a.amount));
  const totalOut = categories.reduce((s,c)=>s+c.amount,0);
  const leftover = income - totalOut;

  const body = income<=0 && !categories.length ? `
    <div class="empty"><div class="t">No flow to show for ${flowYear}</div>
    <div style="font-size:12.5px;">Mark some credit transactions as income, and tag your spending, to see the year come together here.</div></div>
  ` : `
    <div class="card sankey-wrap">
      ${sankeySvg(income, categories, leftover)}
    </div>
    <div class="grid grid-3" style="margin-top:16px;">
      <div class="card card-tight"><div class="stat-label">Income</div><div class="stat-value" style="font-size:19px;">${fmtMoney(income)}</div></div>
      <div class="card card-tight"><div class="stat-label">Savings</div><div class="stat-value" style="font-size:19px;color:var(--green);">${fmtMoney(categories.filter(c=>c.savings).reduce((s,c)=>s+c.amount,0))}</div></div>
      <div class="card card-tight"><div class="stat-label">Spent</div><div class="stat-value" style="font-size:19px;">${fmtMoney(categories.filter(c=>!c.savings).reduce((s,c)=>s+c.amount,0))}</div></div>
    </div>
  `;

  return renderPage('Yearly Flow', 'Where a year of income actually went.', `
    <select id="flow-year-select" style="width:auto;">${yearsWithData().map(y=>`<option value="${y}" ${y===flowYear?'selected':''}>${y}</option>`).join('')}</select>
  `, body);
}

function sankeySvg(income, categories, leftover){
  const W = 760, H = 440, pad = 20;
  const nodeW = 18;
  const leftX = pad, rightX = W - pad - nodeW;
  const denom = Math.max(income, categories.reduce((s,c)=>s+c.amount,0), 1);
  const usableH = H - pad*2;
  const incomeH = Math.max(6, (income/denom) * usableH);
  const incomeY = pad + (usableH - incomeH)/2;

  let nodes = categories.map(c => ({ ...c, h: Math.max(6, (c.amount/denom)*usableH) }));
  if(leftover > 0.01) nodes.push({ name:'Left over', amount:leftover, savings:false, leftover:true, h: Math.max(6,(leftover/denom)*usableH) });

  const totalNodesH = nodes.reduce((s,n)=>s+n.h,0) + (nodes.length-1)*10;
  let cursorY = pad + (usableH - totalNodesH)/2;

  let colorI = 0;
  const ribbons = [];
  const nodeRects = [];
  const labels = [];
  let incomeCursor = incomeY;

  for(const n of nodes){
    const color = n.leftover ? '#808080' : n.savings ? '#008000' : FLOW_PALETTE[(colorI++) % FLOW_PALETTE.length];
    const y0 = cursorY, y1 = cursorY + n.h;
    const srcY0 = incomeCursor, srcY1 = incomeCursor + n.h;
    incomeCursor += n.h;

    const midX = (leftX+nodeW + rightX)/2;
    ribbons.push(`<path d="M ${leftX+nodeW} ${srcY0} C ${midX} ${srcY0}, ${midX} ${y0}, ${rightX} ${y0}
      L ${rightX} ${y1} C ${midX} ${y1}, ${midX} ${srcY1}, ${leftX+nodeW} ${srcY1} Z"
      fill="${color}" opacity="0.4" stroke="${color}" stroke-width="0.5"/>`);

    nodeRects.push(`<rect x="${rightX}" y="${y0}" width="${nodeW}" height="${n.h}" fill="${color}" stroke="#000" stroke-width="1"/>`);
    labels.push(`<text x="${rightX+nodeW+10}" y="${(y0+y1)/2+4}" fill="#000000" font-size="12" font-family="Tahoma">${escapeHtml(n.name)}</text>
      <text x="${rightX+nodeW+10}" y="${(y0+y1)/2+19}" fill="#3a3a3a" font-size="11" font-family='Consolas'>${fmtMoney(n.amount)}</text>`);
    cursorY += n.h + 10;
  }

  return `<svg viewBox="0 0 ${W+150} ${H}" style="width:100%;min-width:640px;height:auto;background:#d4d0c8;">
    ${ribbons.join('')}
    <rect x="${leftX}" y="${incomeY}" width="${nodeW}" height="${incomeH}" fill="#000080" stroke="#000" stroke-width="1"/>
    <text x="${leftX-8}" y="${incomeY-10}" fill="#000000" font-size="12.5" font-weight="700" font-family="Tahoma">Income</text>
    <text x="${leftX-8}" y="${incomeY+incomeH+18}" fill="#3a3a3a" font-size="11" font-family="Consolas">${fmtMoney(income)}</text>
    ${nodeRects.join('')}
    ${labels.join('')}
  </svg>`;
}

AFTER_RENDER_HOOKS.flow = function(){
  const sel = document.getElementById('flow-year-select');
  if(sel) sel.onchange = ()=>{ flowYear = Number(sel.value); render(); };
};
/* =========================================================
   Part 10: Settings
   ========================================================= */
function renderSettings(){
  const sinking = state.accounts.filter(a=>a.isSinking);
  const body = `
    <div class="grid grid-2" style="align-items:start;">
      <div class="card" style="margin-bottom:16px;">
        <div class="section-title" style="margin-bottom:14px;">Budget & currency</div>
        <div class="field"><label>Monthly budget (MVR)</label>
          <input type="number" step="0.01" id="set-budget" value="${state.settings.monthlyBudget||''}" placeholder="0">
        </div>
        <div class="field"><label>1 USD = ? MVR</label>
          <input type="number" step="0.01" id="set-usd-rate" value="${state.settings.exchangeRates.USD}">
        </div>
        <div class="field"><label>1 EUR = ? MVR</label>
          <input type="text" value="not set up yet" disabled style="color:var(--text-faint);">
        </div>
        <div class="field"><label>Transaction codes counted as income</label>
          <input type="text" id="set-income-codes" value="${escapeHtml(state.settings.incomeCodes.join(', '))}">
          <div class="hint">Comma-separated, e.g. salary, bonus. You can still flag individual transactions on their statement row.</div>
        </div>
        <button class="btn primary sm" id="save-settings-btn">Save</button>
      </div>

      <div class="card" style="margin-bottom:16px;">
        <div class="section-title" style="margin-bottom:14px;">Account types</div>
        <div class="settings-list" id="acct-types-list">
          ${state.settings.accountTypes.map(t=>`
            <div class="settings-item">
              <span>${escapeHtml(t)}</span>
              <span class="x-close" data-action="deleteAccountType" data-type="${escapeHtml(t)}">✕</span>
            </div>`).join('')}
        </div>
        <div class="row" style="margin-top:10px;">
          <input type="text" id="new-type-input" placeholder="New type name">
          <button class="btn sm" data-action="addAccountType">Add</button>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div class="section-head"><div class="section-title">Tags</div></div>
      ${state.tagGroups.map(tagSettingsBlockHtml).join('')}
      <div class="row" style="margin-top:6px;">
        <input type="text" id="new-tag-group-input" placeholder="New tag group, e.g. Groceries">
        <button class="btn sm" data-action="addTagGroupSettings">Add group</button>
      </div>
    </div>

    ${githubSettingsCardHtml()}

    <div class="card" style="margin-bottom:16px;">
      <div class="section-head">
        <div class="section-title">Sinking funds</div>
        <button class="btn ghost sm" data-action="newAccountSinking">+ New sinking fund</button>
      </div>
      ${sinking.length ? sinking.map(a=>`
        <div class="settings-item" style="margin-bottom:8px;">
          <div><div style="font-weight:600;">${escapeHtml(a.name)}</div><div class="faint" style="font-size:11.5px;">${a.currency} · ${fmtMoney(unassignedBalance(a))}</div></div>
          <button class="btn sm" data-action="openAccount" data-id="${a.id}">Open</button>
        </div>`).join('') : `<div class="faint" style="font-size:12.5px;">None yet — these are hidden from the main Accounts screen on purpose.</div>`}
    </div>

    <div class="card">
      <div class="section-title" style="margin-bottom:12px;">Your data</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn sm" data-action="exportData">⇩ Export backup (.json)</button>
        <label class="btn sm" style="cursor:pointer;">⇧ Import backup<input type="file" id="import-data-file" accept="application/json" style="display:none;"></label>
        <button class="btn danger sm" data-action="resetAllConfirm">Reset all data</button>
      </div>
      <div class="hint" style="margin-top:10px;">Everything is saved automatically as you go. Export a backup occasionally for safekeeping.</div>
    </div>
  `;
  return renderPage('Settings','Account types, tags, exchange rates, and your data.', '', body);
}

function tagSettingsBlockHtml(g){
  return `
    <div class="tag-group-block">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <input type="text" class="tag-group-name" data-group="${g.id}" value="${escapeHtml(g.name)}" style="font-weight:700;width:auto;flex:1;min-width:120px;">
        <label class="checkline"><input type="checkbox" class="tag-group-savings" data-group="${g.id}" ${g.savings?'checked':''}> Savings category</label>
        <label class="checkline"><input type="checkbox" class="tag-group-exclude" data-group="${g.id}" ${g.excludeFromSpending?'checked':''}> Exclude from spending</label>
        <span class="x-close" data-action="deleteTagGroup" data-group="${g.id}">✕ delete group</span>
      </div>
      <div style="margin-top:10px;">
        ${g.entries.map(e=>`
          <div class="tag-entry-row">
            <input type="text" class="tag-entry-name" data-group="${g.id}" data-entry="${e.id}" value="${escapeHtml(e.name)}" style="width:140px;flex:none;">
            <input type="text" class="tag-entry-matches" data-group="${g.id}" data-entry="${e.id}" value="${escapeHtml((e.matches||[]).join(', '))}" placeholder="match keywords, comma-separated" style="flex:1;">
            <span class="x-close" data-action="deleteTagEntry" data-group="${g.id}" data-entry="${e.id}">✕</span>
          </div>`).join('')}
      </div>
      <div class="row" style="margin-top:8px;">
        <input type="text" class="new-tag-entry-input" data-group="${g.id}" placeholder="+ add a place / entry">
        <button class="btn sm" data-action="addTagEntrySettings" data-group="${g.id}">Add</button>
      </div>
    </div>
  `;
}

function githubSettingsCardHtml(){
  const cfg = loadGithubConfig() || {};
  let status;
  if(githubLastSync) status = githubLastSync.ok
    ? `Last synced ${new Date(githubLastSync.time).toLocaleString()}`
    : `Last attempt failed — ${escapeHtml(githubLastSync.message||'unknown error')}`;
  else status = cfg.token ? 'Saved, not yet synced this session' : 'Not connected';

  return `
    <div class="card" style="margin-bottom:16px;">
      <div class="section-title" style="margin-bottom:6px;">Cloud sync — private GitHub repo</div>
      <div class="hint" style="margin-bottom:12px;line-height:1.5;">
        Optionally push your data to a private repo you own, so it isn't stuck on one device.
        The token below is saved only in <b>this browser's</b> local storage — it is never written into
        the files you publish to GitHub Pages. Use a <b>fine-grained</b> personal access token scoped to just
        this one repository, with "Contents: Read and write" permission, and an expiry date.
      </div>
      <div class="row">
        <div class="field"><label>GitHub username</label><input type="text" id="gh-owner" value="${escapeHtml(cfg.owner||'')}" placeholder="e.g. shaiman"></div>
        <div class="field"><label>Repository (private)</label><input type="text" id="gh-repo" value="${escapeHtml(cfg.repo||'')}" placeholder="e.g. orbita-data"></div>
      </div>
      <div class="row">
        <div class="field"><label>File path in repo</label><input type="text" id="gh-path" value="${escapeHtml(cfg.path||'orbita-data.json')}"></div>
        <div class="field"><label>Personal access token</label><input type="password" id="gh-token" value="${escapeHtml(cfg.token||'')}" placeholder="github_pat_…"></div>
      </div>
      <label class="checkline" style="margin-bottom:12px;"><input type="checkbox" id="gh-autosync" ${cfg.autoSync?'checked':''}> Sync automatically after every change</label>
      <div class="sync-status"><span class="sync-dot ${githubLastSync?(githubLastSync.ok?'on':'err'):''}"></span>${escapeHtml(status)}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
        <button class="btn sm" data-action="ghSaveConfig">Save</button>
        <button class="btn sm" data-action="ghTest">Test connection</button>
        <button class="btn primary sm" data-action="ghSyncNow">Sync now</button>
        ${cfg.token?`<button class="btn danger sm" data-action="ghDisconnect">Disconnect</button>`:''}
      </div>
    </div>
  `;
}

ACTIONS.ghSaveConfig = ()=>{
  const cfg = {
    owner: document.getElementById('gh-owner').value.trim(),
    repo: document.getElementById('gh-repo').value.trim(),
    path: document.getElementById('gh-path').value.trim() || 'orbita-data.json',
    token: document.getElementById('gh-token').value.trim(),
    autoSync: document.getElementById('gh-autosync').checked,
  };
  if(!cfg.owner || !cfg.repo || !cfg.token){ toast('Fill in username, repo, and token first','error'); return; }
  saveGithubConfig(cfg);
  toast('GitHub settings saved to this browser','success');
  render();
};
ACTIONS.ghTest = async ()=>{
  const cfg = loadGithubConfig();
  if(!cfg){ toast('Save your GitHub settings first','error'); return; }
  try{
    const r = await githubTestConnection(cfg);
    githubLastSync = { ok:true, time:new Date().toISOString() };
    toast(r.exists ? 'Connected — found an existing data file' : 'Connected — no data file yet, one will be created on first sync', 'success');
  }catch(e){
    githubLastSync = { ok:false, time:new Date().toISOString(), message:e.message };
    toast('Connection failed: '+e.message, 'error');
  }
  render();
};
ACTIONS.ghSyncNow = async ()=>{
  const cfg = loadGithubConfig();
  if(!cfg){ toast('Save your GitHub settings first','error'); return; }
  try{
    await githubSaveState(cfg);
    githubLastSync = { ok:true, time:new Date().toISOString() };
    toast('Synced to GitHub','success');
  }catch(e){
    githubLastSync = { ok:false, time:new Date().toISOString(), message:e.message };
    toast('Sync failed: '+e.message, 'error');
  }
  render();
};
ACTIONS.ghDisconnect = ()=>{
  confirmDialog('Disconnect GitHub sync?','Your data stays in this browser either way — this only removes the saved token.',()=>{
    clearGithubConfig(); githubLastSync=null; toast('Disconnected','success'); render();
  }, 'Disconnect', true);
};

/* ---------------- wiring ---------------- */
AFTER_RENDER_HOOKS.settings = function(){
  const btn = document.getElementById('save-settings-btn');
  if(btn) btn.onclick = ()=>{
    state.settings.monthlyBudget = parseAmount(document.getElementById('set-budget').value);
    state.settings.exchangeRates.USD = parseAmount(document.getElementById('set-usd-rate').value) || state.settings.exchangeRates.USD;
    state.settings.incomeCodes = document.getElementById('set-income-codes').value.split(',').map(s=>s.trim()).filter(Boolean);
    scheduleSave(); toast('Settings saved','success'); render();
  };
  document.querySelectorAll('.tag-group-name').forEach(inp=>inp.addEventListener('change',()=>{
    const g = state.tagGroups.find(x=>x.id===inp.dataset.group); g.name = inp.value.trim()||g.name; scheduleSave();
  }));
  document.querySelectorAll('.tag-group-savings').forEach(inp=>inp.addEventListener('change',()=>{
    const g = state.tagGroups.find(x=>x.id===inp.dataset.group); g.savings = inp.checked; scheduleSave();
  }));
  document.querySelectorAll('.tag-group-exclude').forEach(inp=>inp.addEventListener('change',()=>{
    const g = state.tagGroups.find(x=>x.id===inp.dataset.group); g.excludeFromSpending = inp.checked; scheduleSave();
  }));
  document.querySelectorAll('.tag-entry-name').forEach(inp=>inp.addEventListener('change',()=>{
    const g = state.tagGroups.find(x=>x.id===inp.dataset.group); const e = g.entries.find(x=>x.id===inp.dataset.entry);
    e.name = inp.value.trim()||e.name; scheduleSave();
  }));
  document.querySelectorAll('.tag-entry-matches').forEach(inp=>inp.addEventListener('change',()=>{
    const g = state.tagGroups.find(x=>x.id===inp.dataset.group); const e = g.entries.find(x=>x.id===inp.dataset.entry);
    e.matches = inp.value.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean); scheduleSave();
  }));
  const importFile = document.getElementById('import-data-file');
  if(importFile) importFile.addEventListener('change', handleImportBackup);
};

ACTIONS.addAccountType = ()=>{
  const inp = document.getElementById('new-type-input'); const v = inp.value.trim();
  if(!v || state.settings.accountTypes.includes(v)) return;
  state.settings.accountTypes.push(v); scheduleSave(); render();
};
ACTIONS.deleteAccountType = (t)=>{
  const type = t.dataset.type;
  if(state.accounts.some(a=>a.type===type)){ toast('Some accounts still use this type','error'); return; }
  state.settings.accountTypes = state.settings.accountTypes.filter(x=>x!==type); scheduleSave(); render();
};
ACTIONS.addTagGroupSettings = ()=>{
  const inp = document.getElementById('new-tag-group-input'); const v = inp.value.trim();
  if(!v) return;
  state.tagGroups.push({ id: uid('tg'), name:v, savings:false, entries:[] }); scheduleSave(); render();
};
ACTIONS.deleteTagGroup = (t)=>{
  const id = t.dataset.group;
  confirmDialog('Delete this tag group?','Transactions tagged with it will become untagged.',()=>{
    state.tagGroups = state.tagGroups.filter(g=>g.id!==id);
    state.accounts.forEach(a=>a.transactions.forEach(tx=>{ if(tx.tagGroupId===id){ tx.tagGroupId=null; tx.tagEntryId=null; } }));
    scheduleSave(); render();
  }, 'Delete', true);
};
ACTIONS.deleteTagEntry = (t)=>{
  const g = state.tagGroups.find(x=>x.id===t.dataset.group);
  g.entries = g.entries.filter(e=>e.id!==t.dataset.entry);
  state.accounts.forEach(a=>a.transactions.forEach(tx=>{ if(tx.tagEntryId===t.dataset.entry){ tx.tagGroupId=null; tx.tagEntryId=null; } }));
  scheduleSave(); render();
};
ACTIONS.addTagEntrySettings = (t)=>{
  const wrap = t.closest('.tag-group-block');
  const inp = wrap.querySelector('.new-tag-entry-input'); const v = inp.value.trim();
  if(!v) return;
  const g = state.tagGroups.find(x=>x.id===t.dataset.group);
  g.entries.push({ id: uid('te'), name:v, matches:[] });
  scheduleSave(); render();
};
ACTIONS.newAccountSinking = ()=>{
  openNewAccountModal();
  setTimeout(()=>{ const cb = document.querySelector('#new-acct-form [name=isSinking]'); if(cb) cb.checked = true; }, 10);
};

function exportData(){
  const blob = new Blob([JSON.stringify(state, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `orbita-backup-${todayIso()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
  toast('Backup downloaded','success');
}
function handleImportBackup(e){
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const parsed = JSON.parse(reader.result);
      confirmDialog('Replace all data?','This will overwrite everything currently in Orbita with the contents of this backup file.',()=>{
        state = Object.assign(defaultState(), parsed);
        scheduleSave(); render(); toast('Backup restored','success');
      }, 'Restore backup', true);
    }catch(err){ toast('That file could not be read','error'); }
  };
  reader.readAsText(file);
}
ACTIONS.exportData = exportData;
ACTIONS.resetAllConfirm = ()=>{
  confirmDialog('Reset everything?','This deletes all accounts, transactions, liabilities and tags. This cannot be undone — export a backup first if you want one.',()=>{
    state = defaultState(); scheduleSave(); go('dashboard'); toast('Orbita has been reset','success');
  }, 'Reset everything', true);
};
/* =========================================================
   Part 11: Win98 window chrome
   ========================================================= */
function startClock(){
  const el = document.getElementById('taskbar-clock');
  function tick(){
    const d = new Date();
    let h = d.getHours(); const ampm = h>=12?'PM':'AM'; h = h%12 || 12;
    el.textContent = `${h}:${String(d.getMinutes()).padStart(2,'0')} ${ampm}`;
  }
  tick();
  setInterval(tick, 15000);
}

function updateTaskbarLabel(){
  const label = document.getElementById('taskbar-view-label');
  if(!label) return;
  const nav = NAV_ITEMS.find(n => n.key === route.view);
  label.textContent = nav ? nav.label : 'Orbita';
}
// wrap the existing render() so every navigation keeps the taskbar label in sync
var _baseRender = render;
render = function(){ _baseRender(); updateTaskbarLabel(); };

ACTIONS.toggleStartMenu = ()=>{
  document.getElementById('start-menu').classList.toggle('hidden');
  document.getElementById('start-btn').classList.toggle('pressed');
};
ACTIONS.startNav = (t)=>{
  document.getElementById('start-menu').classList.add('hidden');
  document.getElementById('start-btn').classList.remove('pressed');
  go(t.dataset.view);
};
ACTIONS.menuNoop = ()=>{};
ACTIONS.menuHelp = ()=>{
  openModal(`
    <div class="modal-head"><div class="modal-title">About Orbita</div><span class="x-close" data-action="closeModal">✕</span></div>
    <div style="padding:14px 0 20px;font-size:12.5px;line-height:1.6;">
      Orbita — personal finance, 98-style.<br><br>
      Data saves to this browser automatically, and optionally to a private GitHub
      repository you connect from Settings.
    </div>
  `);
};

ACTIONS.winMinimize = ()=>{
  document.getElementById('win-window').classList.add('minimized');
  document.querySelector('.taskbar-task').classList.remove('active');
};
ACTIONS.restoreWindow = ()=>{
  document.getElementById('win-window').classList.remove('minimized');
  document.querySelector('.taskbar-task').classList.add('active');
  document.getElementById('start-menu').classList.add('hidden');
};
ACTIONS.winMaximize = ()=>{
  document.getElementById('win-window').classList.toggle('maximized');
};
ACTIONS.winClose = ()=>{
  confirmDialog('Log off Shaiman?', 'Orbita will close. Your data is already saved — you\u2019ll just need your password again next time.', logOff, 'Log Off');
};
ACTIONS.logOff = ()=>{
  document.getElementById('start-menu').classList.add('hidden');
  confirmDialog('Log off Shaiman?', 'You can log back in any time — nothing is lost.', logOff, 'Log Off');
};
ACTIONS.shutDown = ()=>{
  document.getElementById('start-menu').classList.add('hidden');
  confirmDialog('Shut down Orbita?', 'This just closes the app view — your data stays saved on this device.', ()=>{
    document.getElementById('desktop').classList.add('hidden');
    document.getElementById('shutdown-screen').classList.remove('hidden');
  }, 'Shut Down');
};
ACTIONS.restartOrbita = ()=> location.reload();

ACTIONS.openRecycleBin = ()=>{
  document.getElementById('start-menu').classList.add('hidden');
  go('accounts');
  showClosedAccounts = true;
  render();
  toast('Showing closed accounts', 'success');
};

/* =========================================================
   Final boot trigger — runs after every module above has
   executed its top-level var/const initializers.
   ========================================================= */
initAuth();
