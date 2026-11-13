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

function code() { return crypto.randomBytes(3).toString("hex").toUpperCase(); }
function freshGame() {
  return { score:[0,0], players:[{x:50,y:79},{x:50,y:21}],
    ball:{x:50,y:50,vx:0,vy:0,active:false,hit:0,kind:"normal"}, status:"waiting", serveSide:0,
    message:"두 명이 입장하면 경기를 시작할 수 있습니다.", pointAt:0, winner:null };
}
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) { room.clients.forEach(c => send(c.ws,obj)); }
function snapshot(room) {
  return {type:"state", room:room.id, players:room.game.players, ball:room.game.ball, serveSide:room.game.serveSide,
    score:room.game.score, status:room.game.status, message:room.game.message,
    winner:room.game.winner, names:room.clients.map(c=>c.name)};
}
function resetPoint(room) {
  const g=room.game;
  g.serveSide=Math.random()<.5 ? 0 : 1;
  const server=g.players[g.serveSide];
  g.ball={x:server.x,y:g.serveSide===0?server.y-10:server.y+10,vx:0,vy:0,active:false,hit:0};
  g.message=(g.serveSide===0?"왼쪽":"오른쪽")+" 선수의 서브 차례! 강서브 버튼을 누르세요.";
  g.status="serve";
}

function scorePoint(room, side) {
  const g=room.game;
  g.score[side]++;
  g.ball.active=false;
  g.message=(side===0?"왼쪽":"오른쪽")+" 선수 득점!";
  if(g.score[side]>=5) {
    g.status="finished"; g.winner=side;
    g.message=(side===0?"왼쪽":"오른쪽")+" 선수 우승!";
  } else {
    g.status="point"; g.pointAt=Date.now()+1300;
  }
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
        g.ball={x:server.x,y:i===0?server.y-10:server.y+10,vx:(Math.random()-.5)*.42,vy:i===0?-1.25:1.25,active:true,hit:1-i};
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
  const dt=1;
  for(let i=0;i<2;i++) {
    const p=g.players[i], inp=room.inputs[i];
    const dx=(inp.right?1:0)-(inp.left?1:0);
    const dy=(inp.down?1:0)-(inp.up?1:0);
    const mag=Math.hypot(dx,dy)||1;
    p.x=Math.max(10,Math.min(90,p.x+dx/mag*.78));
    p.y=i===0?Math.max(53,Math.min(91,p.y+dy/mag*.78)):Math.max(9,Math.min(47,p.y+dy/mag*.78));
    if(inp.hit) {
      const b=g.ball;
      if(b.active && Math.hypot(p.x-b.x,p.y-b.y)<(inp.skill==="volley"?22:18) && b.hit===i) {
        const skill=["volley","drop","speed"].includes(inp.skill)?inp.skill:"normal";
        b.hit=1-i;
        b.vx=skill==="drop"?Math.max(-.32,Math.min(.32,(b.x-p.x)*.018)):Math.max(-.9,Math.min(.9,(b.x-p.x)*.035+(Math.random()-.5)*.12));
        const velocity=skill==="speed"?1.48:skill==="volley"?1.08:skill==="drop"?.40:.78;
        b.vy=i===0?-velocity:velocity; b.kind=skill;
        g.message=skill==="volley"?"🏐 발리샷!":skill==="drop"?"🪶 드롭샷!":skill==="speed"?"💥 스피드샷!":"멋진 리턴!";
      }
      inp.hit=false; inp.skill="normal";
    }
  }
  const b=g.ball;
  b.x+=b.vx; b.y+=b.vy; b.vy+=b.vy>0?.003:-.003;
  if(b.x<8||b.x>92){b.vx*=-.88;b.x=Math.max(8,Math.min(92,b.x));}
  if(b.y<4){scorePoint(room,0);return;}
  if(b.y>96){scorePoint(room,1);return;}
  // A ball crossing to the other side is returned when the receiving player gets close.
  const receiver=b.y<50?1:0, p=g.players[receiver];
  if(Math.hypot(p.x-b.x,p.y-b.y)<9 && b.hit===receiver) {
    b.hit=1-receiver;
    b.vx=Math.max(-.72,Math.min(.72,(b.x-p.x)*.035+(Math.random()-.5)*.22));
    b.vy=receiver===0?-.76:.76;
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
      if(!room) {room={id,clients:[],game:freshGame(),inputs:[{},{}]};rooms.set(id,room);}
      if(room.clients.length>=2) {send(ws,{type:"error",message:"방이 가득 찼습니다. 다른 방을 만들어 주세요."});return;}
      client={ws,name:String(msg.name||"귀뚜라미").slice(0,12),side:room.clients.length};
      room.clients.push(client);
      send(ws,{type:"joined",room:id,side:client.side});
      room.game.message=room.clients.length===2?"두 선수 준비 완료! 왼쪽 선수가 시작 버튼을 누르세요.":"상대방을 기다리는 중...";
      broadcast(room,snapshot(room));
      return;
    }
    if(!room||!client)return;
    if(msg.type==="input") {
      const inp=room.inputs[client.side]||(room.inputs[client.side]={});
      ["up","down","left","right"].forEach(k=>inp[k]=!!msg.keys?.[k]);
      inp.hit=!!msg.hit;
      inp.skill=["volley","drop","speed"].includes(msg.skill)?msg.skill:"normal";
      inp.serve=!!msg.serve;
    }
    if(msg.type==="start" && client.side===0 && room.clients.length===2 && ["ready","point","finished"].includes(room.game.status)) {
      if(room.game.status==="finished"){room.game=freshGame();room.inputs=[{},{}];}
      resetPoint(room);
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
