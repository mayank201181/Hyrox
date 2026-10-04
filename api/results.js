import { put, get, list, del } from "@vercel/blob";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// One private JSON blob per person, keyed by a slug of their name.
const PREFIX = "hyrox/results/";
const MAX_PEOPLE = 30;

// Owner passcode for GET, DELETE and PUT. A passcode set through PUT is stored
// as a salted scrypt hash in the private Blob store, never in this public repo.
// Until one is set, RESULTS_KEY (if present) or the long built-in passcode
// hashed below is accepted.
const KEY_SALT = "f854d3cc911b5c89f1e93d36f219c692";
const KEY_HASH = "0cad7a4ece5a03c629b9dadf112c40fe2193f0ae6facc9804c8bb3a8dd8b6ed5";
const PASSCODE_PATH = "hyrox/config/passcode.json";

// Every wrong passcode leaves a marker blob. After MAX_FAILS in the last hour
// all passcodes are refused until the oldest marker ages out.
const FAIL_PREFIX = "hyrox/guard/";
const MAX_FAILS = 30;
const WINDOW_MS = 60 * 60 * 1000;

// Question index -> quality. Must match QUESTIONS in index.html.
const PILLAR_OF = ["engine", "engine", "strength", "strength", "stamina", "stamina", "recovery", "recovery", "durability", "durability"];
const PILLARS = ["engine", "strength", "stamina", "recovery", "durability"];

function cleanName(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

function slugify(name) {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "n-" + createHash("sha1").update(name.toLowerCase()).digest("hex").slice(0, 12);
}

// Same rules as verdictFor() in index.html.
function score(answers) {
  const pillars = Object.fromEntries(PILLARS.map((k) => [k, 0]));
  answers.forEach((a, i) => { pillars[PILLAR_OF[i]] += a; });
  const total = PILLARS.reduce((sum, k) => sum + pillars[k], 0);
  let verdict = "notyet";
  if (total >= 20 && pillars.engine >= 4) verdict = "ready";
  else if (total >= 13) verdict = "close";
  else if (total >= 7) verdict = "team";
  return { pillars, total, verdict };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseBody(req) {
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  return body || {};
}

async function readJson(pathname) {
  const r = await get(pathname, { access: "private", useCache: false });
  if (!r || r.statusCode !== 200) return null;
  return JSON.parse(await new Response(r.stream).text());
}

async function putJson(pathname, value) {
  await put(pathname, JSON.stringify(value), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60
  });
}

async function listBlobs(prefix) {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    out.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function listPathnames() {
  return (await listBlobs(PREFIX)).map((b) => b.pathname);
}

function hashMatches(given, saltHex, hashHex) {
  return timingSafeEqual(scryptSync(given, Buffer.from(saltHex, "hex"), 32), Buffer.from(hashHex, "hex"));
}

async function recentFails(now) {
  const fresh = [];
  const stale = [];
  for (const b of await listBlobs(FAIL_PREFIX)) {
    (now - new Date(b.uploadedAt).getTime() < WINDOW_MS ? fresh : stale).push(b.pathname);
  }
  if (stale.length) await del(stale).catch(() => {});
  return fresh.length;
}

// Returns "ok", "bad" or "locked".
async function checkKey(req) {
  const given = String(req.headers["x-results-key"] || "").slice(0, 200);
  if (!given) return "bad";
  const now = Date.now();
  if ((await recentFails(now)) >= MAX_FAILS) return "locked";
  const stored = await readJson(PASSCODE_PATH).catch(() => null);
  let ok;
  if (stored && stored.salt && stored.hash) ok = hashMatches(given, stored.salt, stored.hash);
  else if (process.env.RESULTS_KEY) ok = hashMatches(given, KEY_SALT, scryptSync(process.env.RESULTS_KEY, Buffer.from(KEY_SALT, "hex"), 32).toString("hex"));
  else ok = hashMatches(given, KEY_SALT, KEY_HASH);
  if (ok) return "ok";
  await put(`${FAIL_PREFIX}${now}-${randomBytes(4).toString("hex")}.json`, "{}", {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false
  });
  return "bad";
}

async function authorize(req, res) {
  const status = await checkKey(req);
  if (status === "ok") return true;
  await sleep(700);
  if (status === "locked") res.status(429).json({ error: "Too many wrong passcodes. Try again in an hour." });
  else res.status(401).json({ error: "Wrong passcode." });
  return false;
}

async function save(req, res) {
  const body = parseBody(req);
  const name = cleanName(body.name);
  const answers = body.answers;
  if (name.length < 2) return res.status(400).json({ error: "Enter your name, at least 2 characters." });
  if (!Array.isArray(answers) || answers.length !== PILLAR_OF.length || !answers.every((a) => Number.isInteger(a) && a >= 0 && a <= 3)) {
    return res.status(400).json({ error: "Some answers are missing." });
  }
  const labels = Array.isArray(body.labels) && body.labels.length === answers.length
    ? body.labels.map((l) => String(l).slice(0, 120))
    : null;

  const slug = slugify(name);
  const pathname = `${PREFIX}${slug}.json`;
  const existing = await readJson(pathname);
  if (!existing) {
    const people = await listPathnames();
    if (people.length >= MAX_PEOPLE) return res.status(403).json({ error: "This group is full, so your result wasn't saved." });
  }

  const now = new Date().toISOString();
  const s = score(answers);
  const record = {
    name,
    slug,
    total: s.total,
    pillars: s.pillars,
    verdict: s.verdict,
    answers,
    labels,
    attempts: (existing?.attempts || 0) + 1,
    history: [...(existing?.history || []), { total: s.total, verdict: s.verdict, at: now }].slice(-10),
    firstAt: existing?.firstAt || now,
    updatedAt: now
  };
  await putJson(pathname, record);
  return res.status(200).json({ ok: true, name, total: s.total, verdict: s.verdict, attempts: record.attempts });
}

async function listAll(req, res) {
  if (!(await authorize(req, res))) return;
  const pathnames = await listPathnames();
  const records = (await Promise.all(pathnames.map((p) => readJson(p).catch(() => null)))).filter(Boolean);
  records.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return res.status(200).json({ results: records, max: PILLAR_OF.length * 3 });
}

async function remove(req, res) {
  if (!(await authorize(req, res))) return;
  const slug = String(req.query.slug || "");
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return res.status(400).json({ error: "Unknown person." });
  await del(`${PREFIX}${slug}.json`);
  return res.status(200).json({ ok: true });
}

// Change the owner passcode. Requires the current one in x-results-key.
async function setPasscode(req, res) {
  if (!(await authorize(req, res))) return;
  const next = String(parseBody(req).passcode || "").trim();
  if (next.length < 4 || next.length > 64) return res.status(400).json({ error: "Use 4 to 64 characters." });
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(next, Buffer.from(salt, "hex"), 32).toString("hex");
  await putJson(PASSCODE_PATH, { salt, hash, changedAt: new Date().toISOString() });
  return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    return res.status(503).json({ error: "Results storage isn't connected yet." });
  }
  try {
    if (req.method === "POST") return await save(req, res);
    if (req.method === "GET") return await listAll(req, res);
    if (req.method === "DELETE") return await remove(req, res);
    if (req.method === "PUT") return await setPasscode(req, res);
    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return res.status(405).json({ error: "Method not allowed." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "The results store had a problem." });
  }
}
