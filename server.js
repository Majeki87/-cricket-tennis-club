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

const rooms = new Map();
const PORT = process.env.PORT || 3000;
const TICK = 1 / 30;
const AUTO_NEXT = 2.5;   // 포인트가 끝나고 다음 서브까지(초). Space로 바로 넘길 수 있음

function code() { return crypto.randomBytes(3).toString("hex").toUpperCase(); }
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function clientAt(room, side) { return room.clients.find(c => c.side === side); }
function cleanKeys(k) { return { up: !!k?.up, down: !!k?.down, left: !!k?.left, right: !!k?.right }; }
function snapshot(room) {
  return { type: "state", room: room.id, status: room.status, format: room.format,
    names: [0, 1].map(s => clientAt(room, s)?.name || ""),
    chars: [0, 1].map(s => clientAt(room, s)?.char || null),
    match: room.match };
}
function broadcast(room) { const msg = snapshot(room); room.clients.forEach(c => send(c.ws, msg)); }
function startMatch(room) {
  room.match = E.newMatch({ format: room.format, chars: [clientAt(room, 0).char, clientAt(room, 1).char], autoNext: AUTO_NEXT, evId: room.evId });
  room.status = "playing";
}
function tick(room) {
  if (room.clients.length < 2) { room.status = "waiting"; room.match = null; return; }
  if (room.status === "waiting") room.status = "ready";
  if (!room.match) return;
  E.step(room.match, TICK, [{ keys: room.inputs[0] }, { keys: room.inputs[1] }]);
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
        room = { id, clients: [], inputs: [{}, {}], match: null, status: "waiting", evId: 0,
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
    if (msg.type === "input") room.inputs[side] = cleanKeys(msg.keys);
    // 경기 시작 전(또는 경기가 끝난 뒤) 로비에서 선수·경기 방식 변경
    const idle = !st || st.phase === "done";
    if (msg.type === "char" && idle && E.CHARS.includes(msg.char)) client.char = msg.char;
    if (msg.type === "format" && idle && side === 0 && E.FORMATS[msg.format]) room.format = msg.format;
    if (msg.type === "serve" && st) E.serve(st, side, { keys: cleanKeys(msg.keys), err: 1 });
    if (msg.type === "item" && st) E.useItem(st, side, Number(msg.slot) | 0);
    if (msg.type === "hit" && st) {
      const skill = E.SKILLS.includes(msg.skill) ? msg.skill : "normal";
      send(ws, { type: "hitResult", result: E.tryHit(st, side, skill, { keys: cleanKeys(msg.keys), err: 1 }) });
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
