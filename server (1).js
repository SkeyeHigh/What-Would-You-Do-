const http = require("http"), fs = require("fs"), path = require("path");
const { WebSocketServer } = require("ws");

const MAX = 10, MIN = 3;
const rooms = new Map();
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const fresh = () => ({ text: "", done: false, addText: "", addDone: false });

const TYPES = { ".html": "text/html; charset=utf-8", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/healthz") return res.end("ok");
  const file = url === "/face.png" ? "face.png" : "index.html";
  fs.readFile(path.join(__dirname, file), (e, d) => {
    if (e) { res.writeHead(500); return res.end("Missing " + file); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] });
    res.end(d);
  });
});
const wss = new WebSocketServer({ server });

const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

function view(r, me) {
  const rev = r.phase === "reveal", isA = r.author === me;
  const resp = r.ids.filter(i => i !== r.author);
  const answers = {};
  resp.forEach(i => { const p = r.players[i]; answers[i] = { done: p.done, text: (isA || rev || i === me) ? p.text : null }; });
  const adds = {};
  Object.keys(r.pairs).forEach(rc => { const p = r.players[rc]; adds[rc] = { giver: r.pairs[rc], done: p.addDone, text: (isA || rev || rc === me) ? p.addText : null }; });
  const g = r.pairs[me], mp = r.players[me];
  return {
    code: r.code, phase: r.phase, round: r.round, host: r.host, author: r.author, hypo: r.hypo, ids: r.ids, me,
    players: Object.entries(r.players).map(([id, p]) => ({ id, name: p.name, on: !!p.ws })),
    answers, adds, giverText: g ? r.players[g].text : null,
    mine: mp ? { text: mp.text, addText: mp.addText, done: mp.done, addDone: mp.addDone } : null
  };
}

function broadcast(r) {
  r.last = Date.now();
  Object.entries(r.players).forEach(([id, p]) => send(p.ws, { t: "state", s: view(r, id) }));
}

function check(r) {
  const resp = r.ids.filter(i => i !== r.author);
  if (r.phase === "respond" && resp.every(i => r.players[i].done)) {
    const sh = shuffle(resp), pr = {};
    for (let i = 0; i < sh.length; i += 2) {
      if (sh[i + 1]) { if (Math.random() < .5) pr[sh[i]] = sh[i + 1]; else pr[sh[i + 1]] = sh[i]; }
      else { const o = sh.slice(0, -1); pr[sh[i]] = o[Math.floor(Math.random() * o.length)]; }
    }
    r.pairs = pr; r.phase = "addon";
  }
  if (r.phase === "addon" && Object.keys(r.pairs).every(i => r.players[i].addDone)) r.phase = "reveal";
}

function newRound(r, author) {
  r.round++; r.author = author; r.hypo = ""; r.pairs = {}; r.phase = "hypo";
  r.ids.forEach(i => Object.assign(r.players[i], fresh()));
}

function attach(ws, r, id, name) {
  const old = r.players[id];
  if (old && old.ws && old.ws !== ws) { try { old.ws.close(); } catch (e) {} }
  r.players[id] = old ? Object.assign(old, { ws, name }) : Object.assign({ name, ws }, fresh());
  ws.pid = id; ws.code = r.code;
}

wss.on("connection", ws => {
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const err = text => send(ws, { t: "error", text });
    const id = String(m.id || "").slice(0, 40), name = String(m.name || "Player").trim().slice(0, 14) || "Player";

    if (m.t === "create") {
      let code; do { code = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]).join(""); } while (rooms.has(code));
      const r = { code, host: id, phase: "lobby", round: 0, ids: [], author: "", hypo: "", pairs: {}, players: {}, last: Date.now() };
      rooms.set(code, r); attach(ws, r, id, name); return broadcast(r);
    }
    if (m.t === "join") {
      const r = rooms.get(String(m.code || "").toUpperCase());
      if (!r) return err("No room with that code.");
      if (!r.players[id]) {
        if (r.phase !== "lobby") return err("That game has already started.");
        if (Object.keys(r.players).length >= MAX) return err("That room is full (10 players).");
      }
      attach(ws, r, id, name); return broadcast(r);
    }
    if (m.t === "rejoin") {
      const r = rooms.get(m.code);
      if (!r || !r.players[id]) return send(ws, { t: "gone" });
      attach(ws, r, id, r.players[id].name); return broadcast(r);
    }

    const r = rooms.get(ws.code); if (!r) return;
    const me = ws.pid, p = r.players[me]; if (!p) return;
    const isHost = r.host === me;

    if (m.t === "start" && isHost && r.phase === "lobby") {
      const ids = Object.keys(r.players); if (ids.length < MIN) return;
      r.ids = shuffle(ids); newRound(r, r.ids[0]); r.round = 1;
    } else if (m.t === "hypo" && r.phase === "hypo" && r.author === me) {
      const t = String(m.text || "").trim().slice(0, 200); if (!t) return;
      r.hypo = t; r.phase = "respond";
    } else if (m.t === "type") {
      const t = String(m.text || "").slice(0, 400);
      if (m.field === "text" && r.phase === "respond" && me !== r.author && !p.done) p.text = t;
      else if (m.field === "addText" && r.phase === "addon" && r.pairs[me] && !p.addDone) p.addText = t;
      else return;
    } else if (m.t === "done") {
      if (m.field === "text" && r.phase === "respond" && me !== r.author && p.text.trim()) p.done = true;
      else if (m.field === "addText" && r.phase === "addon" && r.pairs[me] && p.addText.trim()) p.addDone = true;
      else return;
      check(r);
    } else if (m.t === "skip" && isHost) {
      if (r.phase === "respond") r.ids.filter(i => i !== r.author).forEach(i => { const q = r.players[i]; if (!q.done) { if (!q.text.trim()) q.text = "(no answer)"; q.done = true; } });
      if (r.phase === "addon") Object.keys(r.pairs).forEach(i => { const q = r.players[i]; if (!q.addDone) { if (!q.addText.trim()) q.addText = "(no add-on)"; q.addDone = true; } });
      check(r);
    } else if (m.t === "next" && isHost && r.phase === "reveal") {
      newRound(r, r.ids[(r.ids.indexOf(r.author) + 1) % r.ids.length]);
    } else return;
    broadcast(r);
  });
  ws.on("close", () => {
    const r = rooms.get(ws.code);
    if (r && r.players[ws.pid] && r.players[ws.pid].ws === ws) { r.players[ws.pid].ws = null; broadcast(r); }
  });
});

setInterval(() => { const now = Date.now(); rooms.forEach((r, c) => { if (now - r.last > 3 * 3600e3) rooms.delete(c); }); }, 600e3);
setInterval(() => wss.clients.forEach(c => send(c, { t: "ping" })), 25e3);

server.listen(process.env.PORT || 3000, () => console.log("Running on port " + (process.env.PORT || 3000)));
