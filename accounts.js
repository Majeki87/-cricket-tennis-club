// 서버 계정: 닉네임 + 숫자 비밀번호(4~8자리), 고른 선수·코트, 전적(승패)
// 저장소는 DATABASE_URL(Neon 등 Postgres)이 있으면 데이터베이스, 없으면 계정 기능을 끔(화면은 기기 저장 방식으로 동작)
// ACCOUNTS_MEMORY=1 이면 서버 메모리에 저장(시험용 — 서버가 재시작하면 지워짐)
const crypto = require("crypto");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ct_users (
  nick_key   TEXT PRIMARY KEY,
  nick       TEXT NOT NULL,
  salt       TEXT NOT NULL,
  pin_hash   TEXT NOT NULL,
  fav_char   TEXT,
  fav_court  TEXT NOT NULL DEFAULT 'hard',
  wins       INTEGER NOT NULL DEFAULT 0,
  losses     INTEGER NOT NULL DEFAULT 0,
  imported   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS ct_matches (
  id        BIGSERIAL PRIMARY KEY,
  played_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  p0_key    TEXT,
  p1_key    TEXT,
  p0_name   TEXT NOT NULL,
  p1_name   TEXT NOT NULL,
  p0_char   TEXT,
  p1_char   TEXT,
  court     TEXT,
  format    TEXT,
  winner    SMALLINT NOT NULL,
  score     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ct_matches_p0 ON ct_matches (p0_key, played_at DESC);
CREATE INDEX IF NOT EXISTS ct_matches_p1 ON ct_matches (p1_key, played_at DESC);`;

const keyOf = nick => String(nick || "").trim().toLowerCase();
const pub = r => r && { nick: r.nick, char: r.fav_char || null, court: r.fav_court || "hard", w: r.wins | 0, l: r.losses | 0 };

function pgStore(pool) {
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0] || null;
  return {
    kind: "postgres",
    get: key => one("SELECT * FROM ct_users WHERE nick_key = $1", [key]),
    create: u => one("INSERT INTO ct_users (nick_key, nick, salt, pin_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (nick_key) DO NOTHING RETURNING *", [u.key, u.nick, u.salt, u.hash]),
    touch: key => one("UPDATE ct_users SET last_login = now() WHERE nick_key = $1 RETURNING *", [key]),
    prefs: (key, p) => one("UPDATE ct_users SET fav_char = COALESCE($2, fav_char), fav_court = COALESCE($3, fav_court) WHERE nick_key = $1 RETURNING *", [key, p.char ?? null, p.court ?? null]),
    result: (key, win) => one("UPDATE ct_users SET wins = wins + $2, losses = losses + $3 WHERE nick_key = $1 RETURNING *", [key, win ? 1 : 0, win ? 0 : 1]),
    importStats: (key, w, l) => one("UPDATE ct_users SET wins = $2, losses = $3, imported = TRUE WHERE nick_key = $1 AND NOT imported AND wins = 0 AND losses = 0 RETURNING *", [key, w, l]),
    top: n => pool.query("SELECT nick, wins, losses FROM ct_users WHERE wins + losses > 0 ORDER BY wins DESC, losses ASC LIMIT $1", [n]).then(r => r.rows),
    addMatch: m => one("INSERT INTO ct_matches (p0_key, p1_key, p0_name, p1_name, p0_char, p1_char, court, format, winner, score) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id", [m.k[0], m.k[1], m.n[0], m.n[1], m.c[0], m.c[1], m.court, m.format, m.winner, m.score]),
    history: (key, n) => pool.query("SELECT * FROM ct_matches WHERE p0_key = $1 OR p1_key = $1 ORDER BY played_at DESC LIMIT $2", [key, n]).then(r => r.rows)
  };
}
function memStore() {
  const m = new Map(), matches = [];
  return {
    kind: "memory",
    get: async key => m.get(key) || null,
    create: async u => { if (m.has(u.key)) return null; const r = { nick_key: u.key, nick: u.nick, salt: u.salt, pin_hash: u.hash, fav_char: null, fav_court: "hard", wins: 0, losses: 0, imported: false }; m.set(u.key, r); return r; },
    touch: async key => m.get(key) || null,
    prefs: async (key, p) => { const r = m.get(key); if (!r) return null; if (p.char != null) r.fav_char = p.char; if (p.court != null) r.fav_court = p.court; return r; },
    result: async (key, win) => { const r = m.get(key); if (!r) return null; win ? r.wins++ : r.losses++; return r; },
    importStats: async (key, w, l) => { const r = m.get(key); if (!r || r.imported || r.wins || r.losses) return null; Object.assign(r, { wins: w, losses: l, imported: true }); return r; },
    top: async n => [...m.values()].filter(r => r.wins + r.losses).sort((a, b) => b.wins - a.wins || a.losses - b.losses).slice(0, n).map(r => ({ nick: r.nick, wins: r.wins, losses: r.losses })),
    addMatch: async x => { const r = { id: matches.length + 1, played_at: new Date(), p0_key: x.k[0], p1_key: x.k[1], p0_name: x.n[0], p1_name: x.n[1], p0_char: x.c[0], p1_char: x.c[1], court: x.court, format: x.format, winner: x.winner, score: x.score }; matches.push(r); return r; },
    history: async (key, n) => matches.filter(r => r.p0_key === key || r.p1_key === key).slice(-n).reverse()
  };
}

function setupAccounts(app, express, { chars, courts }) {
  let store = null;
  const secret = process.env.SESSION_SECRET || crypto.createHash("sha256").update("cricket|" + (process.env.DATABASE_URL || "memory")).digest("hex");
  const ready = (async () => {
    const url = process.env.DATABASE_URL;
    if (url) {
      try {
        const { Pool } = require("pg");
        const pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30000, ssl: /sslmode=/.test(url) ? undefined : { rejectUnauthorized: true } });
        pool.on("error", e => console.error("계정 DB 오류:", e.message));
        await pool.query(SCHEMA);
        store = pgStore(pool);
      } catch (e) { console.error("계정 DB 연결 실패 — 기기 저장 방식으로 동작합니다:", e.message); store = null; }
    }
    if (!store && process.env.ACCOUNTS_MEMORY === "1") store = memStore();
    console.log("계정 저장소:", store ? store.kind + " 연결됨" : "없음(기기 저장 방식)");
  })();

  // 로그인 토큰: 서버 비밀키로 서명(데이터베이스를 매번 찾지 않아도 됨), 60일 유효
  const sign = key => { const exp = Date.now() + 60 * 864e5, body = Buffer.from(JSON.stringify({ k: key, e: exp })).toString("base64url");
    return body + "." + crypto.createHmac("sha256", secret).update(body).digest("base64url"); };
  const verify = tok => { try { const [body, sig] = String(tok || "").split("."); if (!body || !sig) return null;
    const good = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    const d = JSON.parse(Buffer.from(body, "base64url").toString()); return d.e > Date.now() ? d.k : null; } catch { return null; } };
  const hashPin = (pin, salt) => new Promise((ok, no) => crypto.scrypt(pin, salt, 32, (e, k) => e ? no(e) : ok(k.toString("hex"))));

  // 비밀번호 마구 넣어 보기 방지: 닉네임별 5번 틀리면 1분, 같은 곳(IP)에서 20번 틀리면 10분 잠금
  const fails = new Map();
  const locked = k => { const f = fails.get(k); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; };
  const fail = (k, max, ms) => { const f = fails.get(k) || { n: 0, until: 0 }; f.n++; if (f.n >= max) { f.until = Date.now() + ms; f.n = 0; } fails.set(k, f); };
  setInterval(() => { const now = Date.now(); for (const [k, f] of fails) if (f.until < now && f.n === 0) fails.delete(k); }, 600000).unref();

  const api = express.Router();
  api.use(express.json({ limit: "4kb" }));
  api.use(async (req, res, next) => { await ready; res.set("Cache-Control", "no-store"); next(); });
  const auth = (req, res, next) => { const k = verify((req.get("authorization") || "").replace(/^Bearer\s+/i, "")); if (!k) return res.status(401).json({ error: "다시 로그인해 주세요." }); req.key = k; next(); };
  const need = (req, res, next) => store ? next() : res.status(503).json({ error: "서버 계정을 쓸 수 없어요." });
  const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error("계정 처리 오류:", e.message); res.status(500).json({ error: "잠시 후 다시 시도해 주세요." }); });

  api.get("/status", (req, res) => res.json({ accounts: !!store }));
  api.post("/login", need, wrap(async (req, res) => {
    const nick = String(req.body?.nick || "").trim().slice(0, 12), pin = String(req.body?.pin || ""), key = keyOf(nick), ip = "ip:" + (req.ip || "");
    if (nick.length < 2) return res.status(400).json({ error: "닉네임은 2글자 이상으로 적어 주세요." });
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: "비밀번호는 숫자 4~8자리예요." });
    const wait = Math.max(locked(key), locked(ip));
    if (wait) return res.status(429).json({ error: `비밀번호를 여러 번 틀렸어요. ${wait}초 뒤에 다시 시도해 주세요.` });
    let row = await store.get(key), created = false;
    if (row) {
      if (await hashPin(pin, row.salt) !== row.pin_hash) { fail(key, 5, 60000); fail(ip, 20, 600000); return res.status(401).json({ error: "비밀번호가 맞지 않아요. 다시 확인해 주세요." }); }
    } else {
      const salt = crypto.randomBytes(16).toString("hex");
      row = await store.create({ key, nick, salt, hash: await hashPin(pin, salt) });
      if (!row) return res.status(409).json({ error: "같은 닉네임이 방금 만들어졌어요. 다시 시도해 주세요." });
      created = true;
    }
    fails.delete(key);
    row = (await store.touch(key)) || row;
    res.json({ token: sign(key), user: pub(row), created });
  }));
  api.get("/me", need, auth, wrap(async (req, res) => { const r = await store.get(req.key); r ? res.json({ user: pub(r) }) : res.status(401).json({ error: "계정을 찾을 수 없어요." }); }));
  api.post("/prefs", need, auth, wrap(async (req, res) => {
    const p = {}; if (chars.includes(req.body?.char)) p.char = req.body.char; if (courts.includes(req.body?.court)) p.court = req.body.court;
    const r = await store.prefs(req.key, p); r ? res.json({ user: pub(r) }) : res.status(404).json({ error: "계정을 찾을 수 없어요." });
  }));
  // 이 기기에 저장돼 있던 같은 닉네임의 전적을 처음 한 번만 옮겨 옴
  api.post("/import", need, auth, wrap(async (req, res) => {
    const w = Math.max(0, Math.min(999, req.body?.w | 0)), l = Math.max(0, Math.min(999, req.body?.l | 0));
    const r = await store.importStats(req.key, w, l); res.json({ imported: !!r, user: pub(r || await store.get(req.key)) });
  }));
  api.get("/top", need, wrap(async (req, res) => res.json({ top: await store.top(10) })));
  // 내 최근 실시간 대전 기록(내 쪽에서 본 결과로 바꿔서 보냄)
  api.get("/history", need, auth, wrap(async (req, res) => {
    const rows = await store.history(req.key, 30);
    res.json({ list: rows.map(r => { const me = r.p0_key === req.key ? 0 : 1, op = 1 - me; let sc = []; try { sc = JSON.parse(r.score); } catch {}
      return { at: new Date(r.played_at).getTime(), win: Number(r.winner) === me, opp: me ? r.p0_name : r.p1_name, oppChar: me ? r.p0_char : r.p1_char, oppAcct: !!(me ? r.p0_key : r.p1_key),
        myChar: me ? r.p1_char : r.p0_char, court: r.court, format: r.format, score: sc.map(g => [g[me], g[op]]) }; }) });
  }));
  app.use("/api", api);

  return {
    verify,
    // 실시간 대전이 끝나면 서버가 직접 기록: 로그인한 선수의 승패 + 경기 기록 한 줄
    recordMatch: async m => {
      try {
        await ready; if (!store || !(m.k[0] || m.k[1])) return;
        await store.addMatch({ ...m, score: JSON.stringify(m.history || []) });
        for (const s of [0, 1]) if (m.k[s]) await store.result(m.k[s], m.winner === s);
      } catch (e) { console.error("전적 기록 실패:", e.message); }
    }
  };
}

module.exports = { setupAccounts };
