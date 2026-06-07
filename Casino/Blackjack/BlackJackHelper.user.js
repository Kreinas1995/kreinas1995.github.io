// ==UserScript==
// @name         Torn BJ Advisor
// @namespace    https://www.torn.com/
// @version      7.8
// @description  Perfect strategy for Torn BJ +0.37% edge. Auto-bet, session/lifetime stats, goal mode.
// @match        https://www.torn.com/page.php?sid=blackjack*
// @match        https://www.torn.com/loader.php?sid=blackjack*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function(){
'use strict';

// ── Strategy tables ──────────────────────────────────────────────────────────
// 8 decks, dealer stands soft 17, early surrender, 6-card charlie, 3:2
// Columns: dealer 2,3,4,5,6,7,8,9,10,A
const HARD={
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
const SOFT={
  13:['H','H','H','D','D','H','H','H','H','H'],
  14:['H','H','H','D','D','H','H','H','H','H'],
  15:['H','H','D','D','D','H','H','H','H','H'],
  16:['H','H','D','D','D','H','H','H','H','H'],
  17:['H','D','D','D','D','H','H','H','H','H'],
  18:['S','D','D','D','D','S','S','H','H','H'],
  19:['S','S','S','S','S','S','S','S','S','S'],
  20:['S','S','S','S','S','S','S','S','S','S'],
};
const PAIRS={
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
const SURR_PAIRS_ACE=new Set([3,6,7]);
const DI={2:0,3:1,4:2,5:3,6:4,7:5,8:6,9:7,10:8,11:9};
const ACT={
  H:{t:'HIT',           c:'#f97316',bg:'rgba(249,115,22,0.15)'},
  S:{t:'STAND',         c:'#22c55e',bg:'rgba(34,197,94,0.15)'},
  D:{t:'DOUBLE DOWN',   c:'#a855f7',bg:'rgba(168,85,247,0.15)'},
  P:{t:'SPLIT',         c:'#3b82f6',bg:'rgba(59,130,246,0.15)'},
  E:{t:'EARLY SURRENDER',c:'#ef4444',bg:'rgba(239,68,68,0.15)'},
  BJ:{t:'BLACKJACK!',   c:'#fbbf24',bg:'rgba(251,191,36,0.15)'},
  C:{t:'6-CARD CHARLIE!',c:'#fbbf24',bg:'rgba(251,191,36,0.15)'},
  W:{t:'DEAL A HAND',   c:'#4a7fa5',bg:'transparent'},
  INS:{t:'DECLINE INSURANCE',c:'#ef4444',bg:'rgba(239,68,68,0.15)'},
};

// ── Card helpers ──────────────────────────────────────────────────────────────
const SUIT_MAP={clubs:'C',diamonds:'D',hearts:'H',spades:'S'};
const RANK_VAL={'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
const CARD_RE=/card-(clubs|diamonds|hearts|spades)-([0-9AJQK]+)/;

function parseCard(el){
  const m=CARD_RE.exec(el.className||'');
  if(!m) return null;
  return {rank:m[2],suit:SUIT_MAP[m[1]],val:RANK_VAL[m[2]]||0};
}

function getCards(scope){
  if(!scope) return [];
  return Array.from(scope.querySelectorAll('div'))
    .filter(el=>CARD_RE.test(el.className||''))
    .map(parseCard).filter(Boolean);
}

function handInfo(cards){
  let v=0,a=0;
  for(const c of cards){v+=c.val===14?11:Math.min(c.val,10);if(c.val===14)a++;}
  while(v>21&&a>0){v-=10;a--;}
  return{value:v,isSoft:a>0&&v<=21};
}

// ── Action logic ──────────────────────────────────────────────────────────────
function getAction(pc,du,canDbl,canSpl){
  if(!du||!pc.length) return'W';
  const dv=du.val===14?11:Math.min(du.val,10);
  const di=DI[dv]??DI[10];
  const{value,isSoft}=handInfo(pc);
  const n=pc.length;
  if(n>=6&&value<=21) return'C';
  if(n===2&&value===21) return'BJ';
  const isPair=n===2&&pc[0].val===pc[1].val;
  const canSurr=n===2;
  if(isPair&&canSurr&&dv===11){
    const pv=Math.min(pc[0].val===14?11:pc[0].val,10);
    if(SURR_PAIRS_ACE.has(pv)) return'E';
  }
  let a='H';
  if(isPair&&canSpl){
    const pv=pc[0].val===14?11:Math.min(pc[0].val,10);
    a=PAIRS[pv]?.[di]??'H';
    if(a==='D'&&!canDbl) a='H';
    if(a==='E'&&!canSurr) a='H';
  } else if(isSoft&&SOFT[value]){
    a=SOFT[value][di];
    if(a==='D'&&!canDbl) a='H';
  } else {
    const cv=Math.min(Math.max(value,4),21);
    a=HARD[cv]?.[di]??(value>=17?'S':'H');
    if(a==='D'&&!canDbl) a='H';
    if(a==='E'&&!canSurr) a='H';
  }
  if(n>=4&&value<=14) a='H';
  return a;
}

// ── Math ──────────────────────────────────────────────────────────────────────
const EDGE=0.0037,VAR=1.3225,STD=1.15,DAILY=100;
let goalTarget=null;

function normCDF(z){
  if(z<-8)return 0;if(z>8)return 1;
  const t=1/(1+0.2316419*Math.abs(z));
  const d=0.3989423*Math.exp(-z*z/2);
  const p=d*t*(0.3193815+t*(-0.3565638+t*(1.7814779+t*(-1.8212560+t*1.3302744))));
  return z>0?1-p:p;
}
function pBustDay(br,bet){
  const mu=DAILY*EDGE*bet,sig=Math.sqrt(DAILY)*STD*bet;
  return normCDF((-br-mu)/sig);
}
function pGoalDaily(br,target,bet){
  const dmu=DAILY*EDGE*bet,dsig=Math.sqrt(DAILY)*STD*bet;
  const theta=2*dmu/(dsig*dsig);
  try{
    const num=1-Math.exp(-theta*br),den=1-Math.exp(-theta*(br+target));
    return(!isFinite(num)||!isFinite(den)||den===0)?0:Math.max(0,Math.min(1,num/den));
  }catch(e){return 0;}
}
function optimalBet(br){
  if(!br||br<=0) return 0;
  if(br<1000000) return Math.max(1000,Math.round(br*0.05/1000)*1000);
  let lo=1000,hi=Math.min(br,100000000);
  for(let i=0;i<60;i++){const m=(lo+hi)/2;pBustDay(br,m)<0.05?lo=m:hi=m;}
  const raw=Math.min(lo,100000000);
  if(raw>=1000000) return Math.max(100000,Math.round(raw/500000)*500000);
  if(raw>=100000)  return Math.max(10000, Math.round(raw/100000)*100000);
  return Math.max(1000,Math.round(raw/10000)*10000);
}

// ── Storage ───────────────────────────────────────────────────────────────────
const LIFE_KEY='tbj_life_v1',SESS_KEY='tbj_sess_v1';
function todayGMT(){const d=new Date();return`${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`;}
function loadLife(){try{return JSON.parse(localStorage.getItem(LIFE_KEY))||{w:0,l:0,p:0,profit:0};}catch(e){return{w:0,l:0,p:0,profit:0};}}
function saveLife(x){try{localStorage.setItem(LIFE_KEY,JSON.stringify(x));}catch(e){}}
function loadSess(){
  try{
    const r=JSON.parse(localStorage.getItem(SESS_KEY));
    if(!r||r._date!==todayGMT()) return{w:0,l:0,p:0,profit:0,lastBet:0,_date:todayGMT()};
    return r;
  }catch(e){return{w:0,l:0,p:0,profit:0,lastBet:0,_date:todayGMT()};}
}
function saveSess(x){try{x._date=todayGMT();localStorage.setItem(SESS_KEY,JSON.stringify(x));}catch(e){}}

const sess=loadSess();
let life=loadLife();
// Store starting token count for accurate hand tracking
setTimeout(()=>{const t=getTokens();if(t>0&&!sess._startTokens){sess._startTokens=t;saveSess(sess);}},2000);

// ── DOM helpers ───────────────────────────────────────────────────────────────
function fmt(n){
  const s=n<0?'-':'',a=Math.abs(n);
  if(a>=1e9) return s+'$'+(a/1e9).toFixed(2)+'B';
  if(a>=1e6) return s+'$'+(a/1e6).toFixed(1)+'M';
  if(a>=1e3) return s+'$'+Math.round(a/1e3)+'K';
  return s+'$'+a;
}
function getTokens(){
  const el=document.querySelector('.bj-tokens');
  return el?parseInt(el.textContent.replace(/[^0-9]/g,''))||0:0;
}

function getBankroll(){
  const el=document.getElementById('user-money')||document.querySelector('[id*="money"][data-money]');
  if(el){const v=parseInt(el.getAttribute('data-money'));if(v>0)return v;}
  return null;
}
function getCurrentBet(){
  const t=(document.querySelector('.bj-pot')||{}).textContent||'';
  return parseInt(t.replace(/[^0-9]/g,''))||0;
}
function btnEnabled(step){
  const el=document.querySelector(`[data-step="${step}"]`);
  if(!el) return false;
  return !el.className.includes('disabled')&&parseFloat(window.getComputedStyle(el).opacity||'1')>=0.6;
}

// ── Build panel ───────────────────────────────────────────────────────────────
function buildPanel(){
  if(document.getElementById('tbj-panel')) return;
  const p=document.createElement('div');
  p.id='tbj-panel';
  p.style.cssText='font-family:"Courier New",monospace;background:#07101e;border:1px solid #1a3a5c;border-radius:0 0 8px 8px;margin-top:-2px;';
  p.innerHTML=`
    <!-- Bottom bar -->
    <div id="tbj-bar" style="display:flex;align-items:center;padding:4px 8px;gap:6px;cursor:pointer;min-height:30px;border-bottom:1px solid #1a2e42;">
      <span id="tbj-toggle" style="color:#4a7fa5;font-size:10px;flex-shrink:0;">▲</span>
      <div id="tbj-action" style="font-size:13px;font-weight:900;color:#22c55e;white-space:nowrap;flex-shrink:0;min-width:100px;">DEAL A HAND</div>
      <div id="tbj-odds" style="font-size:9px;color:#4a7fa5;white-space:nowrap;flex-shrink:0;"></div>
      <div style="display:flex;gap:2px;flex:1;max-width:60px;">
        ${[1,2,3,4,5,6].map(i=>`<div id="tbj-pip${i}" style="flex:1;height:4px;border-radius:1px;background:#1a2e42;"></div>`).join('')}
      </div>
      <div style="font-size:9px;white-space:nowrap;flex-shrink:0;">
        W:<span id="tbj-w" style="color:#22c55e">0</span>
        L:<span id="tbj-l" style="color:#ef4444">0</span>
        <span id="tbj-pl" style="color:#94a3b8"> $0</span>
      </div>
      <label style="display:flex;align-items:center;gap:2px;cursor:pointer;flex-shrink:0;" onclick="event.stopPropagation()">
        <input type="checkbox" id="tbj-auto" style="cursor:pointer;width:10px;height:10px;"> <span style="font-size:8px;color:#3b82f6;">AUTO</span>
      </label>
    </div>
    <div id="tbj-reason" style="font-size:8px;color:#4a7fa5;text-align:center;padding:1px 8px 2px;display:none;"></div>
    <!-- Expanded -->
    <div id="tbj-exp" style="display:none;padding:6px 8px;border-top:1px solid #1a2e42;">
      <div style="display:flex;gap:6px;">
        <div style="flex:1.2;padding:6px 8px;background:#0d1b2a;border:1px solid #1a2e42;border-radius:6px;">
          <div style="font-size:8px;color:#3b7dd8;letter-spacing:1px;margin-bottom:4px;">GOAL MODE</div>
          <div style="display:flex;gap:3px;margin-bottom:4px;">
            <input id="tbj-goal-inp" type="number" placeholder="Target $M"
              style="flex:1;min-width:0;background:#07101e;border:1px solid #1a3a5c;border-radius:3px;color:#94a3b8;font-size:9px;padding:3px 4px;outline:none;font-family:monospace;">
            <button id="tbj-goal-btn" style="background:#1a3a5c;border:none;border-radius:3px;color:#22c55e;font-size:9px;padding:3px 7px;cursor:pointer;font-family:monospace;">SET</button>
          </div>
          <div id="tbj-kelly" style="font-size:9px;color:#94a3b8;line-height:1.8;">—</div>
        </div>
        <div style="flex:1;padding:6px 8px;background:#0d1b2a;border:1px solid #1a2e42;border-radius:6px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
            <span id="tbj-sess-lbl" style="font-size:8px;color:#4a7fa5;letter-spacing:1px;cursor:pointer;">SESSION</span>
            <button id="tbj-life-btn" style="background:#1a3a5c;border:none;border-radius:3px;color:#3b82f6;font-size:8px;padding:1px 5px;cursor:pointer;font-family:monospace;">LIFETIME</button>
          </div>
          <div id="tbj-stats" style="font-size:9px;color:#94a3b8;line-height:1.8;">—</div>
        </div>
        <div style="flex:1;padding:6px 8px;background:#0d1b2a;border:1px solid #1a2e42;border-radius:6px;display:flex;flex-direction:column;justify-content:center;gap:6px;">
          <button id="tbj-reset-sess" style="background:#0a1020;color:#f97316;border:1px solid #f97316;border-radius:4px;padding:6px;font-size:9px;font-weight:700;font-family:monospace;cursor:pointer;letter-spacing:1px;width:100%;">RESET SESSION</button>
          <button id="tbj-reset" style="background:#1a0a0a;color:#ef4444;border:1px solid #ef4444;border-radius:4px;padding:6px;font-size:9px;font-weight:700;font-family:monospace;cursor:pointer;letter-spacing:1px;width:100%;">RESET ALL</button>
        </div>
      </div>
    </div>
  `;

  // Inject after blackjack-wrap
  const bj=document.querySelector('.blackjack-wrap');
  if(bj&&bj.parentNode) bj.parentNode.insertBefore(p,bj.nextSibling);
  else document.body.appendChild(p);

  // Expand/collapse
  let exp=false;
  document.getElementById('tbj-bar').addEventListener('click',e=>{
    if(['tbj-auto','tbj-goal-inp','tbj-goal-btn','tbj-reset','tbj-life-btn','tbj-sess-lbl'].includes(e.target.id)) return;
    exp=!exp;
    document.getElementById('tbj-exp').style.display=exp?'flex':'none';
    document.getElementById('tbj-reason').style.display=exp?'block':'none';
    document.getElementById('tbj-toggle').textContent=exp?'▼':'▲';
  });

  // Goal set
  p.addEventListener('click',e=>{
    if(e.target.id==='tbj-goal-btn'){
      const v=parseFloat(document.getElementById('tbj-goal-inp').value);
      if(!isNaN(v)&&v>0){goalTarget=v*1e6;updateKelly();}
    }
    if(e.target.id==='tbj-reset-sess'){
        if(confirm('Reset session stats?')){
          sess.w=sess.l=sess.p=0;sess.profit=0;
          sess._date=todayGMT();
          sess._startTokens=getTokens()||null;
          saveSess(sess);updateStats();updateStartStats();
        }
      }
      if(e.target.id==='tbj-reset'){
      if(confirm('Reset ALL stats?')){
        sess.w=sess.l=sess.p=0;sess.profit=0;
        life={w:0,l:0,p:0,profit:0};
        saveLife(life);saveSess(sess);updateStats();
      }
    }
  });

  // Lifetime toggle
  let showLife=false;
  p.addEventListener('click',e=>{
    if(e.target.id==='tbj-life-btn'||e.target.id==='tbj-sess-lbl'){
      showLife=!showLife;
      document.getElementById('tbj-sess-lbl').textContent=showLife?'LIFETIME':'SESSION';
      document.getElementById('tbj-life-btn').textContent=showLife?'SESSION':'LIFETIME';
      updateStats();
    }
  });
  p._showLife=()=>showLife;

  // Goal input enter key
  p.addEventListener('keydown',e=>{
    if(e.target.id==='tbj-goal-inp'&&e.key==='Enter') document.getElementById('tbj-goal-btn').click();
  });
}

// ── Update helpers ────────────────────────────────────────────────────────────
function updateCharlie(n){
  for(let i=1;i<=6;i++){
    const pip=document.getElementById('tbj-pip'+i);
    if(pip) pip.style.background=i<=n?(i===6?'#fbbf24':'#22c55e'):'#1a2e42';
  }
}

function updateKelly(){
  const el=document.getElementById('tbj-kelly');
  if(!el) return;
  const br=getBankroll();
  if(!br){el.innerHTML='<span style="color:#2a5070">—</span>';return;}
  const opt=optimalBet(br);
  if(!goalTarget){
    el.innerHTML=`<span style="color:#4a7fa5">Safe bet:</span> <span style="color:#22c55e">${fmt(opt)}</span><br><span style="color:#2a5070">Set goal above</span>`;
    return;
  }
  const pg=pGoalDaily(br,goalTarget,opt)*100;
  const days=Math.ceil(goalTarget/(DAILY*EDGE*opt));
  el.innerHTML=
    `<span style="color:#fbbf24">Goal: ${fmt(goalTarget)}</span><br>`+
    `<span style="color:#22c55e">Bet: ${fmt(opt)}</span><br>`+
    `P(goal): <span style="color:${pg>50?'#22c55e':'#f97316'}">${pg.toFixed(1)}%</span> `+
    `<span style="color:#2a5070">~${days}d</span><br>`+
    `EV/day: <span style="color:#3b82f6">${fmt(DAILY*EDGE*opt)}</span>`;
}

function updateStats(){
  const el=document.getElementById('tbj-stats');
  const panel=document.getElementById('tbj-panel');
  const showLife=panel&&panel._showLife&&panel._showLife();
  const d=showLife?life:sess;
  const pc=(d.profit||0)>=0?'#22c55e':'#ef4444';
  // Use token diff for session hands (most accurate)
  const tokens=getTokens();
  const tokenHands=(sess._startTokens&&tokens>0)?(sess._startTokens-tokens):null;
  const hands=showLife?(d.w||0)+(d.l||0)+(d.p||0):(tokenHands!==null?tokenHands:(d.w||0)+(d.l||0)+(d.p||0));
  if(el) el.innerHTML=
    `Hands: <span style="color:#94a3b8">${hands}</span><br>`+
    `W/L/P: <span style="color:#22c55e">${d.w||0}</span>/<span style="color:#ef4444">${d.l||0}</span>/<span style="color:#4a7fa5">${d.p||0}</span><br>`+
    `P/L: <span style="color:${pc}">${fmt(d.profit||0)}</span>`;
  const w=document.getElementById('tbj-w');
  const l=document.getElementById('tbj-l');
  const pl=document.getElementById('tbj-pl');
  if(w) w.textContent=sess.w||0;
  if(l) l.textContent=sess.l||0;
  if(pl){pl.textContent=fmt(sess.profit||0);pl.style.color=(sess.profit||0)>=0?'#22c55e':'#ef4444';}
}
function injectAutoToggle(){
  if(document.getElementById('tbj-at')) return;
  const wrap=document.querySelector('.new-bet-wrap');
  if(!wrap) return;
  const tog=document.createElement('div');
  tog.id='tbj-at';
  tog.style.cssText='position:absolute;bottom:78px;left:8px;display:flex;flex-direction:column;align-items:center;z-index:10;';
  tog.innerHTML=`
    <div style="font-family:monospace;font-size:8px;color:#22c55e;margin-bottom:3px;font-weight:700;">AUTO-BET</div>
    <div id="tbj-track" style="width:36px;height:20px;border-radius:10px;background:#1a2e42;border:1px solid #1a3a5c;position:relative;cursor:pointer;transition:background .2s;">
      <div id="tbj-thumb" style="width:16px;height:16px;border-radius:50%;background:#4a7fa5;position:absolute;top:1px;left:1px;transition:left .2s,background .2s;box-shadow:0 1px 4px rgba(0,0,0,.4);"></div>
    </div>
  `;
  let on=false;
  const track=tog.querySelector('#tbj-track');
  const thumb=tog.querySelector('#tbj-thumb');
  function setOn(v){
    on=v;
    track.style.background=on?'#0a2818':'#1a2e42';
    track.style.borderColor=on?'#22c55e':'#1a3a5c';
    thumb.style.left=on?'17px':'1px';
    thumb.style.background=on?'#22c55e':'#4a7fa5';
    const cb=document.getElementById('tbj-auto');
    if(cb) cb.checked=on;
  }
  track.addEventListener('click',()=>setOn(!on));
  wrap.style.position='relative';
  wrap.appendChild(tog);
}

function autofill(){
  const barAuto=document.getElementById('tbj-auto')?.checked;
  const slideOn=document.getElementById('tbj-thumb')?.style.left==='17px';
  if(!barAuto&&!slideOn) return;
  const inp=document.querySelector('.bet.input-money,[name="bet"]');
  if(!inp) return;
  if(!document.querySelector('.new-bet-wrap.bj-show')) return;
  const br=getBankroll();
  if(!br||br<=0) return;
  const opt=Math.min(optimalBet(br),br);
  if(parseInt(inp.value)===opt) return;
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
  if(setter) setter.call(inp,String(opt)); else inp.value=String(opt);
  inp.dispatchEvent(new Event('input',{bubbles:true}));
  inp.dispatchEvent(new Event('change',{bubbles:true}));
}

// ── Stats on start screen ─────────────────────────────────────────────────────
function injectStartStats(){
  if(document.getElementById('tbj-ss')) return;
  const wrap=document.querySelector('.new-bet-wrap');
  if(!wrap) return;
  wrap.style.top='80px';
  const strip=document.createElement('div');
  strip.id='tbj-ss';
  strip.style.cssText='font-family:monospace;font-size:11px;font-weight:700;text-align:center;padding:4px 8px 6px;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000;';
  const msg=wrap.querySelector('.msg');
  wrap.insertBefore(strip,msg||wrap.firstChild);
}
function updateStartStats(){
  const strip=document.getElementById('tbj-ss');
  if(!strip) return;
  const sp=(sess.profit||0)>=0?'#22c55e':'#ef4444';
  const lp=(life.profit||0)>=0?'#22c55e':'#ef4444';
  strip.innerHTML=
    `<div style="margin-bottom:2px;"><span style="color:#4a7fa5">SESSION</span> `+
    `<span style="color:#22c55e">W:${sess.w||0}</span> `+
    `<span style="color:#ef4444">L:${sess.l||0}</span> `+
    `<span style="color:${sp}">${fmt(sess.profit||0)}</span></div>`+
    `<div><span style="color:#3b7dd8">LIFETIME</span> `+
    `<span style="color:#22c55e">W:${life.w||0}</span> `+
    `<span style="color:#ef4444">L:${life.l||0}</span> `+
    `<span style="color:${lp}">${fmt(life.profit||0)}</span></div>`;
}

// ── Table label ───────────────────────────────────────────────────────────────
function ensureLabel(){
  if(document.getElementById('tbj-lbl')) return;
  const wrap=document.querySelector('.blackjack-wrap');
  if(!wrap) return;
  const lbl=document.createElement('div');
  lbl.id='tbj-lbl';
  lbl.style.cssText='position:absolute;bottom:108px;left:50%;transform:translateX(-50%);font-family:monospace;font-size:15px;font-weight:900;letter-spacing:1px;padding:4px 14px;border-radius:6px;background:rgba(7,16,30,0.85);border:1px solid #1a3a5c;pointer-events:none;z-index:10;white-space:nowrap;display:none;';
  wrap.appendChild(lbl);
}
function setLabel(action){
  ensureLabel();
  const lbl=document.getElementById('tbj-lbl');
  if(!lbl) return;
  const A=ACT[action]||ACT.H;
  // Hide on post-hand or pre-deal
  if(action==='W'||!A.t){lbl.style.display='none';return;}
  lbl.textContent=A.t;
  lbl.style.color=A.c;
  lbl.style.display='block';
}

// ── Result tracking ───────────────────────────────────────────────────────────
let balBefore=null,betSnap=null;
function watchResults(){
  if(watchResults._done) return;
  watchResults._done=true;
  const target=document.querySelector('.blackjack-wrap');
  if(!target) return;

  let balBefore=null, betSnap=null, handInProgress=false;

  // Single observer does everything
  new MutationObserver(()=>{
    // Step 1: snapshot balance when hand starts (hole card appears)
    const holeCard=document.querySelector('.dealer-cards .cards .card-back');
    const playerCard=document.querySelector('.player-cards .cards div[class*="card-"]');
    if(holeCard&&playerCard&&!handInProgress){
      handInProgress=true;
      balBefore=getBankroll();
      betSnap=getCurrentBet()||sess.lastBet||0;
    }

    // Step 2: record result when win/lose screen appears
    const wlWrap=document.querySelector('.win-lose-wrap');
    if(!wlWrap||!wlWrap.classList.contains('bj-show')) return;
    if(!handInProgress) return; // only record if we tracked a hand start
    // Dedup: only fire once per hand using handInProgress as the gate
    // handInProgress resets only when CONTINUE is clicked or new hand starts
    watchResults._lastWl=wlWrap.innerHTML;

    const balAfter=getBankroll();
    const bet=betSnap||getCurrentBet()||sess.lastBet||0;
    if(bet) sess.lastBet=bet;

    // Balance diff from AFTER bet deducted to AFTER result
    // On win: balAfter = balBefore + bet + profit = balBefore + 2*bet (regular)
    // So net profit = delta - bet (subtract stake return)
    // On loss: balAfter = balBefore - bet already deducted, result screen shows loss
    //   but balBefore was ALREADY post-deduction, so delta = 0 on loss? No...
    // Actually: Torn deducts bet at game start, then adds back on win
    // So: balBefore = balance after bet deducted
    //     Win:  balAfter = balBefore + (bet * multiplier)  → delta = bet * multiplier
    //     Loss: balAfter = balBefore (bet already gone)    → delta = 0
    //     Push: balAfter = balBefore + bet                 → delta = bet
    // Therefore net profit = delta - bet on win/push, delta on loss (which is 0 or negative for surrender)
    const rawDelta=(balBefore!=null&&balAfter!=null)?(balAfter-balBefore):null;

    const wlEl=document.querySelector('.win-lose .wl-msg');
    const wlClass=wlEl?.className||'';
    const msg=(wlEl?.querySelector('span')||{}).textContent?.toLowerCase()||'';
    const isWin=wlClass.includes('won')||msg.includes('won')||msg.includes('win');
    const isLoss=wlClass.includes('lost')||msg.includes('lost')||msg.includes('lose')||msg.includes('bust')||
                 (wlClass.includes('neutral')&&msg.includes('surrender'));
    const isPush=!isWin&&!isLoss;

    const isSurrender=wlClass.includes('neutral')&&msg.includes('surrender');

    // Net profit calculation:
    // Win/Push: delta = stake returned + profit, so net = delta - bet
    // Regular loss: delta = 0 (bet already gone at game start), so net = -bet... 
    //   BUT balBefore was snapped AFTER bet deducted, so delta=0 means net=0 which is wrong
    //   We need to account for the already-deducted bet: profit = -bet (fallback)
    // Surrender: Torn returns 50%, so delta = +bet/2, net = delta - bet = -bet/2 ✓
    let profit=0;
    if(rawDelta!==null){
      if(isWin||isPush) profit=rawDelta-bet;
      else if(isSurrender) profit=rawDelta-bet; // delta=+bet/2, so profit = bet/2 - bet = -bet/2 ✓
      else profit=-bet; // regular loss: bet already gone, delta=0, net profit = -bet
    } else {
      if(isWin) profit=bet;
      else if(isSurrender) profit=-Math.round(bet*0.5);
      else if(isLoss) profit=-bet;
      else profit=0;
    }

    if(isWin){sess.w=(sess.w||0)+1;}
    else if(isLoss){sess.l=(sess.l||0)+1;}
    else{sess.p=(sess.p||0)+1;}
    sess.profit=(sess.profit||0)+profit;

    life.w=(life.w||0)+(isWin?1:0);
    life.l=(life.l||0)+(isLoss?1:0);
    life.p=(life.p||0)+(isPush?1:0);
    life.profit=(life.profit||0)+profit;

    saveLife(life);saveSess(sess);
    updateStats();updateStartStats();

    // Reset for next hand - set to false AFTER recording, so second observer fire is ignored
    handInProgress=false;
    balBefore=null;betSnap=null;
  }).observe(target,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
}


// ── Main update loop ──────────────────────────────────────────────────────────
let lastKey='';
function update(){
  const actionEl=document.getElementById('tbj-action');
  const reasonEl=document.getElementById('tbj-reason');
  if(!actionEl) return;

  updateKelly();
  updateStats();
  injectAutoToggle();
  injectStartStats();
  updateStartStats();
  autofill();

  const bet=getCurrentBet();
  if(bet) sess.lastBet=bet;

  // Read cards
  const pdiv=document.querySelector('.player-cards');
  const ddiv=document.querySelector('.dealer-cards');
  const pc=pdiv?Array.from(pdiv.querySelectorAll('div')).filter(el=>CARD_RE.test(el.className||'')).map(parseCard).filter(Boolean):[];
  const dcards=ddiv?Array.from(ddiv.querySelectorAll('div')).filter(el=>CARD_RE.test(el.className||'')).map(parseCard).filter(Boolean):[];
  const du=dcards[0]||null;

  updateCharlie(pc.length);

  // Odds display
  const oddsEl=document.getElementById('tbj-odds');
  if(oddsEl&&pc.length&&du){
    const{value,isSoft}=handInfo(pc);
    const dv=du.val===14?11:Math.min(du.val,10);
    // Simple approximation
    const win=Math.max(0.05,Math.min(0.95,0.5+(value-dv)*0.04));
    const lose=Math.max(0.05,1-win-0.07);
    const push=Math.max(0,1-win-lose);
    oddsEl.innerHTML=`<span style="color:#22c55e">W:${Math.round(win*100)}%</span> <span style="color:#ef4444">L:${Math.round(lose*100)}%</span> <span style="color:#4a7fa5">P:${Math.round(push*100)}%</span>`;
  } else if(oddsEl) oddsEl.textContent='';

  // Post-hand: dealer has 2+ revealed cards (no card-back)
  const dealerRevealed=dcards.length>=2&&!ddiv?.querySelector('.card-back');
  if(dealerRevealed||(!pc.length&&!du)){
    setLabel('W');
    const br=getBankroll();
    const opt=br?optimalBet(br):null;
    actionEl.textContent=opt?`BET ${fmt(opt)}`:'DEAL A HAND';
    actionEl.style.color='#3b82f6';
    actionEl.style.background='transparent';
    if(reasonEl) reasonEl.textContent='';
    lastKey='';
    return;
  }

  if(!pc.length||!du) return;

  const key=pc.map(c=>c.rank+c.suit).join(',')+(du.rank+du.suit);
  if(key===lastKey) return;
  lastKey=key;

  // Insurance check
  const insBtn=document.querySelector('[data-step="insurance"]');
  const insActive=insBtn&&!insBtn.className.includes('disabled')&&parseFloat(window.getComputedStyle(insBtn).opacity||'1')>=0.6;
  if(insActive&&du.val===14){
    actionEl.textContent='DECLINE INSURANCE';actionEl.style.color='#ef4444';actionEl.style.background='rgba(239,68,68,0.15)';
    if(reasonEl) reasonEl.textContent='Insurance is -EV. Always decline.';
    setLabel('INS');return;
  }

  const canDbl=pc.length===2;
  const isPair=pc.length===2&&pc[0].val===pc[1].val;
  const canSpl=isPair||btnEnabled('split');
  const action=getAction(pc,du,canDbl,canSpl);
  const A=ACT[action]||ACT.H;
  actionEl.textContent=A.t;actionEl.style.color=A.c;actionEl.style.background=A.bg;
  setLabel(action);

  const{value,isSoft}=handInfo(pc);
  const dv=du.val===14?11:Math.min(du.val,10);
  const reasons={E:`Surrender — save 50% vs dealer ${dv}`,C:'6-card Charlie!',BJ:'Blackjack 3:2!',
    D:`Double — max EV: ${isSoft?'Soft ':''}${value} vs ${dv}`,P:`Split vs dealer ${dv}`,
    S:`Stand — ${isSoft?'Soft ':''}${value} vs ${dv}`,H:`Hit — ${isSoft?'Soft ':''}${value} vs ${dv}`};
  if(reasonEl) reasonEl.textContent=reasons[action]||'';
}

// ── Boot ──────────────────────────────────────────────────────────────────────
function boot(){
  document.getElementById('tbj-panel')?.remove();
  buildPanel();watchResults();updateStats();
  setInterval(update,400);
  console.log('%c[Torn BJ Advisor v7.0] Active','color:#22c55e;font-weight:bold;');
}
function tryBoot(n){
  if(document.querySelector('.blackjack-wrap')) boot();
  else if(n>0) setTimeout(()=>tryBoot(n-1),500);
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>tryBoot(40));
else tryBoot(40);

})();
SCRIPTEOF
