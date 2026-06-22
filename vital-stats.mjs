/**
 * Vital Rust → Discord трекер (версія для GitHub Actions).
 * Запускається за розкладом (cron) у хмарі GitHub — 24/7, без твого ПК.
 *
 * Налаштування беруться зі змінних середовища (Secrets/Variables репозиторію):
 *   DISCORD_WEBHOOK_URL (обовʼязково), THREAD_ID, STEAM_IDS, SERVER_IDS, MODE, TITLE
 * Якщо змінних немає — використовуються значення з блоку CONFIG нижче.
 *
 * ID повідомлення Discord зберігається у файлі state.json (його комітить workflow),
 * щоб щоразу ОНОВЛЮВАТИ одне й те саме повідомлення, а не слати нове.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const CONFIG = {
  DISCORD_WEBHOOK_URL: "",            // краще задати через Secret, а не тут
  THREAD_ID: "",                      // ID гілки Discord або ""
  STEAM_IDS: ["76561199882333814"],  // Steam ID гравців (SteamID64)
  SERVER_IDS: [16, 19],              // 1 AU10x 2 EU10x 3 US10x 4 EUMon 16 EUMonthly 19 EUMedium 23 USMonthly
  MODE: "sum",                       // "sum" або "perServer"
  TITLE: "📊 Vital Rust — статистика відстежуваних гравців",
};

const STATS_API = "https://playerstatistics.vitalgamenetwork.com";
const STATE_FILE = "state.json";
const SERVER_NAMES = {
  1: "AU 10x", 2: "EU 10x", 3: "US 10x", 4: "EU Mondays",
  16: "EU Monthly", 19: "EU Medium", 23: "US Monthly",
};
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ───────────────────────── конфіг ─────────────────────────
function resolveConfig() {
  const e = process.env;
  const list = (s) => String(s).split(/[\s,]+/).filter(Boolean);
  return {
    DISCORD_WEBHOOK_URL: e.DISCORD_WEBHOOK_URL || CONFIG.DISCORD_WEBHOOK_URL,
    THREAD_ID: e.THREAD_ID || CONFIG.THREAD_ID,
    STEAM_IDS: e.STEAM_IDS ? list(e.STEAM_IDS) : CONFIG.STEAM_IDS,
    SERVER_IDS: e.SERVER_IDS ? list(e.SERVER_IDS).map(Number).filter(Boolean) : CONFIG.SERVER_IDS,
    MODE: e.MODE || CONFIG.MODE,
    TITLE: e.TITLE || CONFIG.TITLE,
  };
}

// ───────────────────────── основна логіка ─────────────────────────
async function main() {
  const cfg = resolveConfig();
  if (!cfg.DISCORD_WEBHOOK_URL) throw new Error("Не задано DISCORD_WEBHOOK_URL (Secret репозиторію).");

  const rows = [];
  for (const serverId of cfg.SERVER_IDS) {
    const wipeId = await getCurrentWipeId(serverId);
    const players = await getPlayers(serverId, wipeId);
    const byId = indexBySteamId(players);
    for (const sid of cfg.STEAM_IDS) {
      const p = byId.get(String(sid));
      if (!p) continue;
      rows.push({ serverId, sid: String(sid), name: pickName(p, sid), stats: extractStats(p) });
    }
  }

  let tableRows;
  if (cfg.MODE === "perServer") {
    tableRows = rows.map((r) => ({ label: `${r.name} · ${SERVER_NAMES[r.serverId] || r.serverId}`, stats: r.stats }));
  } else {
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.sid)) map.set(r.sid, { name: r.name, stats: zeroStats() });
      const acc = map.get(r.sid);
      acc.name = r.name;
      addStats(acc.stats, r.stats);
    }
    tableRows = [];
    for (const sid of cfg.STEAM_IDS) {
      const e = map.get(String(sid));
      if (e) tableRows.push({ label: e.name, stats: e.stats });
    }
  }

  const content = renderMessage(cfg, tableRows);
  await upsertDiscordMessage(cfg, content);
  console.log("OK, оновлено гравців:", tableRows.length);
}

async function getCurrentWipeId(serverId) {
  const j = await apiGet(`${STATS_API}/servers/${serverId}/wipes`);
  const arr = (j && (j.data || j)) || [];
  if (!arr.length) throw new Error(`Немає вайпів для сервера ${serverId}`);
  const open = arr.find((w) => !w.endTime);
  const chosen = open || arr.slice().sort((a, b) => new Date(b.startTime) - new Date(a.startTime))[0];
  return chosen.id;
}
async function getPlayers(serverId, wipeId) {
  const j = await apiPost(`${STATS_API}/players/overview`, { serverId, wipeId });
  return (j && (j.data || j.players || j.items || j)) || [];
}

// ───────────────────────── розбір полів гравця ─────────────────────────
function flatten(obj, prefix = "", out = {}) {
  if (obj == null || typeof obj !== "object") return out;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const path = prefix ? prefix + "." + k : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, path, out);
    else out[path] = v;
  }
  return out;
}
const toNum = (v) => { const n = typeof v === "string" ? Number(v) : v; return Number.isFinite(n) ? n : 0; };
function bySuffix(flat, suffix, excludeRe) {
  const s = suffix.toLowerCase();
  for (const key of Object.keys(flat)) {
    const lk = key.toLowerCase();
    if (excludeRe && excludeRe.test(lk)) continue;
    if (lk === s || lk.endsWith("." + s)) return toNum(flat[key]);
  }
  return 0;
}
function byContains(flat, parts, excludeRe) {
  for (const key of Object.keys(flat)) {
    const lk = key.toLowerCase();
    if (excludeRe && excludeRe.test(lk)) continue;
    if (parts.every((p) => lk.includes(p))) return toNum(flat[key]);
  }
  return 0;
}
function extractStats(player) {
  const f = flatten(player);
  const killsT3 = bySuffix(f, "killsT3") || byContains(f, ["kills", "t3"]) || byContains(f, ["kills", "tier3"]);
  const deathsT3 = bySuffix(f, "deathsT3") || byContains(f, ["deaths", "t3"]) || byContains(f, ["deaths", "tier3"]);
  const kills = bySuffix(f, "kills", /(t3|tier3|npc|animal|scientist|heli|bradley)/);
  const deaths = bySuffix(f, "deaths", /(t3|tier3)/);
  const sulfur = byContains(f, ["sulfur"], /refined|fragment/);
  const metal = byContains(f, ["metal.ore"]) || byContains(f, ["metal", "ore"], /hq|high|refined|fragment/);
  const scrap = byContains(f, ["looted", "scrap"]) || bySuffix(f, "scrap", /wagered|won|recycl/);
  const rockets = byContains(f, ["raiding", "rockets"], /high|velocity|incend/) || bySuffix(f, "rockets", /high|velocity|incend/) || byContains(f, ["rocketsfired"]);
  return { killsT3, deathsT3, kills, deaths, sulfur, metal, scrap, rockets };
}
function zeroStats() { return { killsT3: 0, deathsT3: 0, kills: 0, deaths: 0, sulfur: 0, metal: 0, scrap: 0, rockets: 0 }; }
function addStats(a, b) { for (const k of Object.keys(a)) a[k] += b[k] || 0; }
function indexBySteamId(players) {
  const m = new Map();
  for (const p of players) {
    const f = flatten(p);
    let sid = null;
    for (const key of Object.keys(f)) { const v = String(f[key]); if (/^7656\d{13}$/.test(v) && /(userid|steam|id)/i.test(key)) { sid = v; break; } }
    if (!sid) for (const key of Object.keys(f)) { const v = String(f[key]); if (/^7656\d{13}$/.test(v)) { sid = v; break; } }
    if (sid) m.set(sid, p);
  }
  return m;
}
function pickName(player, fallbackSid) {
  const f = flatten(player);
  for (const key of Object.keys(f)) {
    if (/(displayname|username|name|nickname)/i.test(key) && typeof f[key] === "string" && f[key].trim()) return f[key].trim();
  }
  return String(fallbackSid);
}

// ───────────────────────── формат Discord ─────────────────────────
function human(n) {
  n = Math.round(n);
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(n % 1000 === 0 ? 0 : 1) + "k";
  return String(n);
}
function kd(k, d) { if (!d) return k ? k.toFixed(2) : "0.00"; return (k / d).toFixed(2); }
function pad(s, w) { s = String(s); if (s.length > w) s = s.slice(0, w - 1) + "…"; return s + " ".repeat(Math.max(0, w - s.length)); }
function renderMessage(cfg, rows) {
  const W = { name: 15, t3k: 6, t3d: 6, t3kd: 7, k: 6, d: 6, sulf: 8, met: 8, scr: 8, rkt: 7 };
  const head = pad("Гравець", W.name) + pad("T3K", W.t3k) + pad("T3D", W.t3d) + pad("T3KD", W.t3kd) +
    pad("Кіл", W.k) + pad("См", W.d) + pad("Сірка", W.sulf) + pad("Метал", W.met) + pad("Скрап", W.scr) + pad("Ракет", W.rkt);
  const sep = "─".repeat(head.length);
  const lines = rows.map((r) => {
    const s = r.stats;
    return pad(r.label, W.name) + pad(human(s.killsT3), W.t3k) + pad(human(s.deathsT3), W.t3d) + pad(kd(s.killsT3, s.deathsT3), W.t3kd) +
      pad(human(s.kills), W.k) + pad(human(s.deaths), W.d) + pad(human(s.sulfur), W.sulf) + pad(human(s.metal), W.met) +
      pad(human(s.scrap), W.scr) + pad(human(s.rockets), W.rkt);
  });
  const body = rows.length
    ? "```\n" + head + "\n" + sep + "\n" + lines.join("\n") + "\n```"
    : "_Жоден з доданих Steam ID не знайдений на обраних серверах цього вайпу._";
  const servers = cfg.SERVER_IDS.map((id) => SERVER_NAMES[id] || id).join(", ");
  const when = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return `**${cfg.TITLE}**\nСервери: ${servers} · Режим: ${cfg.MODE === "sum" ? "сума" : "по серверах"} · Оновлено: ${when}\n` + body;
}

// ───────────────────────── Discord (одне повідомлення, що оновлюється) ─────────────────────────
function loadState() { try { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {}; } catch { return {}; } }
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function upsertDiscordMessage(cfg, content) {
  const base = cfg.DISCORD_WEBHOOK_URL;
  const threadQ = cfg.THREAD_ID ? `?thread_id=${cfg.THREAD_ID}` : "";
  const stateKey = "msg_" + (cfg.THREAD_ID || "main");
  const state = loadState();
  const messageId = state[stateKey];

  if (messageId) {
    const res = await fetch(`${base}/messages/${messageId}${threadQ}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }),
    });
    if (res.ok) return;
    if (res.status !== 404) throw new Error(`Discord PATCH ${res.status}: ${await res.text()}`);
  }
  const createUrl = `${base}${threadQ ? threadQ + "&" : "?"}wait=true`;
  const res = await fetch(createUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
  if (!res.ok) throw new Error(`Discord POST ${res.status}: ${await res.text()}`);
  const msg = await res.json();
  if (msg && msg.id) { state[stateKey] = msg.id; saveState(state); }
}

// ───────────────────────── HTTP ─────────────────────────
async function apiGet(url) {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": UA } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function apiPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": UA },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} (${JSON.stringify(body)}) → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
