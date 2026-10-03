import { put, get, list, del } from "@vercel/blob";
import { createHash, scryptSync, timingSafeEqual } from "node:crypto";

// One private JSON blob per person, keyed by a slug of their name.
const PREFIX = "hyrox/results/";
const MAX_PEOPLE = 30;

// Owner passcode for GET/DELETE. Only a salted scrypt hash lives here; set a
// RESULTS_KEY environment variable in Vercel to use a different passcode.
const KEY_SALT = "f854d3cc911b5c89f1e93d36f219c692";
const KEY_HASH = "0cad7a4ece5a03c629b9dadf112c40fe2193f0ae6facc9804c8bb3a8dd8b6ed5";

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

function keyOk(req) {
  const given = String(req.headers["x-results-key"] || "").slice(0, 200);
  if (!given) return false;
  const salt = Buffer.from(KEY_SALT, "hex");
  const expected = process.env.RESULTS_KEY
    ? scryptSync(process.env.RESULTS_KEY, salt, 32)
    : Buffer.from(KEY_HASH, "hex");
  return timingSafeEqual(scryptSync(given, salt, 32), expected);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(pathname) {
  const r = await get(pathname, { access: "private", useCache: false });
  if (!r || r.statusCode !== 200) return null;
  return JSON.parse(await new Response(r.stream).text());
}

async function listPathnames() {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix: PREFIX, cursor, limit: 1000 });
    out.push(...page.blobs.map((b) => b.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function save(req, res) {
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
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
  await put(pathname, JSON.stringify(record), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60
  });
  return res.status(200).json({ ok: true, name, total: s.total, verdict: s.verdict, attempts: record.attempts });
}

async function listAll(req, res) {
  if (!keyOk(req)) {
    await sleep(700);
    return res.status(401).json({ error: "Wrong passcode." });
  }
  const pathnames = await listPathnames();
  const records = (await Promise.all(pathnames.map((p) => readJson(p).catch(() => null)))).filter(Boolean);
  records.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return res.status(200).json({ results: records, max: PILLAR_OF.length * 3 });
}

async function remove(req, res) {
  if (!keyOk(req)) {
    await sleep(700);
    return res.status(401).json({ error: "Wrong passcode." });
  }
  const slug = String(req.query.slug || "");
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return res.status(400).json({ error: "Unknown person." });
  await del(`${PREFIX}${slug}.json`);
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
    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "The results store had a problem." });
  }
}
