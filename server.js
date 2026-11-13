const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static("public"));
app.get("/health", (_, res) => res.json({ ok: true }));

const rooms = new Map();
const PORT = process.env.PORT || 3000;

// 캐릭터별 필살기 (클라이언트 index.html 과 같은 값)
const CHAR_KEYS = ["tornado", "snake", "fire", "quake"];
const SPECIAL_SPEED = { tornado: 1.05, snake: 0.95, fire: 1.9, quake: 1.1 };
const SKILLS = ["volley", "drop", "speed", "special"];
const GAUGE_HIT = 20, GAUGE_LOSE = 15, STUN_TICKS = 34, FIRE_REACH = 0.55;

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function code() { return crypto.randomBytes(3).toString("hex").toUpperCase(); }
function freshGame() {
  return { score:[0,0], players:[{x:50,y:79},{x:50,y:21}],
    ball:{x:50,y:50,vx:0,vy:0,active:false,hit:0,kind:"normal"}, status:"waiting", serveSide:0,
    message:"두 명이 입장하면 경기를 시작할 수 있습니다.", pointAt:0, winner:null,
    gauge:[0,0], stun:[0,0], fx:[] };
}
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) { room.clients.forEach(c => send(c.ws,obj)); }
function clientAt(room, side) { return room.clients.find(c => c.side === side); }
function sideName(s) { return s === 0 ? "왼쪽" : "오른쪽"; }
function snapshot(room) {
  const g = room.game;
  return {type:"state", room:room.id, players:g.players, ball:g.ball, serveSide:g.serveSide,
    score:g.score, status:g.status, message:g.message, winner:g.winner,
    names:[0,1].map(s => clientAt(room,s)?.name || ""),
    chars:[0,1].map(s => clientAt(room,s)?.char || null),
    gauge:g.gauge, stun:g.stun, fx:g.fx};
}
function pushFx(room, fx) {
  room.fxId = (room.fxId || 0) + 1;
  room.game.fx.push({ id: room.fxId, ...fx });
  if (room.game.fx.length > 6) room.game.fx.shift();
}
function resetPoint(room) {
  const g=room.game;
  g.serveSide=Math.random()<.5 ? 0 : 1;
  g.stun=[0,0];
  room.inputs.forEach(inp=>{inp.serve=false;inp.hit=false;});
  const server=g.players[g.serveSide];
  g.ball={x:server.x,y:g.serveSide===0?server.y-10:server.y+10,vx:0,vy:0,active:false,hit:0,kind:"normal"};
  g.message=sideName(g.serveSide)+" 선수의 서브 차례! 강서브 버튼을 누르세요.";
  g.status="serve";
}
function scorePoint(room, side) {
  const g=room.game;
  g.score[side]++;
  g.ball.active=false;
  g.stun=[0,0];
  g.gauge[1-side]=Math.min(100,g.gauge[1-side]+GAUGE_LOSE);
  g.message=sideName(side)+" 선수 득점! R 키를 누르면 바로 다음 서브로 넘어갑니다.";
  if(g.score[side]>=5) {
    g.status="finished"; g.winner=side;
    g.message=sideName(side)+" 선수 우승!";
  } else {
    g.status="point"; g.pointAt=Date.now()+1300;
  }
}
// 공 이동 — 필살기 궤적 포함 (클라이언트 stepBall 과 동일한 계산)
function stepBall(b) {
  switch (b.kind) {
    case "tornado": {
      b.t+=1; b.cx+=b.vx; b.cy+=b.vy; b.ph+=.3;
      if(b.cx<16||b.cx>84){b.vx*=-1;b.cx=clamp(b.cx,16,84);}
      const r=Math.min(9,b.t*.45);
      b.x=clamp(b.cx+Math.cos(b.ph)*r,8,92); b.y=b.cy+Math.sin(b.ph)*r*.7;
      break;
    }
    case "snake": {
      b.t+=1; b.cx+=b.vx; b.y+=b.vy;
      if(b.cx<12||b.cx>88){b.vx*=-1;b.cx=clamp(b.cx,12,88);}
      const amp=17*Math.min(1,b.t/12);
      b.x=clamp(b.cx+Math.sin(b.t*.15)*amp,8,92);
      break;
    }
    case "fire": case "quake":
      b.x+=b.vx; b.y+=b.vy;
      if(b.x<8||b.x>92){b.vx*=-.88;b.x=clamp(b.x,8,92);}
      if(b.kind==="quake"&&!b.quaked&&((b.vy<0&&b.y<50)||(b.vy>0&&b.y>50))){b.quaked=true;return "quake";}
      break;
    default:
      b.x+=b.vx; b.y+=b.vy; b.vy+=b.vy>0?.003:-.003;
      if(b.x<8||b.x>92){b.vx*=-.88;b.x=clamp(b.x,8,92);}
  }
  return null;
}
function launchSpecial(room, i) {
  const g=room.game, kind=clientAt(room,i)?.char;
  if(!SPECIAL_SPEED[kind] || g.gauge[i]<100) return false;
  const b=g.ball, opp=g.players[1-i], speed=SPECIAL_SPEED[kind];
  const aimX=opp.x<50?70+Math.random()*16:14+Math.random()*16;
  const frames=Math.max(10,Math.abs((i===0?8:92)-b.y)/speed);
  Object.assign(b,{vx:clamp((aimX-b.x)/frames,-1.2,1.2),vy:(i===0?-1:1)*speed,kind,hit:1-i,t:0,cx:b.x,cy:b.y,ph:0,quaked:false});
  g.gauge[i]=0;
  pushFx(room,{type:"special",side:i,kind});
  g.message={tornado:"🌪️ 회전회오리샷!",snake:"🐍 스네이크샷!",fire:"🔥 불꽃샷!",quake:"🌋 어스퀘이크샷!"}[kind];
  return true;
}
function tick(room) {
  const g=room.game;
  if(room.clients.length<2) {g.status="waiting";g.ball.active=false;return;}
  if(g.status==="waiting") {g.status="ready";g.message="두 선수 준비 완료! 호스트가 시작하세요.";return;}
  if(g.status==="point" && Date.now()>=g.pointAt) { resetPoint(room); return; }
  if(g.status==="serve") {
    for(let i=0;i<2;i++) {
      const inp=room.inputs[i];
      if(inp.serve && g.serveSide===i) {
        const server=g.players[i];
        g.ball={x:server.x,y:i===0?server.y-10:server.y+10,vx:(Math.random()-.5)*.42,vy:i===0?-1.25:1.25,active:true,hit:1-i,kind:"speed"};
        g.status="playing";
        g.message="⚡ 강서브 발사! 공이 빠르게 날아갑니다.";
        inp.serve=false;
        break;
      }
      inp.serve=false;
    }
    return;
  }
  if(g.status!=="playing" || !g.ball.active) return;
  g.stun=g.stun.map(s=>Math.max(0,s-1));
  for(let i=0;i<2;i++) {
    const p=g.players[i], inp=room.inputs[i];
    if(g.stun[i]<=0) {
      const dx=(inp.right?1:0)-(inp.left?1:0);
      const dy=(inp.down?1:0)-(inp.up?1:0);
      const mag=Math.hypot(dx,dy)||1;
      p.x=clamp(p.x+dx/mag*.78,10,90);
      p.y=i===0?clamp(p.y+dy/mag*.78,53,91):clamp(p.y+dy/mag*.78,9,47);
    }
    if(inp.hit) {
      const b=g.ball;
      let skill=SKILLS.includes(inp.skill)?inp.skill:"normal";
      if(skill==="special" && g.gauge[i]<100) skill="normal";
      const reach=(skill==="volley"?22:skill==="special"?20:18)*(b.kind==="fire"?FIRE_REACH:1);
      if(b.active && b.hit===i && Math.hypot(p.x-b.x,p.y-b.y)<reach) {
        if(skill!=="special" || !launchSpecial(room,i)) {
          if(skill==="special") skill="normal";
          b.hit=1-i;
          b.vx=skill==="drop"?clamp((b.x-p.x)*.018,-.32,.32):clamp((b.x-p.x)*.035+(Math.random()-.5)*.12,-.9,.9);
          const velocity=skill==="speed"?1.48:skill==="volley"?1.08:skill==="drop"?.40:.78;
          b.vy=i===0?-velocity:velocity; b.kind=skill;
          g.gauge[i]=Math.min(100,g.gauge[i]+GAUGE_HIT);
          g.message=skill==="volley"?"🏐 발리샷!":skill==="drop"?"🪶 드롭샷!":skill==="speed"?"💥 스피드샷!":"멋진 리턴!";
        }
      }
      inp.hit=false; inp.skill="normal";
    }
  }
  const b=g.ball;
  if(stepBall(b)==="quake") {
    g.stun[b.hit]=STUN_TICKS;
    pushFx(room,{type:"quake",side:b.hit});
    g.message="🌋 땅이 흔들립니다! "+sideName(b.hit)+" 선수가 잠시 움직이지 못합니다!";
  }
  if(b.y<4&&b.vy<0){scorePoint(room,0);return;}
  if(b.y>96&&b.vy>0){scorePoint(room,1);return;}
  // A ball crossing to the other side is returned when the receiving player gets close.
  const receiver=b.y<50?1:0, p=g.players[receiver];
  if(Math.hypot(p.x-b.x,p.y-b.y)<9*(b.kind==="fire"?FIRE_REACH:1) && b.hit===receiver) {
    b.hit=1-receiver;
    b.vx=clamp((b.x-p.x)*.035+(Math.random()-.5)*.22,-.72,.72);
    b.vy=receiver===0?-.76:.76;
    b.kind="normal";
    g.gauge[receiver]=Math.min(100,g.gauge[receiver]+GAUGE_HIT);
    g.message="상대의 리턴! 랠리 중!";
  }
}
wss.on("connection",(ws)=>{
  let client=null, room=null;
  ws.on("message",(raw)=>{
    let msg; try{msg=JSON.parse(raw.toString())}catch{return}
    if(msg.type==="join") {
      let id=String(msg.room||"").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,8);
      if(!id) id=code();
      room=rooms.get(id);
      if(!room) {room={id,clients:[],game:freshGame(),inputs:[{},{}],fxId:0};rooms.set(id,room);}
      if(room.clients.length>=2) {send(ws,{type:"error",message:"방이 가득 찼습니다. 다른 방을 만들어 주세요."});room=null;return;}
      const side=clientAt(room,0)?1:0;   // 비어 있는 자리로 입장
      const char=CHAR_KEYS.includes(msg.char)?msg.char:CHAR_KEYS[Math.floor(Math.random()*CHAR_KEYS.length)];
      client={ws,name:String(msg.name||"귀뚜라미").slice(0,12),side,char};
      room.clients.push(client);
      send(ws,{type:"joined",room:id,side});
      room.game.message=room.clients.length===2?"두 선수 준비 완료! 왼쪽 선수가 시작 버튼을 누르세요.":"상대방을 기다리는 중...";
      broadcast(room,snapshot(room));
      return;
    }
    if(!room||!client)return;
    if(msg.type==="input") {
      const inp=room.inputs[client.side]||(room.inputs[client.side]={});
      ["up","down","left","right"].forEach(k=>inp[k]=!!msg.keys?.[k]);
      if(msg.hit){inp.hit=true;inp.skill=SKILLS.includes(msg.skill)?msg.skill:"normal";}
      if(msg.serve) inp.serve=true;
    }
    const g=room.game;
    const hostStart=client.side===0 && room.clients.length===2 && ["ready","point","finished"].includes(g.status);
    if(msg.type==="start" && hostStart) {
      if(g.status==="finished"){room.game=freshGame();room.inputs=[{},{}];}
      resetPoint(room);
    }
    // R 키: 포인트 종료 후에는 누구나 바로 다음 서브로, 경기 시작·새 경기는 호스트만
    if(msg.type==="next" && room.clients.length===2) {
      if(g.status==="point") resetPoint(room);
      else if(hostStart) {
        if(g.status==="finished"){room.game=freshGame();room.inputs=[{},{}];}
        resetPoint(room);
      }
    }
    broadcast(room,snapshot(room));
  });
  ws.on("close",()=>{
    if(room&&client){
      room.clients=room.clients.filter(c=>c!==client);
      room.game.status="waiting";room.game.ball.active=false;
      room.game.message="상대방이 나갔습니다. 새 선수를 기다리는 중...";
      broadcast(room,snapshot(room));
      if(room.clients.length===0)rooms.delete(room.id);
    }
  });
});
setInterval(()=>{for(const room of rooms.values()){tick(room);if(room.clients.length)broadcast(room,snapshot(room));}},1000/30);
server.listen(PORT,()=>console.log(`Cricket Tennis running on ${PORT}`));
