const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const E = require("./public/engine.js");   // 개인전과 같은 경기 엔진(실제 테니스 규칙)

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static("public"));
app.get("/health", (_, res) => res.json({ ok: true }));
// 공개된 방 목록: 로비에서 3초마다 불러감 (비공개 방은 빠짐)
app.get("/rooms", (_, res) => {
  const list = [...rooms.values()].filter(r => !r.private && r.clients.length > 0).map(r => {
    const host = r.clients[0];
    return { id: r.id, name: host.name, char: host.char, format: r.format, count: r.clients.length,
      status: r.clients.length >= 2 ? (r.match && r.match.phase !== "done" ? "playing" : "full") : "waiting", created: r.created };
  }).sort((a, b) => (a.status === "waiting" ? 0 : 1) - (b.status === "waiting" ? 0 : 1) || b.created - a.created).slice(0, 30);
  res.set("Cache-Control", "no-store").json(list);
});

const rooms = new Map();
const PORT = process.env.PORT || 3000;
const TICK = 1 / 30;
const AUTO_NEXT = 2.5;   // 포인트가 끝나고 다음 서브까지(초). Space로 바로 넘길 수 있음

function code() { return crypto.randomBytes(3).toString("hex").toUpperCase(); }
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function clientAt(room, side) { return room.clients.find(c => c.side === side); }
function cleanKeys(k) { return { up: !!k?.up, down: !!k?.down, left: !!k?.left, right: !!k?.right }; }
const r2 = v => Math.round(v * 100) / 100;
// 화면에 필요한 값만 골라서 보냄(이벤트는 새로 생긴 것만) → 데이터가 작아져 덜 끊김
function packMatch(room) {
  const st = room.match; if (!st) return null;
  const b = st.ball, events = st.events.filter(e => e.id > room.sentEv);
  return { format: st.format, phase: st.phase, server: st.server, serveNo: st.serveNo, pts: st.pts, games: st.games, sets: st.sets,
    history: st.history, tb: st.tb, winner: st.winner, chars: st.chars, items: st.items, active: st.active, rally: st.rally,
    gauge: st.gauge.map(Math.round), stun: st.stun.map(r2), posEpoch: st.posEpoch,
    players: st.players.map(p => ({ x: r2(p.x), y: r2(p.y) })),
    ball: { x: r2(b.x), y: r2(b.y), z: r2(b.z), kind: b.kind, live: b.live, held: b.held, pow: b.pow, spin: b.spin, id: b.id },
    events };
}
function snapshot(room) {
  return { type: "state", room: room.id, status: room.status, format: room.format,
    names: [0, 1].map(s => clientAt(room, s)?.name || ""),
    chars: [0, 1].map(s => clientAt(room, s)?.char || null),
    match: packMatch(room) };
}
function broadcast(room) {
  const msg = JSON.stringify(snapshot(room));
  if (room.match) room.sentEv = room.match.evId;
  room.clients.forEach(c => { if (c.ws.readyState === 1) c.ws.send(msg); });
}
function startMatch(room) {
  room.match = E.newMatch({ format: room.format, chars: [clientAt(room, 0).char, clientAt(room, 1).char], autoNext: AUTO_NEXT, evId: room.evId });
  room.sentEv = room.evId;
  room.status = "playing";
}
function tick(room) {
  if (room.clients.length < 2) { room.status = "waiting"; room.match = null; return; }
  if (room.status === "waiting") room.status = "ready";
  if (!room.match) return;
  // 자기 위치를 직접 보내는 화면(새 버전)은 서버가 키로 움직이지 않음
  const inp = [0, 1].map(s => clientAt(room, s)?.posMode ? {} : { keys: room.inputs[s] });
  E.step(room.match, TICK, inp);
  room.evId = room.match.evId;
}

wss.on("connection", (ws) => {
  let client = null, room = null;
  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "join") {
      let id = String(msg.room || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
      if (!id) id = code();
      room = rooms.get(id);
      if (!room) {
        room = { id, clients: [], inputs: [{}, {}], match: null, status: "waiting", evId: 0, sentEv: 0, created: Date.now(), private: !!msg.private,
          format: E.FORMATS[msg.format] ? msg.format : "set1" };     // 경기 방식은 방을 만든 사람 기준
        rooms.set(id, room);
      }
      if (room.clients.length >= 2) { send(ws, { type: "error", message: "방이 가득 찼습니다. 다른 방을 만들어 주세요." }); room = null; return; }
      const side = clientAt(room, 0) ? 1 : 0;
      const char = E.CHARS.includes(msg.char) ? msg.char : E.CHARS[Math.floor(Math.random() * E.CHARS.length)];
      client = { ws, name: String(msg.name || "귀뚜라미").slice(0, 12), side, char };
      room.clients.push(client);
      send(ws, { type: "joined", room: id, side });
      broadcast(room);
      return;
    }
    if (!room || !client) return;
    const st = room.match, side = client.side;
    if (msg.type === "ping") { client.rtt = Math.min(1000, Math.max(0, Number(msg.rtt) || 0)); send(ws, { type: "pong", t: msg.t }); return; }
    if (msg.type === "input") { room.inputs[side] = cleanKeys(msg.keys); return; }
    // 내 선수 위치: 화면에서 먼저 움직이고 서버는 속도·코트 범위만 검사
    if (msg.type === "pos") {
      client.posMode = true;
      if (!st || (st.phase !== "serve" && st.phase !== "rally") || msg.e !== st.posEpoch || st.stun[side] > 0) return;
      let x = Number(msg.x), y = Number(msg.y); if (!isFinite(x) || !isFinite(y)) return;
      const now = Date.now(), p = st.players[side], dts = Math.min(.25, (now - (client.lastPos || now - 33)) / 1000);
      client.lastPos = now;
      const dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy), max = E.MOVE_SPEED * dts * 1.4 + .15;
      if (d > max) { x = p.x + dx / d * max; y = p.y + dy / d * max; }
      p.x = x; p.y = y; E.constrainPos(st, side);
      return;
    }
    // 경기 시작 전(또는 경기가 끝난 뒤) 로비에서 선수·경기 방식 변경
    const idle = !st || st.phase === "done";
    if (msg.type === "char" && idle && E.CHARS.includes(msg.char)) client.char = msg.char;
    if (msg.type === "format" && idle && side === 0 && E.FORMATS[msg.format]) room.format = msg.format;
    if (msg.type === "serve" && st) E.serve(st, side, { keys: cleanKeys(msg.keys), err: 1 });
    if (msg.type === "item" && st) E.useItem(st, side, Number(msg.slot) | 0);
    if (msg.type === "taunt" && st) E.taunt(st, side, Number(msg.n) | 0);
    if (msg.type === "hit" && st) {
      const skill = E.SKILLS.includes(msg.skill) ? msg.skill : "normal";
      // 지연 보정: (왕복 시간의 절반 + 화면 보간 0.1초)만큼 조금 전 공 위치까지 인정
      const lookback = Math.max(3, Math.min(12, Math.round(((client.rtt || 80) / 2 + 100) / (1000 * TICK)) + 2));
      send(ws, { type: "hitResult", result: E.tryHit(st, side, skill, { keys: cleanKeys(msg.keys), err: 1 }, lookback) });
    }
    // Space / 시작 버튼: 포인트·폴트 후에는 누구나 바로 다음 서브, 경기 시작·새 경기는 호스트만
    if (msg.type === "next" || msg.type === "start") {
      if (st && (st.phase === "point" || st.phase === "fault")) E.startPoint(st);
      else if (side === 0 && room.clients.length === 2 && (!st || st.phase === "done")) startMatch(room);
    }
    broadcast(room);
  });
  ws.on("close", () => {
    if (room && client) {
      room.clients = room.clients.filter(c => c !== client);
      room.match = null; room.status = "waiting";
      broadcast(room);
      if (room.clients.length === 0) rooms.delete(room.id);
    }
  });
});
setInterval(() => { for (const room of rooms.values()) { tick(room); if (room.clients.length) broadcast(room); } }, 1000 * TICK);
server.listen(PORT, () => console.log(`Cricket Tennis running on ${PORT}`));
