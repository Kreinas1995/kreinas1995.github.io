// ==UserScript==
// @name         Torn BJ Advisor — Perfect Strategy (+0.37% edge)
// @namespace    https://www.torn.com/
// @version      5.0
// @description  Perfect strategy, goal mode, hand odds, session tracking. Built into Torn BJ page.
// @author       BJ Advisor
// @match        https://www.torn.com/page.php?sid=blackjack*
// @match        https://www.torn.com/loader.php?sid=blackjack*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  function waitFor(sel, cb, retries=40) {
    const el = document.querySelector(sel);
    if (el) { cb(el); return; }
    if (retries > 0) setTimeout(() => waitFor(sel, cb, retries-1), 300);
  }

  // ── Strategy tables ────────────────────────────────────────────────────────
  // Torn: 8 decks, dealer stands soft 17, EARLY surrender, 6-card Charlie, 3:2
  const HARD = {
     4:['H','H','H','H','H','H','H','H','H','H'],
     5:['H','H','H','H','H','H','H','H','E','E'],
     6:['H','H','H','H','H','H','H','H','E','E'],
     7:['H','H','H','H','H','H','H','H','E','E'],
     8:['H','H','H','H','H','H','H','H','H','H'],
     9:['H','D','D','D','D','H','H','H','H','H'],
    10:['D','D','D','D','D','D','D','D','H','H'],
    11:['D','D','D','D','D','D','D','D','D','H'],
    12:['H','H','S','S','S','H','H','H','H','H'],
    13:['S','S','S','S','S','H','H','H','H','H'],
    14:['S','S','S','S','S','H','H','H','E','E'],
    15:['S','S','S','S','S','H','H','H','E','E'],
    16:['S','S','S','S','S','H','H','E','E','E'],
    17:['S','S','S','S','S','S','S','S','S','E'],
    18:['S','S','S','S','S','S','S','S','S','S'],
    19:['S','S','S','S','S','S','S','S','S','S'],
    20:['S','S','S','S','S','S','S','S','S','S'],
    21:['S','S','S','S','S','S','S','S','S','S'],
  };
  const SOFT = {
    13:['H','H','H','D','D','H','H','H','H','H'],
    14:['H','H','H','D','D','H','H','H','H','H'],
    15:['H','H','D','D','D','H','H','H','H','H'],
    16:['H','H','D','D','D','H','H','H','H','H'],
    17:['H','D','D','D','D','H','H','H','H','H'],
    18:['S','D','D','D','D','S','S','H','H','H'],
    19:['S','S','S','S','S','S','S','S','S','S'],
    20:['S','S','S','S','S','S','S','S','S','S'],
  };
  const PAIRS = {
     2:['P','P','P','P','P','P','H','H','H','H'],
     3:['P','P','P','P','P','P','H','H','H','H'],
     4:['H','H','H','P','P','H','H','H','H','H'],
     5:['D','D','D','D','D','D','D','D','H','H'],
     6:['P','P','P','P','P','H','H','H','H','H'],
     7:['P','P','P','P','P','P','H','H','H','H'],
     8:['P','P','P','P','P','P','P','P','P','E'],
     9:['P','P','P','P','P','S','P','P','S','S'],
    10:['S','S','S','S','S','S','S','S','S','S'],
    11:['P','P','P','P','P','P','P','P','P','P'],
  };
  const SURR_PAIRS_ACE = new Set([3,6,7]);
  const DI = {2:0,3:1,4:2,5:3,6:4,7:5,8:6,9:7,10:8,11:9};
  const ACT = {
    H: {t:'HIT',           c:'#f97316', bg:'rgba(249,115,22,0.15)'},
    S: {t:'STAND',         c:'#22c55e', bg:'rgba(34,197,94,0.15)'},
    D: {t:'DOUBLE DOWN',   c:'#a855f7', bg:'rgba(168,85,247,0.15)'},
    P: {t:'SPLIT',         c:'#3b82f6', bg:'rgba(59,130,246,0.15)'},
    E: {t:'EARLY SURRENDER',c:'#ef4444',bg:'rgba(239,68,68,0.15)'},
    INS:{t:'DECLINE INSURANCE',c:'#ef4444',bg:'rgba(239,68,68,0.15)'},
    BJ: {t:'BLACKJACK!',c:'#fbbf24', bg:'rgba(251,191,36,0.15)'},
    C:  {t:'6-CARD CHARLIE!',c:'#fbbf24',bg:'rgba(251,191,36,0.15)'},
    W:  {t:'DEAL A HAND',  c:'#4a7fa5', bg:'transparent'},
  };

  // ── Card helpers ───────────────────────────────────────────────────────────
  const SUIT_MAP = {clubs:'C',diamonds:'D',hearts:'H',spades:'S'};
  const RANK_VAL = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

  function parseTornCard(el) {
    const m = (el.className||'').match(/card-(clubs|diamonds|hearts|spades)-([0-9AJQK]+)/);
    if (!m) return null;
    return { rank:m[2], suit:SUIT_MAP[m[1]]||'S', val:RANK_VAL[m[2]]||0 };
  }

  function handInfo(cards) {
    let val=0, aces=0;
    for (const c of cards) {
      val += c.val===14 ? 11 : Math.min(c.val,10);
      if (c.val===14) aces++;
    }
    while (val>21 && aces>0) { val-=10; aces--; }
    return { value:val, isSoft:aces>0&&val<=21 };
  }

  // ── Hand win probability ───────────────────────────────────────────────────
  // Approximate P(win) for player total vs dealer up using 8-deck basic strategy outcomes
  function handWinProb(playerVal, isSoft, dealerUpVal, cardCount) {
    // Simplified lookup based on expected outcomes — not full combinatorial
    // Returns {win, lose, push} probabilities
    const d = dealerUpVal;

    // Dealer bust probability by up card (8-deck, stands soft 17)
    const dealerBust = {2:0.352,3:0.374,4:0.399,5:0.423,6:0.421,
                         7:0.263,8:0.239,9:0.230,10:0.213,11:0.117};
    const db = dealerBust[d] || 0.25;

    // Very rough but reasonable approximation
    if (playerVal > 21) return {win:0, lose:1, push:0};
    if (playerVal === 21 && cardCount === 2) return {win:0.977, lose:0.008, push:0.015}; // BJ

    // P(dealer makes hand >= player) — simplified
    // Player win ≈ dealer bust + P(dealer < player when not bust)
    const pv = playerVal;
    let win, lose, push;

    if (pv >= 20) { win=0.75; lose=0.18; push=0.07; }
    else if (pv===19) { win=0.66; lose=0.28; push=0.06; }
    else if (pv===18) { win=0.54; lose=0.39; push=0.07; }
    else if (pv===17) { win=0.45; lose=0.48; push=0.07; }
    else if (pv>=13)  { win=db+0.05; lose=1-db-0.12; push=0.07; }
    else              { win=db;      lose=1-db-0.05;  push=0.05; }

    // Adjust for dealer up card
    if (d >= 7) { win -= 0.05; lose += 0.05; }
    if (d <= 6) { win += 0.03; lose -= 0.03; }
    if (d === 11) { win -= 0.08; lose += 0.08; }

    // Clamp
    win  = Math.max(0, Math.min(1, win));
    lose = Math.max(0, Math.min(1, lose));
    push = Math.max(0, Math.min(1, 1-win-lose));
    return {win, lose, push};
  }

  // ── Action logic ───────────────────────────────────────────────────────────
  function getAction(playerCards, dealerUp, canDouble, canSplit, canSurrender) {
    if (!dealerUp || !playerCards.length) return 'W';
    const dv = dealerUp.val===14 ? 11 : Math.min(dealerUp.val,10);
    const di = DI[dv] ?? DI[10];
    const {value, isSoft} = handInfo(playerCards);
    const n = playerCards.length;

    if (n>=6 && value<=21) return 'C';
    if (n===2 && value===21) return 'BJ';

    // Surrender only valid on first 2 cards
    const canSurrenderNow = canSurrender && n === 2;
    const isPair = n===2 && playerCards[0].val===playerCards[1].val;

    if (isPair && canSurrenderNow && dv===11) {
      const pv = Math.min(playerCards[0].val===14?11:playerCards[0].val,10);
      if (SURR_PAIRS_ACE.has(pv)) return 'E';
    }

    let action = 'H';
    if (isPair && canSplit) {
      const pv = playerCards[0].val===14?11:Math.min(playerCards[0].val,10);
      action = PAIRS[pv]?.[di] ?? 'H';
      if (action==='D'&&!canDouble) action='H';
      if (action==='E'&&!canSurrenderNow) action='H';
    } else if (isSoft && SOFT[value]) {
      action = SOFT[value][di];
      if (action==='D'&&!canDouble) action='H';
    } else {
      const cv = Math.min(Math.max(value,4),21);
      action = HARD[cv]?.[di] ?? (value>=17?'S':'H');
      if (action==='D'&&!canDouble) action='H';
      if (action==='E'&&!canSurrenderNow) action='H';
    }
    if (n>=4 && value<=14) action='H';
    return action;
  }

  // ── Math ───────────────────────────────────────────────────────────────────
  const EDGE=0.0037, VAR=1.3225, STD_DEV=1.15, DAILY_HANDS=100;
  let goalTarget=null;

  function normCDF(z) {
    if (z<-8) return 0; if (z>8) return 1;
    const t=1/(1+0.2316419*Math.abs(z));
    const d=0.3989423*Math.exp(-z*z/2);
    const p=d*t*(0.3193815+t*(-0.3565638+t*(1.7814779+t*(-1.8212560+t*1.3302744))));
    return z>0?1-p:p;
  }
  function pBustDay(br,bet,n=DAILY_HANDS) {
    const mu=n*EDGE*bet, sig=Math.sqrt(n)*STD_DEV*bet;
    return normCDF((-br-mu)/sig);
  }
  function pGoalDaily(br,target,bet,n=DAILY_HANDS) {
    const dmu=n*EDGE*bet, dsig=Math.sqrt(n)*STD_DEV*bet;
    const theta=2*dmu/(dsig*dsig); // positive (player has edge)
    // P(hit +target before -br | start at 0) = (1-exp(-theta*br))/(1-exp(-theta*(br+target)))
    try {
      const num=1-Math.exp(-theta*br);
      const den=1-Math.exp(-theta*(br+target));
      if(!isFinite(num)||!isFinite(den)||den===0) return 0;
      return Math.max(0,Math.min(1,num/den));
    } catch(e){return 0;}
  }
  function optimalBet(br) {
    if (!br || br <= 0) return 0;
    // For very small bankrolls, just use 5% of bankroll as a reasonable bet
    if (br < 1_000_000) return Math.max(1000, Math.round(br * 0.05 / 1000) * 1000);
    let lo=1_000, hi=Math.min(br, 100_000_000);
    for(let i=0;i<60;i++){const m=(lo+hi)/2; pBustDay(br,m)<0.05?lo=m:hi=m;}
    // Round to nearest 500K for large, 100K for medium, 10K for small
    const raw = Math.min(lo, 100_000_000);
    if (raw >= 1_000_000) return Math.max(100_000, Math.round(raw/500_000)*500_000);
    if (raw >= 100_000)   return Math.max(10_000,  Math.round(raw/100_000)*100_000);
    return Math.max(1_000, Math.round(raw/10_000)*10_000);
  }

  // ── Session ────────────────────────────────────────────────────────────────
  // ── Stats: session + lifetime via localStorage ──────────────────────────
  const LIFE_KEY = 'tbj_lifetime_v1';
  const SESS_KEY = 'tbj_session_v1';
  function todayGMT() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`;
  }
  function loadLifetime() {
    try { return JSON.parse(localStorage.getItem(LIFE_KEY)) || {wins:0,losses:0,pushes:0,profit:0,hands:0}; }
    catch(e) { return {wins:0,losses:0,pushes:0,profit:0,hands:0}; }
  }
  function saveLifetime(lt) {
    try { localStorage.setItem(LIFE_KEY, JSON.stringify(lt)); } catch(e){}
  }
  function loadSession() {
    try {
      const raw = JSON.parse(localStorage.getItem(SESS_KEY));
      if (!raw || raw._date !== todayGMT())
        return {wins:0,losses:0,pushes:0,profit:0,lastBet:0,_date:todayGMT()};
      return raw;
    } catch(e) { return {wins:0,losses:0,pushes:0,profit:0,lastBet:0,_date:todayGMT()}; }
  }
  function saveSession(s) {
    try { s._date = todayGMT(); localStorage.setItem(SESS_KEY, JSON.stringify(s)); } catch(e){}
  }
  const sess = loadSession();
  let lifetime = loadLifetime();
  let showLifetime = false;

  // ── DOM helpers ────────────────────────────────────────────────────────────
  function readCards(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll('[class*="card-"]'))
      .filter(el => {
        const cls = el.className || '';
        // Only count cards with an actual rank+suit class, not card-back or empty divs
        return /card-(clubs|diamonds|hearts|spades)-[0-9AJQK]+/.test(cls);
      })
      .map(parseTornCard)
      .filter(Boolean);
  }
  function readDealerUp() {
    const cards=Array.from(document.querySelectorAll('.dealer-cards .cards [class*="card-"]'))
      .map(parseTornCard).filter(Boolean);
    return cards[0]||null;
  }
  function isEnabled(sel) {
    const el = document.querySelector(sel);
    if (!el) return false;
    // Torn uses 'disabled' class OR greyed-out opacity, not the disabled attribute
    const cls = el.className || '';
    if (cls.includes('disabled')) return false;
    if (el.disabled) return false;
    // Check opacity — Torn dims buttons to ~0.4 when unavailable
    const opacity = parseFloat(window.getComputedStyle(el).opacity);
    if (opacity < 0.6) return false;
    return true;
  }

  // More reliable: check by button text visibility
  function getAvailableActions() {
    const allBtns = Array.from(document.querySelectorAll('.bl-btn, [data-step]'));
    const result = { canDouble: false, canSplit: false, canSurrender: false };
    for (const btn of allBtns) {
      const step = btn.getAttribute('data-step') || '';
      const cls  = btn.className || '';
      const active = !cls.includes('disabled') && !btn.disabled &&
                     parseFloat(window.getComputedStyle(btn).opacity || '1') >= 0.6;
      if (step === 'doubleDown' && active) result.canDouble   = true;
      if (step === 'split'      && active) result.canSplit    = true;
      if (step === 'surrender'  && active) result.canSurrender = true;
    }
    return result;
  }
  function getCurrentBet() {
    const t=(document.querySelector('.bj-pot')||{}).textContent||'';
    return parseInt(t.replace(/[^0-9]/g,''))||0;
  }
  function getBankroll() {
    // Torn stores money in data-money on #user-money
    const el = document.getElementById('user-money') ||
               document.querySelector('[data-money]');
    if (el) {
      const v = parseInt(el.getAttribute('data-money'));
      if (v > 0) return v;
    }
    // Fallback: parse the displayed text e.g. "$360.1M"
    const txt = (el||{}).textContent || '';
    const m = txt.match(/\$([\d.]+)([BMK]?)/);
    if (m) {
      const n = parseFloat(m[1]);
      if (m[2]==='B') return n*1e9;
      if (m[2]==='M') return n*1e6;
      if (m[2]==='K') return n*1e3;
      return n;
    }
    return null;
  }
  function fmt(n) {
    const s=n<0?'-':'', a=Math.abs(n);
    if(a>=1e9) return s+'$'+(a/1e9).toFixed(2)+'B';
    if(a>=1e6) return s+'$'+(a/1e6).toFixed(1)+'M';
    if(a>=1e3) return s+'$'+Math.round(a/1e3)+'K';
    return s+'$'+a;
  }

  // ── Build panel ────────────────────────────────────────────────────────────
  function buildPanel() {
    if (document.getElementById('torn-bj-panel')) return;
    const panel=document.createElement('div');
    panel.id='torn-bj-panel';
    panel.style.cssText=`
      font-family:'Courier New',monospace;
      background:#07101e;
      border:1px solid #1a3a5c;
      border-radius:0 0 8px 8px;
      margin-top:-2px;
    `;
    panel.innerHTML=`
      <!-- Expanded panel — above bar, opens upward -->
      <div id="tbj-expanded" style="display:none;border-bottom:1px solid #1a2e42;padding:6px 10px;">
        <div style="display:flex;gap:6px;">

          <!-- Goal Mode -->
          <div style="flex:1.2;padding:6px 8px;background:#0d1b2a;border:1px solid #1a2e42;border-radius:6px;">
            <div style="font-size:8px;color:#3b7dd8;letter-spacing:1px;margin-bottom:4px;">GOAL MODE</div>
            <div style="display:flex;gap:3px;margin-bottom:4px;">
              <input id="tbj-goal-input" type="number" placeholder="Profit target $M"
                style="flex:1;min-width:0;background:#07101e;border:1px solid #1a3a5c;
                       border-radius:3px;color:#94a3b8;font-size:9px;padding:3px 4px;
                       outline:none;font-family:monospace;">
              <button id="tbj-goal-set"
                style="background:#1a3a5c;border:none;border-radius:3px;color:#22c55e;
                       font-size:9px;padding:3px 7px;cursor:pointer;font-family:monospace;">SET</button>
            </div>
            <div id="tbj-kelly" style="font-size:9px;color:#94a3b8;line-height:1.8;">—</div>
          </div>

          <!-- Session -->
          <div style="flex:1;padding:6px 8px;background:#0d1b2a;border:1px solid #1a2e42;border-radius:6px;">
            <div style="font-size:8px;color:#4a7fa5;letter-spacing:1px;margin-bottom:3px;">SESSION ⇄ <span id="tbj-life-reset" style="color:#ef4444;cursor:pointer;font-size:7px;">RESET LIFE</span></div>
            <div id="tbj-stats" style="font-size:9px;color:#94a3b8;line-height:1.8;">—</div>
          </div>

          <!-- Martingale -->
          <div style="flex:1;padding:6px 8px;background:#0d1b2a;border:1px solid #1a2e42;border-radius:6px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
              <span style="font-size:8px;color:#4a7fa5;letter-spacing:1px;">MARTINGALE</span>
              <label style="display:flex;align-items:center;gap:3px;cursor:pointer;">
                <input type="checkbox" id="tbj-mrt-on" style="cursor:pointer;width:10px;height:10px;">
                <span style="font-size:8px;color:#4a7fa5;">ON</span>
              </label>
            </div>
            <div id="tbj-mrt" style="font-size:9px;color:#2a5070;line-height:1.8;">Toggle to activate</div>
          </div>

        </div>
      </div>

      <!-- Bottom bar: always visible, thin single line -->
      <div id="tbj-bar" style="display:flex;align-items:center;padding:3px 8px;gap:6px;cursor:pointer;height:28px;border-top:1px solid #1a2e42;">
        <span id="tbj-toggle" style="color:#4a7fa5;font-size:10px;flex-shrink:0;">▲</span>
        <div id="tbj-action" style="font-size:12px;font-weight:900;color:#22c55e;white-space:nowrap;flex-shrink:0;transition:color .15s;">— DEAL —</div>
        <div id="tbj-odds" style="font-size:9px;color:#4a7fa5;white-space:nowrap;flex-shrink:0;"></div>
        <div style="display:flex;gap:2px;flex:1;align-items:center;">
          ${[1,2,3,4,5,6].map(i=>`<div id="tbj-pip${i}" style="flex:1;height:4px;border-radius:1px;background:#1a2e42;"></div>`).join('')}
        </div>
        <div style="font-size:9px;white-space:nowrap;flex-shrink:0;color:#4a7fa5;">
          W:<span id="tbj-w" style="color:#22c55e">0</span>
          L:<span id="tbj-l" style="color:#ef4444">0</span>
          <span id="tbj-pl" style="color:#94a3b8"> $0</span>
        </div>
        <label style="display:flex;align-items:center;gap:2px;cursor:pointer;flex-shrink:0;" title="Auto-fill optimal bet">
          <input type="checkbox" id="tbj-autofill" style="cursor:pointer;width:10px;height:10px;">
          <span style="font-size:8px;color:#3b82f6;">AUTO</span>
        </label>
      </div>
      <div id="tbj-reason" style="font-size:8px;color:#4a7fa5;text-align:center;padding:1px 8px 2px;line-height:1.2;display:none;"></div>
    `;
    const bjWrap = document.querySelector('.blackjack-wrap');
    if (bjWrap && bjWrap.parentNode) {
      bjWrap.parentNode.insertBefore(panel, bjWrap.nextSibling);
    } else {
      document.body.appendChild(panel);
    }
    // Toggle expand
    let expanded=false;
    document.getElementById('tbj-bar').addEventListener('click', e=>{
      if(['tbj-goal-set','tbj-mrt-on','tbj-goal-input','tbj-autofill'].includes(e.target.id)) return;
      expanded=!expanded;
      document.getElementById('tbj-expanded').style.display=expanded?'flex':'none';
      document.getElementById('tbj-reason').style.display=expanded?'block':'none';
      document.getElementById('tbj-toggle').textContent=expanded?'▼':'▲';
    });

    // Goal set button — use event delegation so it works regardless of timing
    panel.addEventListener('click', e=>{
      if (e.target.id==='tbj-stats-label' || e.target.id==='tbj-stats-toggle' || e.target.className?.includes?.('SESSION')) {
        showLifetime = !showLifetime;
        updateStats();
        return;
      }
      if (e.target.id==='tbj-life-reset') {
        if (confirm('Reset lifetime stats?')) {
          lifetime = {wins:0,losses:0,pushes:0,profit:0,hands:0};
          saveLifetime(lifetime);
          updateStats();
        }
        return;
      }
      if (e.target.id!=='tbj-goal-set') return;
      const inp=document.getElementById('tbj-goal-input');
      if (!inp) return;
      const v=parseFloat(inp.value);
      if (!isNaN(v) && v>0) {
        goalTarget=v*1_000_000;
        updateKelly();
      }
    });
    panel.addEventListener('keydown', e=>{
      if (e.target.id==='tbj-goal-input' && e.key==='Enter') {
        document.getElementById('tbj-goal-set')?.click();
      }
    });
  }

  // ── Update functions ───────────────────────────────────────────────────────
  function updateCharlie(n) {
    for(let i=1;i<=6;i++){
      const p=document.getElementById('tbj-pip'+i);
      if(!p) continue;
      p.style.background=i<=n?(i===6?'#fbbf24':'#22c55e'):'#1a2e42';
    }
  }

  function updateKelly() {
    const el=document.getElementById('tbj-kelly');
    if (!el) return;
    const br=getBankroll();
    if (!br) { el.innerHTML='<span style="color:#2a5070">—</span>'; return; }
    const opt=optimalBet(br);
    if (!goalTarget) {
      el.innerHTML=
        `<span style="color:#4a7fa5">Safe bet:</span> <span style="color:#22c55e">${fmt(opt)}</span><br>`+
        `<span style="color:#2a5070">EV/day: ${fmt(DAILY_HANDS*EDGE*opt)}</span><br>`+
        `<span style="color:#2a5070">Enter goal target above</span>`;
      return;
    }
    const pg=pGoalDaily(br,goalTarget,opt)*100;
    const days=Math.ceil(goalTarget/(DAILY_HANDS*EDGE*opt));
    el.innerHTML=
      `<span style="color:#fbbf24">Goal: ${fmt(goalTarget)}</span><br>`+
      `<span style="color:#22c55e">Bet: ${fmt(opt)}</span><br>`+
      `P(goal): <span style="color:${pg>50?'#22c55e':'#f97316'}">${pg.toFixed(1)}%</span> `+
      `<span style="color:#2a5070">~${days}d</span><br>`+
      `EV/day: <span style="color:#3b82f6">${fmt(DAILY_HANDS*EDGE*opt)}</span>`;
  }

  function updateStats() {
    const el=document.getElementById('tbj-stats');
    const lbl=document.getElementById('tbj-stats-label');
    const data = showLifetime ? lifetime : sess;
    const total = data.wins+data.losses+data.pushes;
    const pc = data.profit>=0?'#22c55e':'#ef4444';
    if(lbl) lbl.textContent = showLifetime ? 'LIFETIME ⇄' : 'SESSION ⇄';
    const tog = document.getElementById('tbj-stats-toggle');
    if(tog) tog.textContent = showLifetime ? 'SESSION' : 'LIFETIME';
    if(el) el.innerHTML=
      `Hands: <span style="color:#94a3b8">${total}</span><br>`+
      `W/L/P: <span style="color:#22c55e">${data.wins}</span>`+
      `/<span style="color:#ef4444">${data.losses}</span>`+
      `/<span style="color:#4a7fa5">${data.pushes}</span><br>`+
      `P/L: <span style="color:${pc}">${fmt(data.profit)}</span>`;
    // Inline bar always shows session
    const w=document.getElementById('tbj-w');
    const l=document.getElementById('tbj-l');
    const pl=document.getElementById('tbj-pl');
    if(w) w.textContent=sess.wins;
    if(l) l.textContent=sess.losses;
    if(pl){pl.textContent=fmt(sess.profit);pl.style.color=sess.profit>=0?'#22c55e':'#ef4444';}
    saveSession(sess);
  }

  function updateMartingale() {
    const el=document.getElementById('tbj-mrt');
    const on=document.getElementById('tbj-mrt-on')?.checked;
    if(!el) return;
    if(!on){
      el.innerHTML=
        `<span style="color:#2a5070">Martingale does NOT</span><br>`+
        `<span style="color:#2a5070">improve your odds.</span><br>`+
        `<span style="color:#2a5070">EV same, risk higher.</span>`;
      return;
    }
    const br=getBankroll()||316_000_000;
    const base=optimalBet(br);
    const next=base*2<=100_000_000?base*2:null;
    const steps=base<100_000_000?Math.floor(Math.log2(100_000_000/base)):0;
    el.innerHTML=
      `Base: <span style="color:#f97316">${fmt(base)}</span><br>`+
      `+1 loss: <span style="color:#a855f7">${next?fmt(next):'AT CAP'}</span><br>`+
      `Steps: <span style="color:${steps<=1?'#ef4444':'#4a7fa5'}">${steps}</span>`+
      (steps<=1?' <span style="color:#ef4444">⚠️ HIGH RISK</span>':'');
  }

  function autofillBet() {
    const barCb = document.getElementById('tbj-autofill');
    const slideOn = document.getElementById('tbj-slide-thumb')?.style.left === '19px';
    if (!barCb?.checked && !slideOn) return;
    const betInput = document.querySelector('.bet.input-money');
    if (!betInput) return;
    const newBetWrap = document.querySelector('.new-bet-wrap.bj-show');
    if (!newBetWrap) return;
    const br = getBankroll();
    if (!br || br <= 0) return; // never autofill with $0 balance
    const opt = Math.min(optimalBet(br), br); // never exceed bankroll
    if (parseInt(betInput.value) === opt) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(betInput, String(opt));
    else betInput.value = String(opt);
    betInput.dispatchEvent(new Event('input',  {bubbles:true}));
    betInput.dispatchEvent(new Event('change', {bubbles:true}));
    betInput.dispatchEvent(new KeyboardEvent('keyup', {bubbles:true}));
  }

  function injectAutoToggle() {
    if (document.getElementById('tbj-auto-inline')) return;
    // Use the new-bet-wrap as anchor — position toggle absolutely over the left edge of input
    const newBetWrap = document.querySelector('.new-bet-wrap');
    if (!newBetWrap) return;

    const tog = document.createElement('div');
    tog.id = 'tbj-auto-inline';
    tog.style.cssText = `
      position:absolute; bottom:68px; left:8px;
      display:flex; flex-direction:column; align-items:center;
      z-index:10; pointer-events:auto;
    `;
    tog.innerHTML = `
      <div style="font-family:'Courier New',monospace;font-size:8px;color:#22c55e;
                  letter-spacing:1px;margin-bottom:3px;font-weight:700;">AUTO-BET</div>
      <div id="tbj-slide-track" style="
        width:36px;height:20px;border-radius:10px;
        background:#1a2e42;border:1px solid #1a3a5c;
        position:relative;cursor:pointer;transition:background .2s;">
        <div id="tbj-slide-thumb" style="
          width:16px;height:16px;border-radius:50%;
          background:#4a7fa5;position:absolute;
          top:1px;left:1px;transition:left .2s,background .2s;
          box-shadow:0 1px 4px rgba(0,0,0,.4);"></div>
      </div>
    `;

    let on = false;
    const track = tog.querySelector('#tbj-slide-track');
    const thumb = tog.querySelector('#tbj-slide-thumb');
    function setOn(val) {
      on = val;
      track.style.background = on ? '#0a2818' : '#1a2e42';
      track.style.borderColor = on ? '#22c55e' : '#1a3a5c';
      thumb.style.left        = on ? '17px' : '1px';
      thumb.style.background  = on ? '#22c55e' : '#4a7fa5';
      const barCb = document.getElementById('tbj-autofill');
      if (barCb) barCb.checked = on;
    }
    track.addEventListener('click', () => setOn(!on));

    // Append to new-bet-wrap which already has position:relative
    newBetWrap.style.position = 'relative';
    newBetWrap.appendChild(tog);
  }
  function updateOdds(playerCards, dealerUp) {
    const el=document.getElementById('tbj-odds');
    if(!el) return;
    if(!playerCards.length||!dealerUp){el.textContent='';return;}
    const {value,isSoft}=handInfo(playerCards);
    const dv=dealerUp.val===14?11:Math.min(dealerUp.val,10);
    const {win,lose,push}=handWinProb(value,isSoft,dv,playerCards.length);
    el.innerHTML=
      `<span style="color:#22c55e">W:${(win*100).toFixed(0)}%</span> `+
      `<span style="color:#ef4444">L:${(lose*100).toFixed(0)}%</span> `+
      `<span style="color:#4a7fa5">P:${(push*100).toFixed(0)}%</span>`;
  }


  function hideTornSuggestion() {
    if (document.getElementById('tbj-hide-suggestion')) return;
    const style = document.createElement('style');
    style.id = 'tbj-hide-suggestion';
    // Hide Torn's green suggestion text that overlaps the CONTINUE button
    style.textContent = `
      .casino-msg-wrap .right.msg,
      .blackjack-wrap .suggestion,
      .blackjack-wrap .hint,
      .win-lose-wrap .win-lose .continue ~ *,
      .main-table-wrap > .suggestion,
      .main-table-wrap > .hint { display: none !important; }
    `;
    document.head.appendChild(style);
  }

  function injectStartStats() {
    if (document.getElementById('tbj-start-stats')) return;
    const wrap = document.querySelector('.new-bet-wrap');
    if (!wrap) return;

    // Pull the wrap up to reduce dead space
    wrap.style.top = '80px';

    const strip = document.createElement('div');
    strip.id = 'tbj-start-stats';
    strip.style.cssText = `
      font-family:'Courier New',monospace;
      font-size:11px; font-weight:700;
      text-align:center; padding:6px 8px 8px;
      letter-spacing:0.5px;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;
    `;
    // Insert before .msg (the warning text)
    const msgDiv = wrap.querySelector('.msg');
    wrap.insertBefore(strip, msgDiv || wrap.firstChild);
    updateStartStats();
  }

  function updateStartStats() {
    const strip = document.getElementById('tbj-start-stats');
    if (!strip) return;
    const pc = sess.profit>=0?'#22c55e':'#ef4444';
    const lt = lifetime;
    const ltpc = (lt.profit||0)>=0?'#22c55e':'#ef4444';
    strip.innerHTML =
      `<div style="margin-bottom:3px;">`+
      `<span style="color:#4a7fa5;letter-spacing:1px;">SESSION</span>&nbsp;`+
      `<span style="color:#22c55e">W:${sess.wins}</span>&nbsp;`+
      `<span style="color:#ef4444">L:${sess.losses}</span>&nbsp;`+
      `<span style="color:${pc};font-size:12px;">${fmt(sess.profit)}</span>`+
      `</div>`+
      `<div>`+
      `<span style="color:#3b7dd8;letter-spacing:1px;">LIFETIME</span>&nbsp;`+
      `<span style="color:#22c55e">W:${lt.wins||0}</span>&nbsp;`+
      `<span style="color:#ef4444">L:${lt.losses||0}</span>&nbsp;`+
      `<span style="color:${ltpc};font-size:12px;">${fmt(lt.profit||0)}</span>`+
      `</div>`;
  }

  function ensureTableLabel() {
    if (document.getElementById('tbj-table-label')) return;
    const wrap = document.querySelector('.blackjack-wrap');
    if (!wrap) return;
    const lbl = document.createElement('div');
    lbl.id = 'tbj-table-label';
    lbl.style.cssText = `
      position:absolute;
      bottom:108px;
      left:50%; transform:translateX(-50%);
      font-size:15px; font-weight:900;
      letter-spacing:1px;
      font-family:'Courier New',monospace;
      color:#22c55e;
      background:rgba(7,16,30,0.82);
      border:1px solid #1a3a5c;
      border-radius:6px;
      padding:4px 14px;
      pointer-events:none;
      z-index:10;
      white-space:nowrap;
      text-shadow:none;
    `;
    wrap.appendChild(lbl);
  }

  function updateTableLabel(action) {
    ensureTableLabel();
    const lbl = document.getElementById('tbj-table-label');
    if (!lbl) return;

    // Hide label when dealer hole card has been revealed (hand is over)
    // During play: dealer has one face-down card (.card-back) in their hand
    // Post-hand: hole card is revealed, no .card-back in dealer area
    const dealerCards = document.querySelectorAll('.dealer-cards .cards [class*="card-"]');
    const holeCardHidden = document.querySelector('.dealer-cards .cards .card-back');
    const handOver = dealerCards.length >= 2 && !holeCardHidden;
    if (handOver) {
      lbl.style.display = 'none';
      return;
    }

    const labels = {
      H:'HIT', S:'STAND', D:'DOUBLE DOWN', P:'SPLIT',
      E:'EARLY SURRENDER', BJ:'BLACKJACK!', C:'CHARLIE!', W:'',
      INS:'DECLINE INSURANCE',
    };
    const colors = {
      H:'#f97316', S:'#22c55e', D:'#a855f7', P:'#3b82f6',
      E:'#ef4444', BJ:'#fbbf24', C:'#fbbf24', W:'',
      INS:'#ef4444',
    };
    lbl.textContent = labels[action] || '';
    lbl.style.color = colors[action] || '#6faf41';
    lbl.style.display = (action === 'W' || !labels[action]) ? 'none' : 'block';
  }
  function watchResults() {
    const target=document.querySelector('.blackjack-wrap');
    if(!target) return;
    const obs=new MutationObserver(()=>{
      const wlWrap=document.querySelector('.win-lose-wrap');
      if(!wlWrap||!wlWrap.classList.contains('bj-show')) return;
      const wlEl = document.querySelector('.win-lose .wl-msg');
      const msg=(wlEl?.querySelector('span')||{}).textContent||'';
      const info=(document.querySelector('.win-lose .wl-info .bj-wonState')||{}).textContent||'';
      const bet=getCurrentBet()||sess.lastBet||0;
      // Use timestamp-based key so identical consecutive hands are tracked separately
      const key=msg+bet+Math.floor(Date.now()/5000); // 5 second dedup window
      if(obs._k===key) return;
      obs._k=key;
      const lower=msg.toLowerCase();
      const wlClass = wlEl?.className||'';
      const amtM=info.match(/\$([0-9,]+)/);
      const amt=amtM?parseInt(amtM[1].replace(/,/g,'')):bet;

      // Detect surrender
      const isSurrender = wlClass.includes('neutral') &&
        (info.toLowerCase().includes('surrender') || lower.includes('surrender'));
      // Detect push: neutral class OR tie/push text OR same score message
      const isPush = (!isSurrender) && (
        wlClass.includes('neutral') ||
        lower.includes('push') ||
        lower.includes('tie') ||
        lower.includes('draw') ||
        // Torn shows "TIE" or empty msg with neutral class for pushes
        (wlClass.includes('neutral') && msg.trim() === '')
      );

      // For doubles/splits, amt includes the full payout on the actual wagered amount
      // effectiveBet = what was actually wagered = amt/2 on a win (since payout = 2x wager on win)
      // For regular wins: amt = 2*bet, effectiveBet = bet -- same result
      // For double wins: amt = 2*(2*bet) = 4*bet, effectiveBet = 2*bet -- correct
      // So profit = amt - effectiveBet = amt - amt/2 = amt/2... no
      // Actually: profit on any win = amt - actual_wager
      // We can derive actual_wager from amt on wins: actual_wager = amt/2 (since win always returns 2x)
      // Exception: blackjack pays 3:2 so amt = 2.5*bet
      const isBJ = info.toLowerCase().includes('blackjack') ||
                   info.toLowerCase().includes('natural') ||
                   (amt > 0 && bet > 0 && Math.abs(amt/bet - 2.5) < 0.01);
      const effectiveBet = isBJ ? Math.round(amt/2.5) : Math.round(amt/2);
      const winProfit = isBJ ? Math.round(effectiveBet*1.5) : effectiveBet;

      if(wlClass.includes('won')||lower.includes('won')||lower.includes('win')){
        sess.wins++;
        sess.profit += winProfit;
      } else if(isSurrender){
        sess.losses++;
        sess.profit -= Math.round(bet*0.5);
      } else if(wlClass.includes('lost')||lower.includes('lost')||lower.includes('lose')||lower.includes('bust')){
        sess.losses++;
        // On loss, bet shown in getCurrentBet is original, but double/split loses full wager
        // Use amt if available (some losses show 0 amt), otherwise fall back to bet
        sess.profit -= (amt > 0 ? amt : bet);
      } else if(isPush||lower.includes('push')||lower.includes('tie')){
        sess.pushes++;
      }
      if(bet) sess.lastBet=bet;
      // Update lifetime
      const isWin = wlClass.includes('won')||lower.includes('won')||lower.includes('win');
      const isLoss = isSurrender || wlClass.includes('lost')||lower.includes('lost')||lower.includes('lose')||lower.includes('bust');
      const isPushHand = isPush||lower.includes('push')||lower.includes('tie');
      lifetime.wins   = (lifetime.wins||0)   + (isWin ? 1 : 0);
      lifetime.losses = (lifetime.losses||0) + (isLoss ? 1 : 0);
      lifetime.pushes = (lifetime.pushes||0) + (isPushHand ? 1 : 0);
      if (isWin)       lifetime.profit = (lifetime.profit||0) + winProfit;
      else if (isSurrender) lifetime.profit = (lifetime.profit||0) - Math.round(bet*0.5);
      else if (isLoss) lifetime.profit = (lifetime.profit||0) - (amt > 0 ? amt : bet);
      lifetime.hands = (lifetime.hands||0) + 1;
      saveLifetime(lifetime);
      updateStats();
    });
    obs.observe(target,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  }

  // ── Main loop ──────────────────────────────────────────────────────────────
  let lastKey='';

  function update() {
    const actionEl=document.getElementById('tbj-action');
    const reasonEl=document.getElementById('tbj-reason');
    if(!actionEl) return;

    updateKelly();
    updateMartingale();
    injectAutoToggle();
    injectStartStats();
    updateStartStats();
    autofillBet();
    const bet=getCurrentBet();
    if(bet) sess.lastBet=bet;

    const playerCards=readCards(document.querySelector('.player-cards .cards'));
    const dealerUp=readDealerUp();

    updateCharlie(playerCards.length);
    updateOdds(playerCards,dealerUp);

    if(!playerCards.length||!dealerUp){
      updateTableLabel('W');
      const br2=getBankroll();
      const opt2=br2?optimalBet(br2):null;
      actionEl.textContent=opt2?`BET ${fmt(opt2)}`:'DEAL A HAND';
      actionEl.style.color='#3b82f6';
      actionEl.style.background='transparent';
      if(reasonEl) reasonEl.textContent='';
      return;
    }

    const key=playerCards.map(c=>c.rank+c.suit).join(',')+(dealerUp?dealerUp.rank+dealerUp.suit:'');

    // Post-hand: dealer hole card revealed — check every tick (before key cache)
    const dealerCardEls=document.querySelectorAll('.dealer-cards .cards [class*="card-"]');
    const holeHidden=document.querySelector('.dealer-cards .cards .card-back');
    const isPostHand=dealerCardEls.length>=2&&!holeHidden;
    if(isPostHand){
      updateTableLabel('W');
      const br2=getBankroll();
      const opt2=br2?optimalBet(br2):null;
      actionEl.textContent=opt2?`BET ${fmt(opt2)}`:'DEAL A HAND';
      actionEl.style.color='#3b82f6';
      actionEl.style.background='transparent';
      if(reasonEl) reasonEl.textContent='';
      lastKey='';
      return;
    }

    if(key===lastKey) return;
    lastKey=key;

    const {canSplit} = getAvailableActions();
    // Double always available on first 2 cards; split available when cards match
    const canDouble = playerCards.length === 2;
    const isPairHand = playerCards.length === 2 && playerCards[0].val === playerCards[1].val;
    // Use detected canSplit but also check if it's visually a pair — Torn always allows split on pairs
    const effectiveCanSplit = isPairHand || canSplit;
    const action=getAction(playerCards,dealerUp,canDouble,effectiveCanSplit,true);

    // Insurance: only show if insurance button is currently active (not disabled)
    const insBtn = document.querySelector('[data-step="insurance"]');
    const insActive = insBtn && !insBtn.className.includes('disabled') &&
                      parseFloat(window.getComputedStyle(insBtn).opacity||'1') >= 0.6;
    if (insActive && dealerUp?.val === 14) {
      const actionEl2 = document.getElementById('tbj-action');
      const reasonEl2 = document.getElementById('tbj-reason');
      if(actionEl2){ actionEl2.textContent='DECLINE INSURANCE'; actionEl2.style.color='#ef4444'; actionEl2.style.background='rgba(239,68,68,0.15)'; }
      if(reasonEl2) reasonEl2.textContent='Insurance is -EV. Always decline.';
      updateTableLabel('INS');
      return;
    }
    const A=ACT[action]||ACT['H'];

    actionEl.textContent=A.t;
    actionEl.style.color=A.c;
    actionEl.style.background=A.bg;
    updateTableLabel(action);

    const {value,isSoft}=handInfo(playerCards);
    const dv=dealerUp.val===14?11:Math.min(dealerUp.val,10);
    const reasons={
      E:`Surrender early — save 50% vs dealer ${dv}`,
      C:'6 cards without busting = auto win!',
      BJ:'Natural blackjack — 3:2 payout!',
      D:`Double — max EV: ${isSoft?'Soft ':''}${value} vs ${dv}`,
      P:`Split — each card plays vs dealer ${dv}`,
      S:`Stand — ${isSoft?'Soft ':''}${value} vs dealer ${dv}`,
      H:`Hit — ${isSoft?'Soft ':''}${value} vs dealer ${dv}`,
    };
    if(reasonEl) reasonEl.textContent=reasons[action]||'';
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  function boot() {
    document.getElementById('torn-bj-panel')?.remove();
    hideTornSuggestion();
    buildPanel();
    watchResults();
    updateStats();
    setInterval(update, 400);
    console.log('%c[Torn BJ Advisor v5] Active','color:#22c55e;font-weight:bold;');
  }

  // Auto-boot: wait for blackjack-wrap to appear, retry every 500ms
  function tryBoot(retries) {
    if (document.querySelector('.blackjack-wrap')) {
      boot();
    } else if (retries > 0) {
      setTimeout(() => tryBoot(retries - 1), 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => tryBoot(40));
  } else {
    tryBoot(40);
  }

})();
