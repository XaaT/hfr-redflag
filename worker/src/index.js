// HFR RedFlag — Cloudflare Worker + D1
// Cache partage des statuts d'alerte des posts HFR
//
// Endpoints :
//   GET  /check?cat={cat}&ids={id1,id2,...}  — statuts connus
//   POST /report                              — batch upsert (anti-rollback)
//   GET  /topic?cat={cat}&post={post}         — tous les flagged d'un topic
//   GET  /stats                               — metriques globales
//
// Securite :
//   - Header X-HFR-RF-Version obligatoire
//   - Max 100 items par requete
//   - Un POST ne peut pas passer flagged=true -> flagged=false

var REQUIRED_HEADER = 'X-HFR-RF-Version';
var MAX_ITEMS = 100;

// =====================================================================
// CORS
// =====================================================================

var CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, ' + REQUIRED_HEADER,
  'Access-Control-Max-Age': '86400'
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
  });
}

function err(message, status) {
  return json({ error: message }, status);
}

// =====================================================================
// VALIDATION
// =====================================================================

function isPositiveInt(val) {
  var n = Number(val);
  return Number.isInteger(n) && n > 0;
}

function parseIds(str) {
  return str.split(',').filter(isPositiveInt).map(Number);
}

// =====================================================================
// HANDLERS
// =====================================================================

async function handleCheck(url, db) {
  var cat = url.searchParams.get('cat');
  var idsParam = url.searchParams.get('ids');

  if (!cat || !isPositiveInt(cat)) return err('cat requis (entier positif)', 400);
  if (!idsParam) return err('ids requis', 400);

  var ids = parseIds(idsParam);
  if (ids.length === 0) return err('aucun id valide', 400);
  if (ids.length > MAX_ITEMS) return err('max ' + MAX_ITEMS + ' ids', 400);

  var placeholders = ids.map(function () { return '?'; }).join(',');
  var stmt = db.prepare(
    'SELECT numreponse, flagged, checked_at FROM posts WHERE cat = ? AND numreponse IN (' + placeholders + ')'
  );

  var result = await stmt.bind(Number(cat), ...ids).all();

  var posts = {};
  for (var row of result.results) {
    posts[row.numreponse] = {
      flagged: row.flagged === 1,
      checkedAt: row.checked_at
    };
  }
  return json(posts);
}

async function handleReport(request, db) {
  var body;
  try { body = await request.json(); }
  catch (e) { return err('JSON invalide', 400); }

  if (!Array.isArray(body.results)) return err('results requis (tableau)', 400);
  if (body.results.length > MAX_ITEMS) return err('max ' + MAX_ITEMS + ' results', 400);

  var stmts = [];

  for (var r of body.results) {
    if (!isPositiveInt(r.cat) || !isPositiveInt(r.numreponse) || !isPositiveInt(r.post)) continue;
    if (typeof r.flagged !== 'boolean') continue;

    if (r.flagged) {
      // Alerte : toujours ecrire flagged=1
      stmts.push(
        db.prepare(
          "INSERT INTO posts (cat, numreponse, post_id, flagged, checked_at) VALUES (?, ?, ?, 1, datetime('now')) "
          + "ON CONFLICT(cat, numreponse) DO UPDATE SET flagged = 1, checked_at = datetime('now')"
        ).bind(Number(r.cat), Number(r.numreponse), Number(r.post))
      );
    } else {
      // Pas alerte : ecrire seulement si pas deja flagged=1 (anti-rollback)
      stmts.push(
        db.prepare(
          "INSERT INTO posts (cat, numreponse, post_id, flagged, checked_at) VALUES (?, ?, ?, 0, datetime('now')) "
          + "ON CONFLICT(cat, numreponse) DO UPDATE SET checked_at = datetime('now') WHERE flagged = 0"
        ).bind(Number(r.cat), Number(r.numreponse), Number(r.post))
      );
    }
  }

  if (stmts.length > 0) await db.batch(stmts);

  return json({ ok: true, submitted: stmts.length });
}

async function handleTopic(url, db) {
  var cat = url.searchParams.get('cat');
  var post = url.searchParams.get('post');

  if (!cat || !isPositiveInt(cat)) return err('cat requis (entier positif)', 400);
  if (!post || !isPositiveInt(post)) return err('post requis (entier positif)', 400);

  var result = await db.prepare(
    'SELECT numreponse FROM posts WHERE cat = ? AND post_id = ? AND flagged = 1'
  ).bind(Number(cat), Number(post)).all();

  var flagged = result.results.map(function (row) { return { numreponse: row.numreponse }; });
  return json({ flagged: flagged, total: flagged.length });
}

async function handleStats(db) {
  var total = await db.prepare('SELECT COUNT(*) as c FROM posts').first();
  var flaggedCount = await db.prepare('SELECT COUNT(*) as c FROM posts WHERE flagged = 1').first();
  return json({ totalPosts: total.c, flaggedPosts: flaggedCount.c });
}

// =====================================================================
// ROUTER
// =====================================================================

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (!request.headers.get(REQUIRED_HEADER)) {
      return err('header ' + REQUIRED_HEADER + ' requis', 403);
    }

    var url = new URL(request.url);
    var routeKey = request.method + ' ' + url.pathname;

    try {
      if (routeKey === 'GET /check') return await handleCheck(url, env.DB);
      if (routeKey === 'POST /report') return await handleReport(request, env.DB);
      if (routeKey === 'GET /topic') return await handleTopic(url, env.DB);
      if (routeKey === 'GET /stats') return await handleStats(env.DB);
      return err('endpoint inconnu', 404);
    } catch (e) {
      console.error('Worker error:', e);
      return err('erreur interne', 500);
    }
  }
};
