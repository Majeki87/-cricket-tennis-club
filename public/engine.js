/* 귀뚜라미 테니스 경기 엔진
   - 실제 테니스 규칙: ITF 코트 규격(미터 단위), 대각선 서브, 폴트·더블 폴트·레트,
     원 바운드/발리, 아웃·네트, 15-30-40-듀스-어드밴티지, 6게임 세트·타이브레이크
   - 브라우저(개인전)와 서버(실시간 대전)가 같은 파일을 사용합니다.
   좌표: x는 좌우(m, 0이 센터), y는 앞뒤(m, 0이 네트). 0번 선수는 y>0(아래), 1번 선수는 y<0(위). z는 공 높이(m). */
(function (root) {
"use strict";

const COURT = { L: 11.885, S: 4.115, D: 5.485, SV: 6.40, NET: 0.914, POST: 1.07, POSTX: 6.4, AX: 7.3, AY: 15.5 };
const G = 9.8, LINE = 0.04;
const CHARS = ["tornado", "snake", "fire", "quake"];
const SKILLS = ["normal", "volley", "drop", "speed", "lob", "special"];
const FORMATS = { short: { games: 4, sets: 1 }, set1: { games: 6, sets: 1 }, set3: { games: 6, sets: 2 } };
// 아이템: 경기 중 포인트가 끝날 때마다 무작위로 얻고(최대 3개), 쓰면 그 포인트가 끝날 때까지 효과 유지
const ITEMS = ["anchovy", "milk", "coupon"];        // 죽방멸치 · 서울우유 · 로빈 쿠폰
const ITEM_MAX = 3, ITEM_CHANCE = .25;
const ITEM_FX = { anchovyT: .78, milkReach: 1.5, couponSig: .55 };
const GAUGE_HIT = 10, GAUGE_LOSE = 10, STUN_TIME = 0.75, FIRE_REACH = 0.7, MOVE_SPEED = 5.8, MAX_HIT_Z = 2.6;
const REACH = { normal: 1.45, volley: 2.1, drop: 1.45, speed: 1.45, lob: 1.45, special: 1.7 };
const AI = {
  easy:   { speed: 3.8, error: .20, err: 1.5,  serveErr: 1.25, judge: .5,  special: .5, drop: .04, power: .05, aim: .35, lob: .15, item: .3 },
  normal: { speed: 4.8, error: .09, err: 1.1,  serveErr: 1.0,  judge: .85, special: .8, drop: .10, power: .15, aim: .7,  lob: .35, item: .5 },
  hard:   { speed: 5.9, error: .03, err: .75,  serveErr: .8,   judge: 1,   special: 1,  drop: .14, power: .25, aim: .9,  lob: .55, item: .7 }
};

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const dirOf = side => side === 0 ? -1 : 1;          // 그 선수가 공을 보내는 방향(y)
const ownSign = side => side === 0 ? 1 : -1;        // 그 선수 코트 쪽 y 부호
function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function netHeight(x) { return COURT.NET + (COURT.POST - COURT.NET) * Math.min(1, Math.abs(x) / COURT.POSTX); }
function pushEv(st, e) { st.evId++; e.id = st.evId; st.events.push(e); if (st.events.length > 24) st.events.shift(); }

function serveCourt(st) { return (st.pts[0] + st.pts[1]) % 2 === 0 ? "deuce" : "ad"; }
// 서버가 서는 쪽 x 부호 (듀스 코트 = 서버 기준 오른쪽)
function stanceSign(st) { const deuce = st.server === 0 ? 1 : -1; return serveCourt(st) === "deuce" ? deuce : -deuce; }
function inCourt(x, y, side) { const yr = y * ownSign(side); return yr >= -LINE && yr <= COURT.L + LINE && Math.abs(x) <= COURT.S + LINE; }
function inBox(st, x, y, recv) {
  const yr = y * ownSign(recv), box = -stanceSign(st);
  return yr >= -LINE && yr <= COURT.SV + LINE && Math.abs(x) <= COURT.S + LINE && x * box >= -LINE;
}

function idleBall(id) {
  return { x: 0, y: 0, z: 0, bx: 0, by: 0, px: 0, py: 0, vx: 0, vy: 0, vz: 0, live: false, held: false, owner: -1, bounces: 0,
    kind: "normal", curve: null, serve: false, let: false, crossed: false, t: 0, T: 0, e: .72, keep: .78, id: id || 0 };
}

function newMatch(opts = {}) {
  const format = FORMATS[opts.format] ? opts.format : "set1";
  const st = {
    format, G: FORMATS[format].games, setsToWin: FORMATS[format].sets,
    chars: [opts.chars?.[0] || null, opts.chars?.[1] || null],
    pts: [0, 0], games: [0, 0], sets: [0, 0], history: [], tb: false, tbFirst: 0,
    server: opts.firstServer ?? (Math.random() < .5 ? 0 : 1), serveNo: 1,
    phase: "serve", timer: 0, autoNext: opts.autoNext || 0, serveWait: 1,
    players: [{ x: 0, y: COURT.L + .8 }, { x: 0, y: -COURT.L - .8 }],
    ball: idleBall(0), gauge: [0, 0], stun: [0, 0], winner: null, rally: 0,
    events: [], evId: opts.evId || 0, ai: {}, items: [[], []], active: [{}, {}], pointNo: 0
  };
  pushEv(st, { type: "toss", server: st.server });
  startPoint(st);
  return st;
}

function startPoint(st) {
  if (st.phase === "done") return;
  const s = st.server, r = 1 - s, sign = stanceSign(st);
  st.players[s] = { x: sign * 1.2, y: ownSign(s) * (COURT.L + .35) };
  st.players[r] = { x: -sign * 2.3, y: ownSign(r) * (COURT.L + .7) };
  st.ball = idleBall(st.ball.id); st.ball.held = true;
  holdBall(st);
  st.phase = "serve"; st.stun = [0, 0]; st.rally = 0;
  st.serveWait = 1 + Math.random() * .6;
}
function holdBall(st) { const p = st.players[st.server], b = st.ball; b.x = b.bx = b.px = p.x + .25; b.y = b.by = b.py = p.y; b.z = 1.1; }

function constrain(st, i) {
  const p = st.players[i], own = ownSign(i);
  if (st.phase === "serve" && i === st.server) {            // 서버는 센터 마크와 사이드라인 사이, 베이스라인 뒤
    const s = stanceSign(st);
    p.x = s > 0 ? clamp(p.x, .2, COURT.S) : clamp(p.x, -COURT.S, -.2);
    p.y = own * (COURT.L + .35); return;
  }
  p.x = clamp(p.x, -COURT.AX + .6, COURT.AX - .6);
  p.y = clamp(p.y * own, .7, COURT.AY - .8) * own;
}
function movePlayer(st, i, inp, dt) {
  if (st.stun[i] > 0) return;
  const p = st.players[i], sp = inp.speed || MOVE_SPEED;
  if (inp.target) {
    const dx = inp.target.x - p.x, dy = inp.target.y - p.y, dist = Math.hypot(dx, dy);
    if (dist > .03) { const m = Math.min(dist, sp * dt); p.x += dx / dist * m; p.y += dy / dist * m; }
  } else {
    const k = inp.keys || {}, dx = (k.right ? 1 : 0) - (k.left ? 1 : 0), dy = (k.down ? 1 : 0) - (k.up ? 1 : 0);
    if (dx || dy) { const mag = Math.hypot(dx, dy); p.x += dx / mag * sp * dt; p.y += dy / mag * sp * dt; }
  }
  constrain(st, i);
}

// 낮은 타점에서도 네트를 넘도록 비행 시간을 늘려 줌 (margin만큼 여유)
function clearT(from, to, T, margin) {
  if (from.y * to.y >= 0) return T;
  const f = from.y / (from.y - to.y), z0 = Math.max(.05, from.z);
  for (let i = 0; i < 16; i++) {
    const vz = (-z0 + .5 * G * T * T) / T, t = f * T, zc = z0 + vz * t - .5 * G * t * t, xc = from.x + (to.x - from.x) * f;
    if (zc >= netHeight(xc) + margin || T > 2.4) break;
    T *= 1.07;
  }
  return T;
}
function launch(b, from, to, T, margin) {
  if (margin != null) T = clearT(from, to, T, margin);
  b.x = b.bx = b.px = from.x; b.y = b.by = b.py = from.y; b.z = Math.max(.05, from.z);
  b.vx = (to.x - from.x) / T; b.vy = (to.y - from.y) / T; b.vz = (-b.z + .5 * G * T * T) / T;
  Object.assign(b, { t: 0, T, bounces: 0, crossed: false, let: false, curve: null, e: .72, keep: .78, live: true, held: false });
  b.id++;
}

function serve(st, side, aim = {}) {
  if (st.phase !== "serve" || side !== st.server) return false;
  const b = st.ball, d = dirOf(side), box = -stanceSign(st), first = st.serveNo === 1, k = aim.keys || {};
  const h = (k.right ? 1 : 0) - (k.left ? 1 : 0);          // 서브 코스: 센터(T) 쪽 / 와이드 쪽
  const act = st.active[side];
  const sig = (first ? .62 : .3) * (aim.err || 1) * (act.coupon ? ITEM_FX.couponSig : 1);
  const tx = clamp(box * COURT.S / 2 + h * 1.3, -COURT.S, COURT.S) + gauss() * sig;
  const ty = d * ((first ? 5.5 : 4.7) + gauss() * sig * .7);
  const p = st.players[side];
  launch(b, { x: p.x + .2, y: p.y, z: 2.65 }, { x: tx, y: ty }, (first ? .85 : 1.15) * (act.anchovy ? ITEM_FX.anchovyT : 1), act.anchovy ? .1 : null);
  if (first) b.vz += gauss() * .3 * (aim.err || 1) * (act.coupon ? ITEM_FX.couponSig : 1);
  b.owner = side; b.serve = true; b.kind = first ? "speed" : "normal";
  itemBall(st, side, b);
  st.phase = "rally"; st.rally = 0;
  pushEv(st, { type: "serve", side, no: st.serveNo });
  return true;
}

function ballDist(b, p) {   // 이번 프레임 동안 공(그림자)이 지나간 선분과 선수 사이 최단 거리
  const ax = b.px, ay = b.py, dx = b.x - ax, dy = b.y - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? clamp(((p.x - ax) * dx + (p.y - ay) * dy) / L2, 0, 1) : 0;
  return Math.hypot(p.x - (ax + dx * t), p.y - (ay + dy * t));
}
function tryHit(st, side, skill, aim = {}) {
  const b = st.ball;
  if (!SKILLS.includes(skill)) skill = "normal";
  if (st.phase !== "rally" || !b.live) return "idle";
  if (b.owner === side || !b.crossed) return "own";
  if (b.serve && b.bounces === 0) return "serveBounce";    // 서브는 반드시 한 번 튄 뒤에 리턴
  if (b.bounces >= 2) return "late";
  if (skill === "special" && (st.gauge[side] < 100 || !CHARS.includes(st.chars[side]))) return "noGauge";
  if (b.z > MAX_HIT_Z) return "high";
  const reach = REACH[skill] * (b.kind === "fire" ? FIRE_REACH : 1) * (st.active[side].milk ? ITEM_FX.milkReach : 1);
  if (ballDist(b, st.players[side]) > reach) return b.kind === "fire" ? "fireFar" : "far";
  shoot(st, side, skill, aim);
  return "ok";
}
function shoot(st, side, skill, aim) {
  const b = st.ball, d = dirOf(side), opp = st.players[1 - side], k = aim.keys || {}, err = aim.err || 1;
  const h = (k.right ? 1 : 0) - (k.left ? 1 : 0);
  const v = side === 0 ? (k.up ? 1 : 0) - (k.down ? 1 : 0) : (k.down ? 1 : 0) - (k.up ? 1 : 0);  // 네트 쪽 키 = 깊게
  const away = opp.x < 0 ? 1 : -1, char = st.chars[side];
  let tx, depth, T, sig, margin = .08, zSig = .15, kind = skill, curve = null;
  switch (skill) {
    case "volley": tx = h ? h * 3.4 : away * 3.3; depth = 5.6; T = .95; sig = .65; break;
    case "drop":   tx = h ? h * 2.4 : (Math.random() - .5) * 3; depth = 2.3; T = 1.3; sig = .4; break;
    case "speed":  tx = h ? h * 3.1 : away * 2.7; depth = 9.7; T = .8; sig = .9; margin = 0; zSig = .45; break;
    // 탑스핀 로브: 상대 머리 위로 높이 띄워 베이스라인 근처에 떨어지고, 튄 뒤에도 높이 솟아오름
    case "lob":    tx = h ? h * 2.4 : away * 1.8; depth = 10.1; T = 2.05; sig = .6; margin = .6; zSig = .2; break;
    case "special":
      kind = char; tx = away * 3.1; sig = .2; zSig = 0; margin = .3;
      if (char === "tornado") { depth = 9; T = 1.35; curve = "tornado"; }
      else if (char === "snake") { depth = 8.8; T = 1.3; curve = "snake"; }
      else if (char === "fire") { depth = 10.2; T = .62; }
      else { depth = 8.4; T = 1.15; }
      break;
    default: tx = h ? h * 3 : clamp(-opp.x * .45 + (Math.random() - .5) * 3.2, -3.1, 3.1); depth = 8.6 + v * 1.4; T = 1.25 - v * .08; sig = .5;
  }
  const act = st.active[side];
  if (act.coupon) sig *= ITEM_FX.couponSig;             // 로빈 쿠폰: 집중력 → 정확도
  if (act.anchovy) T *= ITEM_FX.anchovyT;               // 죽방멸치: 힘 → 공 속도
  tx += gauss() * sig * err;
  const ty = d * (depth + gauss() * sig * .8 * err);
  launch(b, { x: b.x, y: b.y, z: b.z }, { x: tx, y: ty }, T, margin);
  if (zSig) b.vz += gauss() * zSig * err;
  b.owner = side; b.serve = false; b.kind = kind; b.curve = curve;
  if (skill === "drop") { b.e = .42; b.keep = .6; }
  if (skill === "lob") { b.e = .82; b.keep = .7; }
  if (kind === "fire") { b.e = .6; b.keep = .92; }
  itemBall(st, side, b);
  st.rally++;
  if (skill === "special") { st.gauge[side] = 0; pushEv(st, { type: "special", side, kind }); }
  else st.gauge[side] = Math.min(100, st.gauge[side] + GAUGE_HIT);
  pushEv(st, { type: "hit", side, skill, x: b.x, y: b.y });
}

function itemBall(st, side, b) {
  const act = st.active[side];
  b.pow = !!act.anchovy;
  b.spin = act.coupon ? (Math.random() < .5 ? -1 : 1) : 0;
  if (b.spin) { b.e = Math.min(.9, b.e * 1.18); b.keep = Math.min(.95, b.keep * 1.15); }   // 로빈 쿠폰: 스핀 → 휘어 들어가고 튄 뒤 더 뻗음
}
function useItem(st, side, slot) {
  if (st.phase === "done") return "idle";
  const bag = st.items[side], item = bag[slot];
  if (!item) return "empty";
  if (st.active[side][item]) return "already";
  bag.splice(slot, 1); st.active[side][item] = true;
  pushEv(st, { type: "item", side, item });
  return "ok";
}
function stepBall(st, dt) {
  const b = st.ball; if (!b.live) return;
  b.t += dt; b.bx += b.vx * dt; b.by += b.vy * dt; b.z += b.vz * dt - .5 * G * dt * dt; b.vz -= G * dt;
  let ox = 0, oy = 0;
  if (b.curve && b.bounces === 0 && b.t < b.T) {        // 필살기 궤적: 착지 순간에는 휘어짐이 0이 되도록
    const u = b.t / b.T;
    if (b.curve === "tornado") { const r = 1.5 * Math.sin(Math.PI * u), ph = u * Math.PI * 6; ox = r * Math.sin(ph); oy = r * .55 * (Math.cos(ph) - 1); }
    else if (b.curve === "snake") ox = 2.5 * Math.sin(3 * Math.PI * u);
  }
  if (b.spin && b.bounces === 0 && b.t < b.T) ox += 0.9 * Math.sin(Math.PI * b.t / b.T) * b.spin;   // 스핀으로 바나나처럼 휘었다가 목표 지점에 떨어짐
  b.x = b.bx + ox; b.y = b.by + oy;
  if (!b.crossed && b.by * dirOf(b.owner) >= 0) {         // 네트 통과 판정
    b.crossed = true;
    const tb = Math.abs(b.vy) > 0 ? Math.abs(b.by) / Math.abs(b.vy) : 0;
    const zc = b.z - b.vz * tb - .5 * G * tb * tb, nh = netHeight(b.bx);
    if (zc < nh - .12) {                                  // 네트에 걸림
      b.by = -dirOf(b.owner) * .15; b.x = b.bx; b.y = b.by; b.z = Math.max(0, zc * .4); b.live = false;
      pushEv(st, { type: "net", x: b.x, y: 0, side: b.owner });
      if (b.serve) fault(st, "net"); else pointTo(st, 1 - b.owner, "net");
      return;
    }
    if (zc < nh) {                                        // 네트 코드: 맞고 넘어감
      b.z = Math.max(b.z, nh); b.vz = Math.abs(b.vz) * .25 + .9; b.vx *= .45; b.vy *= .3; b.curve = null;
      if (b.serve) b.let = true;
      pushEv(st, { type: "netcord", x: b.bx, y: 0 });
    }
  }
  if (b.z <= 0 && b.vz < 0) {
    b.z = 0; b.x = b.bx; b.y = b.by;
    if (bounce(st)) return;
    b.vz = -b.vz * b.e; b.vx *= b.keep; b.vy *= b.keep; b.curve = null;
  }
}
function bounce(st) {
  const b = st.ball, recv = 1 - b.owner;
  b.bounces++;
  if (b.bounces === 1) {
    if (!b.crossed) { pushEv(st, { type: "bounce", x: b.x, y: b.y, out: true }); b.live = false; if (b.serve) fault(st, "net"); else pointTo(st, recv, "net"); return true; }
    const ok = b.serve ? inBox(st, b.x, b.y, recv) : inCourt(b.x, b.y, recv);
    pushEv(st, { type: "bounce", x: b.x, y: b.y, out: !ok });
    if (!ok) { b.live = false; if (b.serve) fault(st, "out"); else pointTo(st, recv, "out"); return true; }
    if (b.serve && b.let) { b.live = false; letServe(st); return true; }
    if (b.kind === "quake") { st.stun[recv] = STUN_TIME; pushEv(st, { type: "quake", side: recv, x: b.x, y: b.y }); }
    return false;
  }
  b.live = false;                                          // 투 바운드: 마지막에 친 선수의 포인트
  pointTo(st, b.owner, b.serve ? "ace" : "winner");
  return true;
}
function fault(st, reason) {
  const s = st.server;
  if (st.serveNo === 1) { st.serveNo = 2; st.phase = "fault"; st.timer = 1.1; pushEv(st, { type: "fault", side: s, reason }); }
  else { pushEv(st, { type: "fault", side: s, reason, double: true }); pointTo(st, 1 - s, "double"); }
}
function letServe(st) { st.phase = "fault"; st.timer = 1.1; pushEv(st, { type: "let", side: st.server }); }

function pointTo(st, w, reason) {
  st.ball.live = false; st.serveNo = 1;
  st.active = [{}, {}]; st.pointNo++;                   // 점수를 따거나 잃으면 아이템 효과는 사라짐
  for (let i = 0; i < 2; i++) if (st.items[i].length < ITEM_MAX && Math.random() < ITEM_CHANCE) {
    const item = ITEMS[Math.floor(Math.random() * ITEMS.length)];
    st.items[i].push(item); pushEv(st, { type: "itemGet", side: i, item });
  }
  st.gauge[1 - w] = Math.min(100, st.gauge[1 - w] + GAUGE_LOSE);
  st.pts[w]++;
  const gameOver = st.tb ? (st.pts[w] >= 7 && st.pts[w] - st.pts[1 - w] >= 2) : (st.pts[w] >= 4 && st.pts[w] - st.pts[1 - w] >= 2);
  pushEv(st, { type: "point", winner: w, reason, server: st.server, pts: [...st.pts], tb: st.tb });
  if (gameOver) gameWon(st, w);
  else if (st.tb) {                                        // 타이브레이크: 첫 1포인트 후 2포인트마다 서버 교대, 6포인트마다 코트 체인지
    const n = st.pts[0] + st.pts[1];
    if (n % 2 === 1) st.server = 1 - st.server;
    if (n % 6 === 0) pushEv(st, { type: "ends" });
  }
  if (st.phase !== "done") { st.phase = "point"; st.timer = st.autoNext; }
}
function gameWon(st, w) {
  const wasTb = st.tb;
  st.games[w]++; st.pts = [0, 0];
  if (wasTb) { st.tb = false; st.server = 1 - st.tbFirst; }   // 타이브레이크에서 먼저 리시브한 선수가 다음 세트 첫 서브
  else st.server = 1 - st.server;
  pushEv(st, { type: "game", winner: w, games: [...st.games], tb: wasTb });
  const gw = st.games[w], gl = st.games[1 - w];
  if (wasTb || (gw >= st.G && gw - gl >= 2)) setWon(st, w);
  else if (gw === st.G && gl === st.G) { st.tb = true; st.tbFirst = st.server; pushEv(st, { type: "tiebreak" }); }
  else if ((st.games[0] + st.games[1]) % 2 === 1) pushEv(st, { type: "ends" });
}
function setWon(st, w) {
  st.sets[w]++; st.history.push([...st.games]);
  pushEv(st, { type: "set", winner: w, score: [...st.games] });
  st.games = [0, 0];
  if (st.sets[w] >= st.setsToWin) { st.phase = "done"; st.winner = w; pushEv(st, { type: "match", winner: w }); }
}

function step(st, dt, inputs = []) {
  if (st.phase === "fault") { st.timer -= dt; if (st.timer <= 0) startPoint(st); return; }
  if (st.phase === "point") { if (st.autoNext > 0) { st.timer -= dt; if (st.timer <= 0) startPoint(st); } return; }
  if (st.phase !== "serve" && st.phase !== "rally") return;
  st.ball.px = st.ball.x; st.ball.py = st.ball.y;
  const n = Math.max(1, Math.ceil(dt / .017)), h = dt / n;
  for (let s = 0; s < n; s++) {
    for (let i = 0; i < 2; i++) { st.stun[i] = Math.max(0, st.stun[i] - h); movePlayer(st, i, inputs[i] || {}, h); }
    if (st.phase === "serve") { holdBall(st); return; }
    if (st.phase !== "rally") return;
    stepBall(st, h);
  }
}

/* ───── 컴퓨터 선수 ───── */
function landing(b) {
  const t = (b.vz + Math.sqrt(b.vz * b.vz + 2 * G * Math.max(0, b.z))) / G;
  return { x: b.bx + b.vx * t, y: b.by + b.vy * t, vz: b.vz - G * t };
}
function timeToHeight(z, vz, h) { const disc = vz * vz + 2 * G * (z - h); if (disc < 0) return Math.max(0, vz / G); return (vz + Math.sqrt(disc)) / G; }
function hitSpot(b) {
  if (b.bounces === 0) { const L = landing(b), vz1 = -L.vz * b.e, th = timeToHeight(0, vz1, 1); return { x: L.x + b.vx * b.keep * th, y: L.y + b.vy * b.keep * th }; }
  const th = timeToHeight(b.z, b.vz, 1); return { x: b.bx + b.vx * th, y: b.by + b.vy * th };
}
function aiThink(st, side, level, dt) {
  const cfg = AI[level] || AI.normal, me = st.players[side], b = st.ball, own = ownSign(side), base = own * (COURT.L + .9);
  const ai = st.ai[side] || (st.ai[side] = { ball: -1, leave: false, tried: false, off: 0 });
  const out = { speed: cfg.speed, target: { x: me.x, y: me.y } };
  if ((st.phase === "serve" || st.phase === "rally") && st.items[side].length && ai.itemPoint !== st.pointNo) {
    ai.itemPoint = st.pointNo;
    if (Math.random() < cfg.item) useItem(st, side, Math.floor(Math.random() * st.items[side].length));
  }
  if (st.phase === "serve") {
    if (st.server === side) {
      st.serveWait -= dt;
      if (st.serveWait <= 0) { const r = Math.random(); serve(st, side, { keys: r < .33 ? { left: true } : r < .66 ? { right: true } : {}, err: cfg.serveErr }); }
    } else out.target = { x: -stanceSign(st) * 2.2, y: base };
    return out;
  }
  if (st.phase !== "rally" || !b.live) { out.target = { x: me.x, y: me.y }; return out; }
  if (b.owner === side) { out.target = { x: clamp(b.x * .25, -1.5, 1.5), y: base }; return out; }
  if (ai.ball !== b.id) {                                  // 새로 날아온 공: 아웃이면 보내 줄지 판단
    ai.ball = b.id; ai.tried = false; ai.off = gauss() * Math.max(0, cfg.err - .6) * .8;
    const L = landing(b);
    const willOut = b.bounces === 0 && (b.serve ? !inBox(st, L.x, L.y, side) : !inCourt(L.x, L.y, side));
    ai.leave = willOut && Math.random() < cfg.judge;
  }
  const spot = hitSpot(b);
  if (ai.leave) { out.target = { x: spot.x + (me.x >= spot.x ? 1.8 : -1.8), y: me.y }; return out; }
  out.target = { x: spot.x + ai.off, y: spot.y + own * .35 };
  if (!ai.tried && b.crossed && b.z <= MAX_HIT_Z) {
    const canVolley = !b.serve && Math.abs(me.y) < 6;
    const reach = REACH.normal * (b.kind === "fire" ? FIRE_REACH : 1) * (st.active[side].milk ? ITEM_FX.milkReach : 1);
    if ((b.bounces === 1 || (b.bounces === 0 && canVolley)) && ballDist(b, me) < reach) {
      ai.tried = true;
      const miss = cfg.error + (b.kind === "tornado" || b.kind === "snake" ? .26 : 0);
      if (Math.random() < miss) pushEv(st, { type: "whiff", side });
      else {
        let skill = "normal";
        if (st.gauge[side] >= 100 && CHARS.includes(st.chars[side]) && Math.random() < cfg.special) skill = "special";
        else if (Math.abs(st.players[1 - side].y) < 6 && Math.random() < cfg.lob) skill = "lob";       // 상대가 네트에 붙으면 로브로 넘김
        else if (Math.abs(st.players[1 - side].y) > COURT.L - .5 && Math.random() < cfg.drop) skill = "drop";
        else if (Math.random() < cfg.power) skill = "speed";
        const ox = st.players[1 - side].x;
        tryHit(st, side, skill, { keys: Math.random() < cfg.aim ? (ox < 0 ? { right: true } : { left: true }) : {}, err: cfg.err });
      }
    }
  }
  return out;
}

const api = { COURT, CHARS, SKILLS, FORMATS, AI, ITEMS, ITEM_MAX, useItem, newMatch, startPoint, step, serve, tryHit, aiThink, serveCourt, stanceSign, inCourt, inBox, netHeight };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else root.TennisEngine = api;
})(typeof self !== "undefined" ? self : this);
