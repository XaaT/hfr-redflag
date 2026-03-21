// ==UserScript==
// @name         HFR RedFlag
// @namespace    https://github.com/XaaT/hfr-redflag
// @version      0.5.1
// @description  Met en evidence les posts alertes a la moderation sur forum.hardware.fr
// @author       xat
// @match        https://forum.hardware.fr/forum2.php*
// @match        https://forum.hardware.fr/hfr/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM.addStyle
// @grant        GM.xmlHttpRequest
// @connect      hfr-redflag.clement-665.workers.dev
// @updateURL    https://raw.githubusercontent.com/XaaT/hfr-redflag/master/hfr-redflag.user.js
// @downloadURL  https://raw.githubusercontent.com/XaaT/hfr-redflag/master/hfr-redflag.user.js
// @license      MIT
// ==/UserScript==
// --- Changelog ---
//   0.5.1 - Fix review : detection binaire stricte, compat .finally(), cache 5k, quota LS
//   0.5.0 - Refactoring : config centralisee, nettoyage cache, code structure
//   0.4.2 - Retrait logs debug
//   0.4.1 - Fix retry queue vide + logs debug temporaires
//   0.4.0 - Circuit breaker + retry queue si le Worker est down
//   0.3.1 - Compatibilite Greasemonkey v4 + Violentmonkey (shims GM.*)
//   0.3.0 - Cache partage via CF Worker + D1, les scans profitent a tous
//   0.2.0 - MVP : detection modo.php, affichage fond rouge + badge, cache local
//   0.1.0 - Structure initiale
// ---

(function () {
  'use strict';

  // =====================================================================
  // CONFIG
  // =====================================================================

  var CONFIG = {
    // API Worker
    apiUrl: 'https://hfr-redflag.clement-665.workers.dev',
    apiVersion: '0.5.0',
    apiTimeout: 5000,            // ms

    // Throttle modo.php
    throttleDelay: 200,          // ms entre chaque requete (~5 req/s)
    modoTimeout: 10000,          // ms

    // Cache local (localStorage)
    cacheKey: 'hfr_redflag_cache',
    cacheTtl: 3600000,           // 1h pour les "pas alerte"
    cacheMaxEntries: 5000,       // nettoyage au-dela

    // Circuit breaker
    cbKey: 'hfr_redflag_circuit',
    cbThreshold: 3,              // erreurs consecutives avant ouverture
    cbBaseDelay: 300000,         // 5 min
    cbMaxDelay: 1800000,         // 30 min

    // Retry queue
    retryKey: 'hfr_redflag_failed_reports',
    retryMaxItems: 500
  };

  var PREFIX = '[HFR RedFlag]';

  // =====================================================================
  // SHIMS GREASEMONKEY V4
  // =====================================================================

  if (typeof GM_xmlhttpRequest === 'undefined') {
    if (typeof GM !== 'undefined' && GM.xmlHttpRequest) {
      GM_xmlhttpRequest = function (opts) { return GM.xmlHttpRequest(opts); };
    }
  }
  if (typeof GM_addStyle === 'undefined') {
    if (typeof GM !== 'undefined' && GM.addStyle) {
      GM_addStyle = function (css) { return GM.addStyle(css); };
    } else {
      GM_addStyle = function (css) {
        var s = document.createElement('style');
        s.textContent = css;
        document.head.appendChild(s);
        return s;
      };
    }
  }

  // =====================================================================
  // LOCALSTORAGE HELPERS
  // =====================================================================

  function lsGet(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch (e) { return fallback; }
  }

  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) {
      if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
        console.warn(PREFIX, 'localStorage quota atteint, donnees non sauvegardees');
      }
    }
  }

  function lsRemove(key) {
    try { localStorage.removeItem(key); }
    catch (e) {}
  }

  // =====================================================================
  // CIRCUIT BREAKER
  // =====================================================================

  function isCircuitOpen() {
    var cb = lsGet(CONFIG.cbKey, { failures: 0, openUntil: 0 });
    if (cb.failures < CONFIG.cbThreshold) return false;
    return Date.now() < cb.openUntil;
  }

  function recordApiSuccess() {
    lsSet(CONFIG.cbKey, { failures: 0, openUntil: 0 });
  }

  function recordApiFailure() {
    var cb = lsGet(CONFIG.cbKey, { failures: 0, openUntil: 0 });
    cb.failures++;
    if (cb.failures >= CONFIG.cbThreshold) {
      var delay = Math.min(
        CONFIG.cbBaseDelay * Math.pow(2, cb.failures - CONFIG.cbThreshold),
        CONFIG.cbMaxDelay
      );
      cb.openUntil = Date.now() + delay;
      console.warn(PREFIX, 'Circuit breaker ouvert, retry dans', Math.round(delay / 60000), 'min');
    }
    lsSet(CONFIG.cbKey, cb);
  }

  // =====================================================================
  // RETRY QUEUE
  // =====================================================================

  function loadRetryQueue() {
    return lsGet(CONFIG.retryKey, []);
  }

  function saveRetryQueue(items) {
    if (items.length > CONFIG.retryMaxItems) items = items.slice(-CONFIG.retryMaxItems);
    lsSet(CONFIG.retryKey, items);
  }

  function clearRetryQueue() {
    lsRemove(CONFIG.retryKey);
  }

  // =====================================================================
  // CACHE LOCAL
  // =====================================================================

  function loadCache() {
    return lsGet(CONFIG.cacheKey, {});
  }

  function saveCache(cache) {
    lsSet(CONFIG.cacheKey, cache);
  }

  function makeCacheKey(cat, numreponse) {
    return cat + ':' + numreponse;
  }

  function isCacheFresh(entry) {
    if (!entry) return false;
    if (entry.flagged) return true;
    return (Date.now() - entry.checkedAt) < CONFIG.cacheTtl;
  }

  // Nettoyer les entrees perimees pour eviter la croissance infinie
  function pruneCache(cache) {
    var keys = Object.keys(cache);
    if (keys.length <= CONFIG.cacheMaxEntries) return cache;

    console.log(PREFIX, 'Nettoyage cache:', keys.length, 'entrees');
    var pruned = {};
    var now = Date.now();
    keys.forEach(function (key) {
      var entry = cache[key];
      // Garder les flagged (permanents) et les frais
      if (entry.flagged || (now - entry.checkedAt) < CONFIG.cacheTtl) {
        pruned[key] = entry;
      }
    });
    console.log(PREFIX, 'Cache apres nettoyage:', Object.keys(pruned).length, 'entrees');
    return pruned;
  }

  // =====================================================================
  // EXTRACTION DOM / URL
  // =====================================================================

  function parsePageUrl() {
    var params = new URLSearchParams(window.location.search);
    var cat = params.get('cat');
    var post = params.get('post');
    var page = params.get('page');

    // Fallback : liens modo.php dans la page (URLs rewritees)
    if (!cat || !post) {
      var link = document.querySelector('a[href*="modo.php"]');
      if (link) {
        var p = new URLSearchParams(new URL(link.href, location.origin).search);
        cat = cat || p.get('cat');
        post = post || p.get('post');
        page = page || p.get('page');
      }
    }

    // Fallback : pattern URL rewritee /hfr/.../nom-sujet_POST_PAGE.htm
    if (!post) {
      var match = location.pathname.match(/sujet_(\d+)_(\d+)\.htm/);
      if (match) { post = match[1]; page = match[2]; }
    }

    return {
      cat: cat ? parseInt(cat, 10) : null,
      post: post ? parseInt(post, 10) : null,
      page: page ? parseInt(page, 10) : null
    };
  }

  function extractNumreponses() {
    // Source 1 : variable globale
    if (typeof listenumreponse !== 'undefined' && Array.isArray(listenumreponse)) {
      return listenumreponse.map(function (n) { return parseInt(n, 10); });
    }

    // Source 2 : parser les scripts inline
    var scripts = document.querySelectorAll('script:not([src])');
    for (var i = 0; i < scripts.length; i++) {
      var match = scripts[i].textContent.match(/listenumreponse\s*=\s*new\s+Array\(([^)]+)\)/);
      if (match) {
        return match[1].split(',')
          .map(function (s) { return parseInt(s.replace(/["\s]/g, ''), 10); })
          .filter(function (n) { return !isNaN(n); });
      }
    }

    // Source 3 : fallback DOM
    var nums = [];
    document.querySelectorAll('td.messCase1 a[name^="t"]').forEach(function (a) {
      var n = parseInt(a.name.substring(1), 10);
      if (!isNaN(n)) nums.push(n);
    });
    return nums;
  }

  // =====================================================================
  // API WORKER
  // =====================================================================

  function apiRequest(method, path, body) {
    if (isCircuitOpen()) {
      console.log(PREFIX, 'Circuit breaker ouvert, skip', path);
      return Promise.resolve(null);
    }

    return new Promise(function (resolve) {
      GM_xmlhttpRequest({
        method: method,
        url: CONFIG.apiUrl + path,
        headers: {
          'X-HFR-RF-Version': CONFIG.apiVersion,
          'Content-Type': 'application/json'
        },
        data: body ? JSON.stringify(body) : undefined,
        timeout: CONFIG.apiTimeout,
        onload: function (resp) {
          if (resp.status === 200) {
            recordApiSuccess();
            try { resolve(JSON.parse(resp.responseText)); }
            catch (e) { resolve(null); }
          } else {
            console.warn(PREFIX, 'API:', resp.status, path);
            recordApiFailure();
            resolve(null);
          }
        },
        onerror: function () {
          console.warn(PREFIX, 'API: erreur reseau', path);
          recordApiFailure();
          resolve(null);
        },
        ontimeout: function () {
          console.warn(PREFIX, 'API: timeout', path);
          recordApiFailure();
          resolve(null);
        }
      });
    });
  }

  function fetchRemoteStatuses(cat, ids) {
    if (ids.length === 0) return Promise.resolve({});
    return apiRequest('GET', '/check?cat=' + cat + '&ids=' + ids.join(','))
      .then(function (data) { return data || {}; });
  }

  function reportToWorker(results) {
    var queued = loadRetryQueue();
    var all = queued.concat(results);
    if (all.length === 0) return Promise.resolve(null);

    return apiRequest('POST', '/report', { results: all }).then(function (resp) {
      if (resp && resp.ok) {
        clearRetryQueue();
        return resp;
      } else {
        saveRetryQueue(all);
        console.warn(PREFIX, 'Report echoue,', all.length, 'en queue pour retry');
        return null;
      }
    });
  }

  // =====================================================================
  // DETECTION MODO.PHP
  // =====================================================================

  function buildModoUrl(cat, post, numreponse) {
    return 'https://forum.hardware.fr/user/modo.php?config=hfr.inc'
      + '&cat=' + cat + '&post=' + post
      + '&numreponse=' + numreponse + '&page=1&ref=1';
  }

  function checkPost(cat, post, numreponse) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', buildModoUrl(cat, post, numreponse), true);
      xhr.timeout = CONFIG.modoTimeout;

      xhr.onload = function () {
        if (xhr.status !== 200) {
          console.warn(PREFIX, 'HTTP', xhr.status, 'pour', numreponse);
          return resolve(null);
        }
        var html = xhr.responseText;
        // Formulaire d'alerte present = pas alerte
        if (html.indexOf('<textarea') !== -1 || html.indexOf('Raison de la demande') !== -1) {
          return resolve({ numreponse: numreponse, flagged: false });
        }
        // Tout autre cas = alerte (detection binaire : pas le formulaire = alerte)
        resolve({ numreponse: numreponse, flagged: true });
      };

      xhr.onerror = function () { resolve(null); };
      xhr.ontimeout = function () { resolve(null); };
      xhr.send();
    });
  }

  // =====================================================================
  // THROTTLED QUEUE
  // =====================================================================

  function ThrottledQueue(delayMs) {
    this.delayMs = delayMs;
    this.queue = [];
    this.running = false;
  }

  ThrottledQueue.prototype.add = function (fn) {
    var self = this;
    return new Promise(function (resolve, reject) {
      self.queue.push(function () { return fn().then(resolve, reject); });
      if (!self.running) self._run();
    });
  };

  ThrottledQueue.prototype._run = function () {
    var self = this;
    if (self.queue.length === 0) { self.running = false; return; }
    self.running = true;
    var next = function () { setTimeout(function () { self._run(); }, self.delayMs); };
    self.queue.shift()().then(next, next);
  };

  // =====================================================================
  // AFFICHAGE
  // =====================================================================

  var CSS = ''
    + 'table.messagetable.hfr-redflag-flagged > tbody > tr.message,'
    + 'table.messagetable.hfr-redflag-flagged td.messCase1,'
    + 'table.messagetable.hfr-redflag-flagged td.messCase2'
    + '{ background-color: #ffcccc !important; }'
    + '.hfr-redflag-badge {'
    + '  display: inline-block; background: #cc0000; color: white;'
    + '  font-size: 10px; font-weight: bold; padding: 1px 5px;'
    + '  border-radius: 3px; margin-top: 4px;'
    + '}'
    + '.hfr-redflag-status {'
    + '  position: fixed; bottom: 8px; right: 8px;'
    + '  background: rgba(0,0,0,0.7); color: white;'
    + '  font-size: 11px; padding: 4px 10px; border-radius: 4px;'
    + '  z-index: 99999; font-family: sans-serif;'
    + '}';

  function markPostFlagged(numreponse) {
    var anchor = document.querySelector('a[name="t' + numreponse + '"]');
    if (!anchor) return;
    var table = anchor.closest('table.messagetable');
    if (!table) return;
    table.classList.add('hfr-redflag-flagged');
    var cell = table.querySelector('td.messCase1');
    if (cell && !cell.querySelector('.hfr-redflag-badge')) {
      var badge = document.createElement('div');
      badge.className = 'hfr-redflag-badge';
      badge.textContent = '\u26A0 Alert\u00e9';
      cell.appendChild(badge);
    }
  }

  // --- Widget de statut ---

  function createWidget() {
    var el = document.createElement('div');
    el.className = 'hfr-redflag-status';
    el.textContent = 'RedFlag: chargement...';
    document.body.appendChild(el);
    return el;
  }

  function updateWidget(el, checked, flagged, total) {
    el.textContent = 'RedFlag: ' + checked + '/' + total
      + ' (' + flagged + ' alert\u00e9' + (flagged > 1 ? 's' : '') + ')';
  }

  function dismissWidget(el) {
    setTimeout(function () {
      el.style.transition = 'opacity 0.5s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 500);
    }, 3000);
  }

  // =====================================================================
  // MAIN
  // =====================================================================

  function main() {
    var page = parsePageUrl();
    console.log(PREFIX, 'Page:', page);

    if (!page.cat || !page.post) return;

    var numreponses = extractNumreponses();
    console.log(PREFIX, numreponses.length, 'posts');
    if (numreponses.length === 0) return;

    GM_addStyle(CSS);
    var widget = createWidget();

    // Phase 1 : cache local
    var cache = pruneCache(loadCache());
    var toFetch = [];
    var flagged = 0;

    numreponses.forEach(function (num) {
      var entry = cache[makeCacheKey(page.cat, num)];
      if (isCacheFresh(entry)) {
        if (entry.flagged) { markPostFlagged(num); flagged++; }
      } else {
        toFetch.push(num);
      }
    });

    console.log(PREFIX, flagged, 'alertes (cache local),', toFetch.length, 'a verifier');

    // Retry queue au demarrage
    var pending = loadRetryQueue();
    if (pending.length > 0 && !isCircuitOpen()) {
      console.log(PREFIX, 'Retry de', pending.length, 'reports en queue');
      reportToWorker([]).then(function (resp) {
        if (resp && resp.ok) console.log(PREFIX, 'Queue videe:', resp.submitted, 'envoyes');
      });
    }

    if (toFetch.length === 0) {
      widget.textContent = 'RedFlag: ' + flagged + ' alert\u00e9' + (flagged > 1 ? 's' : '');
      dismissWidget(widget);
      saveCache(cache);
      return;
    }

    // Phase 2 : cache Worker (shared)
    widget.textContent = 'RedFlag: interrogation du cache...';

    fetchRemoteStatuses(page.cat, toFetch).then(function (remote) {
      var toScan = [];

      toFetch.forEach(function (num) {
        var r = remote[num] || remote[String(num)];
        if (r) {
          var key = makeCacheKey(page.cat, num);
          cache[key] = { flagged: r.flagged, checkedAt: new Date(r.checkedAt).getTime() };
          if (r.flagged) { markPostFlagged(num); flagged++; }
          else if (!isCacheFresh(cache[key])) toScan.push(num);
        } else {
          toScan.push(num);
        }
      });

      console.log(PREFIX, flagged, 'alertes apres cache Worker (shared),', toScan.length, 'a scanner');

      if (toScan.length === 0) {
        widget.textContent = 'RedFlag: ' + flagged + ' alert\u00e9' + (flagged > 1 ? 's' : '');
        saveCache(cache);
        dismissWidget(widget);
        return;
      }

      // Phase 3 : scan modo.php
      widget.textContent = 'RedFlag: scan modo.php...';
      var queue = new ThrottledQueue(CONFIG.throttleDelay);
      var checked = 0;
      var results = [];

      var promises = toScan.map(function (num) {
        return queue.add(function () {
          return checkPost(page.cat, page.post, num).then(function (r) {
            checked++;
            if (r) {
              cache[makeCacheKey(page.cat, num)] = { flagged: r.flagged, checkedAt: Date.now() };
              results.push({ cat: page.cat, post: page.post, numreponse: num, flagged: r.flagged });
              if (r.flagged) { flagged++; markPostFlagged(num); console.log(PREFIX, 'ALERTE:', num); }
            }
            updateWidget(widget, checked, flagged, toScan.length);
          });
        });
      });

      Promise.all(promises).then(function () {
        saveCache(cache);

        // Phase 4 : report au Worker
        if (results.length > 0) {
          console.log(PREFIX, 'Report:', results.length, 'resultats');
          reportToWorker(results).then(function (resp) {
            if (resp && resp.ok) console.log(PREFIX, 'Worker OK:', resp.submitted, 'mis a jour');
          });
        }

        console.log(PREFIX, 'Termine.', flagged, 'alertes sur', numreponses.length, 'posts');
        if (flagged === 0) widget.textContent = 'RedFlag: aucune alerte';
        dismissWidget(widget);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
