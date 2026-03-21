// HFR RedFlag — Cloudflare Worker + D1
// Cache partage des statuts d'alerte des posts HFR

var REQUIRED_HEADER = 'X-HFR-RF-Version';

// --- CORS ---

var CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, ' + REQUIRED_HEADER,
  'Access-Control-Max-Age': '86400'
};

function corsResponse(body, status, extraHeaders) {
  var headers = Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }, extraHeaders || {});
  return new Response(JSON.stringify(body), { status: status, headers: headers });
}

// --- Validation ---

function isPositiveInt(val) {
  var n = Number(val);
  return Number.isInteger(n) && n > 0;
}

// --- Handlers ---

async function handleCheck(request, env) {
  var url = new URL(request.url);
  var cat = url.searchParams.get('cat');
  var idsParam = url.searchParams.get('ids');

  if (!cat || !isPositiveInt(cat)) {
    return corsResponse({ error: 'cat requis (entier positif)' }, 400);
  }
  if (!idsParam) {
    return corsResponse({ error: 'ids requis' }, 400);
  }

  var ids = idsParam.split(',').filter(isPositiveInt).map(Number);
  if (ids.length === 0) {
    return corsResponse({ error: 'aucun id valide' }, 400);
  }
  if (ids.length > 100) {
    return corsResponse({ error: 'max 100 ids par requete' }, 400);
  }

  var catNum = Number(cat);
  var placeholders = ids.map(function () { return '?'; }).join(',');
  var query = 'SELECT numreponse, flagged, checked_at FROM posts WHERE cat = ? AND numreponse IN (' + placeholders + ')';
  var params = [catNum].concat(ids);

  var result = await env.DB.prepare(query).bind.apply(env.DB.prepare(query), params).all();

  var posts = {};
  result.results.forEach(function (row) {
    posts[row.numreponse] = {
      flagged: row.flagged === 1,
      checkedAt: row.checked_at
    };
  });

  return corsResponse(posts);
}

async function handleReport(request, env) {
  var body;
  try {
    body = await request.json();
  } catch (e) {
    return corsResponse({ error: 'JSON invalide' }, 400);
  }

  if (!body.results || !Array.isArray(body.results)) {
    return corsResponse({ error: 'results requis (tableau)' }, 400);
  }

  if (body.results.length > 100) {
    return corsResponse({ error: 'max 100 results par requete' }, 400);
  }

  var updated = 0;
  var stmts = [];

  for (var i = 0; i < body.results.length; i++) {
    var r = body.results[i];
    if (!isPositiveInt(r.cat) || !isPositiveInt(r.numreponse) || !isPositiveInt(r.post)) {
      continue;
    }
    if (typeof r.flagged !== 'boolean') {
      continue;
    }

    if (r.flagged) {
      // Alerte -> INSERT ou UPDATE vers flagged=1 (toujours)
      stmts.push(
        env.DB.prepare(
          'INSERT INTO posts (cat, numreponse, post_id, flagged, checked_at) VALUES (?, ?, ?, 1, datetime(\'now\')) '
          + 'ON CONFLICT(cat, numreponse) DO UPDATE SET flagged = 1, checked_at = datetime(\'now\')'
        ).bind(Number(r.cat), Number(r.numreponse), Number(r.post))
      );
    } else {
      // Pas alerte -> INSERT ou UPDATE SEULEMENT si pas deja flagged=1
      stmts.push(
        env.DB.prepare(
          'INSERT INTO posts (cat, numreponse, post_id, flagged, checked_at) VALUES (?, ?, ?, 0, datetime(\'now\')) '
          + 'ON CONFLICT(cat, numreponse) DO UPDATE SET checked_at = datetime(\'now\') WHERE flagged = 0'
        ).bind(Number(r.cat), Number(r.numreponse), Number(r.post))
      );
    }
    updated++;
  }

  if (stmts.length > 0) {
    await env.DB.batch(stmts);
  }

  return corsResponse({ ok: true, updated: updated });
}

async function handleTopic(request, env) {
  var url = new URL(request.url);
  var cat = url.searchParams.get('cat');
  var post = url.searchParams.get('post');

  if (!cat || !isPositiveInt(cat)) {
    return corsResponse({ error: 'cat requis (entier positif)' }, 400);
  }
  if (!post || !isPositiveInt(post)) {
    return corsResponse({ error: 'post requis (entier positif)' }, 400);
  }

  var result = await env.DB.prepare(
    'SELECT numreponse FROM posts WHERE cat = ? AND post_id = ? AND flagged = 1'
  ).bind(Number(cat), Number(post)).all();

  var flagged = result.results.map(function (row) {
    return { numreponse: row.numreponse };
  });

  return corsResponse({ flagged: flagged, total: flagged.length });
}

async function handleStats(request, env) {
  var total = await env.DB.prepare('SELECT COUNT(*) as c FROM posts').first();
  var flaggedCount = await env.DB.prepare('SELECT COUNT(*) as c FROM posts WHERE flagged = 1').first();

  return corsResponse({
    totalPosts: total.c,
    flaggedPosts: flaggedCount.c
  });
}

// --- Router ---

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Auth guard : header obligatoire
    if (!request.headers.get(REQUIRED_HEADER)) {
      return corsResponse({ error: 'header ' + REQUIRED_HEADER + ' requis' }, 403);
    }

    var url = new URL(request.url);
    var path = url.pathname;

    try {
      if (path === '/check' && request.method === 'GET') {
        return await handleCheck(request, env);
      }
      if (path === '/report' && request.method === 'POST') {
        return await handleReport(request, env);
      }
      if (path === '/topic' && request.method === 'GET') {
        return await handleTopic(request, env);
      }
      if (path === '/stats' && request.method === 'GET') {
        return await handleStats(request, env);
      }

      return corsResponse({ error: 'endpoint inconnu' }, 404);
    } catch (e) {
      console.error('Erreur Worker:', e);
      return corsResponse({ error: 'erreur interne' }, 500);
    }
  }
};
