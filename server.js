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
    ball:{x:50,y:50,vx:0,vy:0,active:false,hit:0}, status:"waiting",
    message:"두 명이 입장하면 경기를 시작할 수 있습니다.", pointAt:0, winner:null };
}
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) { room.clients.forEach(c => send(c.ws,obj)); }
function snapshot(room) {
  return {type:"state", room:room.id, players:room.game.players, ball:room.game.ball,
    score:room.game.score, status:room.game.status, message:room.game.message,
    winner:room.game.winner, names:room.clients.map(c=>c.name)};
}
function resetPoint(room) {
  const g=room.game; g.ball={x:50,y:g.score[0]===g.score[1]?50:50,vx:0,vy:0,active:true,hit:0};
  const serverSide = Math.random()<.5 ? 0 : 1;
  g.ball.x=50; g.ball.y=serverSide===0?25:75;
  g.ball.vx=(Math.random()-.5)*.28;
  g.ball.vy=serverSide===0?.52:-.52;
  g.message="서브! 공을 받아쳐 보세요.";
  g.status="playing";
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
      if(b.active && Math.hypot(p.x-b.x,p.y-b.y)<14 && b.hit===i) {
        b.hit=1-i; b.vx=Math.max(-.75,Math.min(.75,(b.x-p.x)*.035+(Math.random()-.5)*.16));
        b.vy=i===0?-.78:.78;
        g.message="라켓에 맞았습니다! 멋진 리턴!";
      }
      inp.hit=false;
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
