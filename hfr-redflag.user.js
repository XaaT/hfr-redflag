// ==UserScript==
// @name         HFR RedFlag
// @namespace    https://github.com/XaaT/hfr-redflag
// @version      0.4.2
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
//   0.4.2 - Fix retry queue + throttle 200ms
//   0.4.0 - Circuit breaker + retry queue si le Worker est down
//   0.3.1 - Compatibilite Greasemonkey v4 + Violentmonkey (shims GM.*)
//   0.3.0 - Cache partage via CF Worker + D1, les scans profitent a tous
//   0.2.0 - MVP : detection modo.php, affichage fond rouge + badge, cache local
//   0.1.0 - Structure initiale
// ---

(function () {
  'use strict';

  // --- Shims de compatibilite Greasemonkey v4 ---
  // GM4 utilise GM.xmlHttpRequest (promise-based) au lieu de GM_xmlhttpRequest (callback)
  if (typeof GM_xmlhttpRequest === 'undefined') {
    if (typeof GM !== 'undefined' && GM.xmlHttpRequest) {
      GM_xmlhttpRequest = function (opts) { return GM.xmlHttpRequest(opts); };
    }
  }
  // GM_addStyle n'existe pas dans GM4
  if (typeof GM_addStyle === 'undefined') {
    if (typeof GM !== 'undefined' && GM.addStyle) {
      GM_addStyle = function (css) { return GM.addStyle(css); };
    } else {
      GM_addStyle = function (css) {
        var style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
        return style;
      };
    }
  }

  var PREFIX = '[HFR RedFlag]';
  var API_URL = 'https://hfr-redflag.clement-665.workers.dev';
  var API_VERSION = '0.4.0';

  // --- Circuit breaker pour le Worker ---
  // Evite de retenter le Worker s'il est down
  var CB_KEY = 'hfr_redflag_circuit';
  var CB_THRESHOLD = 3;       // erreurs consecutives avant ouverture
  var CB_BASE_DELAY = 300000; // 5 min en ms
  var CB_MAX_DELAY = 1800000; // 30 min max

  function loadCircuitBreaker() {
    try {
      return JSON.parse(localStorage.getItem(CB_KEY)) || { failures: 0, openUntil: 0 };
    } catch (e) {
      return { failures: 0, openUntil: 0 };
    }
  }

  function saveCircuitBreaker(cb) {
    try {
      localStorage.setItem(CB_KEY, JSON.stringify(cb));
    } catch (e) {}
  }

  function isCircuitOpen() {
    var cb = loadCircuitBreaker();
    if (cb.failures < CB_THRESHOLD) return false;
    if (Date.now() >= cb.openUntil) {
      // Delai expire, on tente un retry (half-open)
      return false;
    }
    return true;
  }

  function recordApiSuccess() {
    saveCircuitBreaker({ failures: 0, openUntil: 0 });
  }

  function recordApiFailure() {
    var cb = loadCircuitBreaker();
    cb.failures++;
    if (cb.failures >= CB_THRESHOLD) {
      // Backoff exponentiel : 5min, 10min, 20min, 30min max
      var delay = Math.min(CB_BASE_DELAY * Math.pow(2, cb.failures - CB_THRESHOLD), CB_MAX_DELAY);
      cb.openUntil = Date.now() + delay;
      console.warn(PREFIX, 'Circuit breaker ouvert, retry dans', Math.round(delay / 60000), 'min');
    }
    saveCircuitBreaker(cb);
  }

  // Queue des reports echoues
  var FAILED_REPORTS_KEY = 'hfr_redflag_failed_reports';

  function loadFailedReports() {
    try {
      return JSON.parse(localStorage.getItem(FAILED_REPORTS_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  function saveFailedReports(reports) {
    try {
      // Garder max 500 reports en queue
      if (reports.length > 500) reports = reports.slice(-500);
      localStorage.setItem(FAILED_REPORTS_KEY, JSON.stringify(reports));
    } catch (e) {}
  }

  function clearFailedReports() {
    try { localStorage.removeItem(FAILED_REPORTS_KEY); } catch (e) {}
  }

  // --- Etape 1 : Extraction des donnees de la page ---

  function parsePageUrl() {
    var params = new URLSearchParams(window.location.search);
    var cat = params.get('cat');
    var post = params.get('post');
    var page = params.get('page');

    if (!cat || !post) {
      var modoLink = document.querySelector('a[href*="modo.php"]');
      if (modoLink) {
        var modoUrl = new URL(modoLink.href, window.location.origin);
        var modoParams = new URLSearchParams(modoUrl.search);
        cat = cat || modoParams.get('cat');
        post = post || modoParams.get('post');
        page = page || modoParams.get('page');
      }
    }

    if (!post) {
      var match = window.location.pathname.match(/sujet_(\d+)_(\d+)\.htm/);
      if (match) {
        post = match[1];
        page = match[2];
      }
    }

    return {
      cat: cat ? parseInt(cat, 10) : null,
      post: post ? parseInt(post, 10) : null,
      page: page ? parseInt(page, 10) : null
    };
  }

  function extractNumreponses() {
    if (typeof listenumreponse !== 'undefined' && Array.isArray(listenumreponse)) {
      return listenumreponse.map(function (n) { return parseInt(n, 10); });
    }

    var scripts = document.querySelectorAll('script:not([src])');
    for (var i = 0; i < scripts.length; i++) {
      var text = scripts[i].textContent;
      var match = text.match(/listenumreponse\s*=\s*new\s+Array\(([^)]+)\)/);
      if (match) {
        return match[1]
          .split(',')
          .map(function (s) { return parseInt(s.replace(/["\s]/g, ''), 10); })
          .filter(function (n) { return !isNaN(n); });
      }
    }

    var anchors = document.querySelectorAll('td.messCase1 a[name^="t"]');
    var nums = [];
    anchors.forEach(function (a) {
      var num = parseInt(a.name.substring(1), 10);
      if (!isNaN(num)) nums.push(num);
    });
    return nums;
  }

  // --- API Worker (cache Worker (shared)) ---

  function apiRequest(method, path, body) {
    // Circuit breaker : skip si ouvert
    if (isCircuitOpen()) {
      console.log(PREFIX, 'API: circuit breaker ouvert, skip', path);
      return Promise.resolve(null);
    }

    return new Promise(function (resolve) {
      GM_xmlhttpRequest({
        method: method,
        url: API_URL + path,
        headers: {
          'X-HFR-RF-Version': API_VERSION,
          'Content-Type': 'application/json'
        },
        data: body ? JSON.stringify(body) : undefined,
        timeout: 5000,
        onload: function (resp) {
          if (resp.status === 200) {
            recordApiSuccess();
            try {
              resolve(JSON.parse(resp.responseText));
            } catch (e) {
              console.warn(PREFIX, 'API: JSON invalide', resp.responseText.substring(0, 100));
              resolve(null);
            }
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

  // Demander les statuts au Worker
  function fetchRemoteStatuses(cat, ids) {
    if (ids.length === 0) return Promise.resolve({});
    return apiRequest('GET', '/check?cat=' + cat + '&ids=' + ids.join(','))
      .then(function (data) { return data || {}; });
  }

  // Envoyer les resultats au Worker (avec retry des echoues)
  function reportToWorker(results) {
    // Ajouter les reports precedemment echoues
    var failed = loadFailedReports();
    var allResults = failed.concat(results);

    if (allResults.length === 0) return Promise.resolve(null);

    return apiRequest('POST', '/report', { results: allResults }).then(function (resp) {
      if (resp && resp.ok) {
        // Succes : vider la queue
        clearFailedReports();
        return resp;
      } else {
        // Echec : sauvegarder tout pour retry
        saveFailedReports(allResults);
        console.warn(PREFIX, 'Report echoue,', allResults.length, 'resultats en queue pour retry');
        return null;
      }
    });
  }

  // --- Detection via modo.php ---

  function buildModoUrl(cat, post, numreponse) {
    return 'https://forum.hardware.fr/user/modo.php?config=hfr.inc'
      + '&cat=' + cat
      + '&post=' + post
      + '&numreponse=' + numreponse
      + '&page=1&ref=1';
  }

  function checkPost(cat, post, numreponse) {
    return new Promise(function (resolve) {
      var url = buildModoUrl(cat, post, numreponse);
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = 10000;
      xhr.onload = function () {
        if (xhr.status === 200) {
          var html = xhr.responseText;
          var hasForm = html.indexOf('<textarea') !== -1
            || html.indexOf('Raison de la demande') !== -1;
          if (hasForm) {
            resolve({ numreponse: numreponse, flagged: false });
          } else {
            var hasModMsg = html.indexOf('modération') !== -1
              || html.indexOf('mod\u00e9ration') !== -1
              || html.indexOf('moderation') !== -1;
            if (hasModMsg) {
              resolve({ numreponse: numreponse, flagged: true });
            } else {
              console.warn(PREFIX, 'Reponse inattendue pour', numreponse, html.substring(0, 200));
              resolve(null);
            }
          }
        } else {
          console.warn(PREFIX, 'HTTP', xhr.status, 'pour', numreponse);
          resolve(null);
        }
      };
      xhr.onerror = function () {
        console.warn(PREFIX, 'Erreur reseau pour', numreponse);
        resolve(null);
      };
      xhr.ontimeout = function () {
        console.warn(PREFIX, 'Timeout pour', numreponse);
        resolve(null);
      };
      xhr.send();
    });
  }

  // Queue throttlee
  function ThrottledQueue(delayMs) {
    this.delayMs = delayMs;
    this.queue = [];
    this.running = false;
  }

  ThrottledQueue.prototype.add = function (fn) {
    var self = this;
    return new Promise(function (resolve, reject) {
      self.queue.push(function () {
        return fn().then(resolve, reject);
      });
      if (!self.running) self._run();
    });
  };

  ThrottledQueue.prototype._run = function () {
    var self = this;
    if (self.queue.length === 0) {
      self.running = false;
      return;
    }
    self.running = true;
    var task = self.queue.shift();
    task().finally(function () {
      setTimeout(function () { self._run(); }, self.delayMs);
    });
  };

  // --- Affichage visuel ---

  function injectStyles() {
    GM_addStyle(
      'table.messagetable.hfr-redflag-flagged > tbody > tr.message {'
      + '  background-color: #ffcccc !important;'
      + '}'
      + 'table.messagetable.hfr-redflag-flagged td.messCase1,'
      + 'table.messagetable.hfr-redflag-flagged td.messCase2 {'
      + '  background-color: #ffcccc !important;'
      + '}'
      + '.hfr-redflag-badge {'
      + '  display: inline-block;'
      + '  background: #cc0000;'
      + '  color: white;'
      + '  font-size: 10px;'
      + '  font-weight: bold;'
      + '  padding: 1px 5px;'
      + '  border-radius: 3px;'
      + '  margin-top: 4px;'
      + '}'
      + '.hfr-redflag-status {'
      + '  position: fixed;'
      + '  bottom: 8px;'
      + '  right: 8px;'
      + '  background: rgba(0,0,0,0.7);'
      + '  color: white;'
      + '  font-size: 11px;'
      + '  padding: 4px 10px;'
      + '  border-radius: 4px;'
      + '  z-index: 99999;'
      + '  font-family: sans-serif;'
      + '}'
    );
  }

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

  function createStatusWidget() {
    var el = document.createElement('div');
    el.className = 'hfr-redflag-status';
    el.textContent = 'RedFlag: chargement...';
    document.body.appendChild(el);
    return el;
  }

  function updateStatusWidget(el, checked, flagged, total) {
    el.textContent = 'RedFlag: ' + checked + '/' + total
      + ' (' + flagged + ' alert\u00e9' + (flagged > 1 ? 's' : '') + ')';
  }

  function removeStatusWidget(el) {
    setTimeout(function () {
      el.style.transition = 'opacity 0.5s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 500);
    }, 3000);
  }

  // --- localStorage cache ---

  var CACHE_KEY = 'hfr_redflag_cache';

  function loadCache() {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function saveCache(cache) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
      console.warn(PREFIX, 'Erreur sauvegarde cache', e);
    }
  }

  function cacheKey(cat, numreponse) {
    return cat + ':' + numreponse;
  }

  function isCacheFresh(entry) {
    if (!entry) return false;
    if (entry.flagged) return true;
    var age = Date.now() - entry.checkedAt;
    return age < 3600000;
  }

  // --- Main ---

  function main() {
    var pageInfo = parsePageUrl();
    console.log(PREFIX, 'Page info:', pageInfo);

    if (!pageInfo.cat || !pageInfo.post) {
      console.log(PREFIX, 'Pas une page de topic, arret.');
      return;
    }

    var numreponses = extractNumreponses();
    console.log(PREFIX, numreponses.length, 'posts trouves');

    if (numreponses.length === 0) {
      console.log(PREFIX, 'Aucun post trouve, arret.');
      return;
    }

    injectStyles();
    var widget = createStatusWidget();

    // Phase 1 : cache local
    var cache = loadCache();
    var toFetchRemote = [];
    var flagged = 0;

    numreponses.forEach(function (num) {
      var key = cacheKey(pageInfo.cat, num);
      var entry = cache[key];
      if (isCacheFresh(entry)) {
        if (entry.flagged) {
          markPostFlagged(num);
          flagged++;
        }
      } else {
        toFetchRemote.push(num);
      }
    });

    console.log(PREFIX, flagged, 'alertes (cache local),', toFetchRemote.length, 'a verifier');

    // Vider la queue des reports echoues si le circuit est ferme
    var pendingReports = loadFailedReports();
    if (pendingReports.length > 0 && !isCircuitOpen()) {
      console.log(PREFIX, 'Retry de', pendingReports.length, 'reports en queue');
      reportToWorker([]).then(function (resp) {
        if (resp && resp.ok) {
          console.log(PREFIX, 'Queue videe:', resp.updated, 'reports envoyes');
        }
      });
    }

    if (toFetchRemote.length === 0) {
      widget.textContent = 'RedFlag: ' + flagged + ' alert\u00e9' + (flagged > 1 ? 's' : '');
      removeStatusWidget(widget);
      return;
    }

    // Phase 2 : cache Worker (shared) (partage)
    widget.textContent = 'RedFlag: interrogation du cache...';

    fetchRemoteStatuses(pageInfo.cat, toFetchRemote).then(function (remoteData) {
      var toCheckModo = [];

      toFetchRemote.forEach(function (num) {
        var remote = remoteData[num] || remoteData[String(num)];
        if (remote) {
          // Le Worker connait ce post
          var key = cacheKey(pageInfo.cat, num);
          cache[key] = {
            flagged: remote.flagged,
            checkedAt: new Date(remote.checkedAt).getTime()
          };
          if (remote.flagged) {
            markPostFlagged(num);
            flagged++;
          } else if (isCacheFresh(cache[key])) {
            // Pas alerte + frais dans le Worker -> on skip
          } else {
            toCheckModo.push(num);
          }
        } else {
          // Inconnu du Worker
          toCheckModo.push(num);
        }
      });

      console.log(PREFIX, flagged, 'alertes apres cache Worker (shared),', toCheckModo.length, 'a scanner via modo.php');

      if (toCheckModo.length === 0) {
        widget.textContent = 'RedFlag: ' + flagged + ' alert\u00e9' + (flagged > 1 ? 's' : '');
        saveCache(cache);
        removeStatusWidget(widget);
        return;
      }

      // Phase 3 : scan modo.php pour les posts inconnus
      widget.textContent = 'RedFlag: scan modo.php...';
      var queue = new ThrottledQueue(200);
      var checked = 0;
      var scanResults = [];

      var promises = toCheckModo.map(function (num) {
        return queue.add(function () {
          return checkPost(pageInfo.cat, pageInfo.post, num).then(function (result) {
            checked++;
            if (result) {
              var key = cacheKey(pageInfo.cat, num);
              cache[key] = {
                flagged: result.flagged,
                checkedAt: Date.now()
              };
              scanResults.push({
                cat: pageInfo.cat,
                post: pageInfo.post,
                numreponse: num,
                flagged: result.flagged
              });
              if (result.flagged) {
                flagged++;
                markPostFlagged(num);
                console.log(PREFIX, 'ALERTE:', num);
              }
            }
            updateStatusWidget(widget, checked, flagged, toCheckModo.length);
          });
        });
      });

      Promise.all(promises).then(function () {
        saveCache(cache);

        // Phase 4 : remonter les resultats au Worker
        if (scanResults.length > 0) {
          console.log(PREFIX, 'Report au Worker:', scanResults.length, 'resultats');
          reportToWorker(scanResults).then(function (resp) {
            if (resp && resp.ok) {
              console.log(PREFIX, 'Worker: report OK,', resp.updated, 'mis a jour');
            }
          });
        }

        console.log(PREFIX, 'Scan termine.', flagged, 'alertes sur', numreponses.length, 'posts.');
        if (flagged === 0) {
          widget.textContent = 'RedFlag: aucune alerte';
        }
        removeStatusWidget(widget);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
