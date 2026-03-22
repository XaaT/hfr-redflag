// ==UserScript==
// @name         [HFR] RedFlag
// @namespace    https://github.com/XaaT/hfr-redflag
// @icon         https://www.google.com/s2/favicons?sz=64&domain=hardware.fr
// @version      0.7.1
// @description  Met en evidence les posts alertes a la moderation sur forum.hardware.fr
// @author       xat
// @match        https://forum.hardware.fr/forum2.php*
// @match        https://forum.hardware.fr/hfr/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.addStyle
// @grant        GM.xmlHttpRequest
// @grant        GM.registerMenuCommand
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      hfr-redflag.clement-665.workers.dev
// @updateURL    https://github.com/XaaT/hfr-redflag/raw/refs/heads/master/hfr-redflag.user.js
// @downloadURL  https://github.com/XaaT/hfr-redflag/raw/refs/heads/master/hfr-redflag.user.js
// @license      MIT
// ==/UserScript==
// --- Changelog ---
//   0.7.1 - Fix color picker : gradient arc-en-ciel + indicateur "+" + preset sombre revu
//   0.7.0 - Widget discret (alertes/erreurs uniquement) + mode debug + color picker custom
//   0.6.1 - Fix report > 100 items : decoupe en chunks + URL update fix
//   0.6.0 - Preferences : choix du style (fond/bordure/badge) et de la couleur via menu TM
//   0.5.2 - Renommage [HFR] RedFlag + icone favicon dans TM
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
    apiVersion: '0.7.0',
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
  if (typeof GM_registerMenuCommand === 'undefined') {
    if (typeof GM !== 'undefined' && GM.registerMenuCommand) {
      GM_registerMenuCommand = function (name, fn) { return GM.registerMenuCommand(name, fn); };
    } else {
      GM_registerMenuCommand = function () {}; // noop si non supporte
    }
  }
  if (typeof GM_getValue === 'undefined') {
    if (typeof GM !== 'undefined' && GM.getValue) {
      // GM4 getValue est async, on utilise localStorage en fallback
      GM_getValue = function (key, def) {
        var v = localStorage.getItem('hfr_redflag_pref_' + key);
        return v !== null ? JSON.parse(v) : def;
      };
      GM_setValue = function (key, val) {
        localStorage.setItem('hfr_redflag_pref_' + key, JSON.stringify(val));
      };
    } else {
      GM_getValue = function (key, def) {
        var v = localStorage.getItem('hfr_redflag_pref_' + key);
        return v !== null ? JSON.parse(v) : def;
      };
      GM_setValue = function (key, val) {
        localStorage.setItem('hfr_redflag_pref_' + key, JSON.stringify(val));
      };
    }
  }

  // =====================================================================
  // PREFERENCES UTILISATEUR
  // =====================================================================

  var MODES = {
    background: 'Fond colore',
    border:     'Bordure gauche',
    badge:      'Badge uniquement'
  };

  var COLORS = {
    rouge:  { bg: '#ffcccc', border: '#cc0000', badge: '#cc0000' },
    bleu:   { bg: '#cce0ff', border: '#0066cc', badge: '#0066cc' },
    vert:   { bg: '#ccf2cc', border: '#009900', badge: '#009900' },
    violet: { bg: '#e8ccff', border: '#7700cc', badge: '#7700cc' },
    sombre: { bg: '#3d1111', border: '#e84040', badge: '#e84040' }
  };

  var DEFAULT_PREFS = { mode: 'background', color: 'rouge', debug: false };

  function loadPrefs() {
    return {
      mode: GM_getValue('mode', DEFAULT_PREFS.mode),
      color: GM_getValue('color', DEFAULT_PREFS.color),
      debug: GM_getValue('debug', DEFAULT_PREFS.debug)
    };
  }

  function savePrefs(prefs) {
    GM_setValue('mode', prefs.mode);
    GM_setValue('color', prefs.color);
    GM_setValue('debug', prefs.debug);
  }

  function hexToRgb(hex) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return { r: r, g: g, b: b };
  }

  function getColorSet(prefs) {
    if (COLORS[prefs.color]) return COLORS[prefs.color];
    // Couleur custom (hex)
    if (prefs.color && prefs.color.charAt(0) === '#') {
      var rgb = hexToRgb(prefs.color);
      var bg = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.2)';
      return { bg: bg, border: prefs.color, badge: prefs.color };
    }
    return COLORS.rouge;
  }

  // --- Panneau de preferences ---

  function openPrefsPanel() {
    // Supprimer un panel existant
    var old = document.getElementById('hfr-redflag-prefs');
    if (old) { old.remove(); return; }

    var prefs = loadPrefs();

    var overlay = document.createElement('div');
    overlay.id = 'hfr-redflag-prefs';
    overlay.innerHTML = ''
      + '<div style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:100000;display:flex;align-items:center;justify-content:center">'
      + '<div style="background:white;border-radius:8px;padding:20px;min-width:320px;max-width:400px;font-family:sans-serif;font-size:14px;color:#333;box-shadow:0 4px 20px rgba(0,0,0,0.3)">'
      + '<div style="font-size:16px;font-weight:bold;margin-bottom:16px">[HFR] RedFlag — Preferences</div>'
      + '<div style="margin-bottom:12px"><b>Style d\'affichage :</b></div>'
      + '<div id="hfr-rf-modes" style="margin-bottom:16px"></div>'
      + '<div style="margin-bottom:12px"><b>Couleur :</b></div>'
      + '<div id="hfr-rf-colors" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px"></div>'
      + '<div id="hfr-rf-preview" style="padding:8px;border-radius:4px;margin-bottom:16px;font-size:12px">Apercu</div>'
      + '<div style="margin-bottom:16px"><label style="cursor:pointer"><input type="checkbox" id="hfr-rf-debug"> Mode debug (widget de progression permanent)</label></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end">'
      + '<button id="hfr-rf-cancel" style="padding:6px 16px;border:1px solid #ccc;border-radius:4px;background:white;cursor:pointer">Annuler</button>'
      + '<button id="hfr-rf-save" style="padding:6px 16px;border:none;border-radius:4px;background:#cc0000;color:white;cursor:pointer;font-weight:bold">Enregistrer</button>'
      + '</div></div></div>';

    document.body.appendChild(overlay);

    var selectedMode = prefs.mode;
    var selectedColor = prefs.color;
    var selectedDebug = prefs.debug;

    // Init debug checkbox
    var debugCheckbox = document.getElementById('hfr-rf-debug');
    debugCheckbox.checked = selectedDebug;
    debugCheckbox.addEventListener('change', function () {
      selectedDebug = debugCheckbox.checked;
    });

    // Generer les boutons de mode
    var modesDiv = document.getElementById('hfr-rf-modes');
    Object.keys(MODES).forEach(function (key) {
      var btn = document.createElement('label');
      btn.style.cssText = 'display:block;margin-bottom:6px;cursor:pointer';
      btn.innerHTML = '<input type="radio" name="hfr-rf-mode" value="' + key + '"'
        + (key === selectedMode ? ' checked' : '') + '> ' + MODES[key];
      btn.querySelector('input').addEventListener('change', function () {
        selectedMode = key;
        updatePreview();
      });
      modesDiv.appendChild(btn);
    });

    // Generer les pastilles de couleur + color picker
    var colorsDiv = document.getElementById('hfr-rf-colors');
    var allSwatches = [];

    function selectSwatch(key) {
      selectedColor = key;
      allSwatches.forEach(function (s) { s.style.borderColor = 'transparent'; });
    }

    Object.keys(COLORS).forEach(function (key) {
      var c = COLORS[key];
      var swatch = document.createElement('div');
      swatch.title = key;
      swatch.style.cssText = 'width:32px;height:32px;border-radius:50%;cursor:pointer;border:3px solid '
        + (key === selectedColor ? '#333' : 'transparent') + ';background:' + c.badge;
      swatch.addEventListener('click', function () {
        selectSwatch(key);
        swatch.style.borderColor = '#333';
        colorInput.value = c.badge;
        updatePreview();
      });
      allSwatches.push(swatch);
      colorsDiv.appendChild(swatch);
    });

    // Color picker custom
    var isCustom = selectedColor.charAt(0) === '#';
    var pickerWrap = document.createElement('div');
    pickerWrap.title = 'Couleur personnalis\u00e9e';
    pickerWrap.style.cssText = 'width:32px;height:32px;border-radius:50%;cursor:pointer;border:3px solid '
      + (isCustom ? '#333' : 'transparent')
      + ';background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red);position:relative;overflow:hidden';
    var colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;opacity:0;cursor:pointer';
    colorInput.value = isCustom ? selectedColor : '#cc0000';
    var pickerLabel = document.createElement('span');
    pickerLabel.textContent = '+';
    pickerLabel.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);'
      + 'font-size:18px;font-weight:bold;color:white;text-shadow:0 0 3px rgba(0,0,0,0.8);pointer-events:none';
    pickerWrap.appendChild(colorInput);
    pickerWrap.appendChild(pickerLabel);
    allSwatches.push(pickerWrap);

    colorInput.addEventListener('input', function () {
      selectSwatch(colorInput.value);
      pickerWrap.style.borderColor = '#333';
      pickerWrap.style.background = colorInput.value;
      pickerLabel.textContent = '';
      updatePreview();
    });

    // Si une couleur custom etait deja selectionnee, afficher sa couleur
    if (isCustom) {
      pickerWrap.style.background = selectedColor;
      pickerLabel.textContent = '';
    }

    colorsDiv.appendChild(pickerWrap);

    function updatePreview() {
      var preview = document.getElementById('hfr-rf-preview');
      var c = getColorSet({ color: selectedColor });
      var base = 'padding:8px;border-radius:4px;margin-bottom:16px;font-size:12px;';
      if (selectedMode === 'background') {
        preview.style.cssText = base + 'background:' + c.bg + ';border-left:none';
      } else if (selectedMode === 'border') {
        preview.style.cssText = base + 'background:transparent;border-left:4px solid ' + c.border;
      } else {
        preview.style.cssText = base + 'background:transparent;border-left:none';
      }
      preview.innerHTML = 'Apercu du style <span style="display:inline-block;background:' + c.badge
        + ';color:white;font-size:10px;font-weight:bold;padding:1px 5px;border-radius:3px;margin-left:6px">\u26A0 Alert\u00e9</span>';
    }
    updatePreview();

    // Fermer
    overlay.querySelector('#hfr-rf-cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.firstChild.addEventListener('click', function (e) {
      if (e.target === overlay.firstChild) overlay.remove();
    });

    // Sauvegarder
    overlay.querySelector('#hfr-rf-save').addEventListener('click', function () {
      savePrefs({ mode: selectedMode, color: selectedColor, debug: selectedDebug });
      overlay.remove();
      location.reload();
    });
  }

  // Enregistrer la commande menu TM
  GM_registerMenuCommand('RedFlag: Preferences', openPrefsPanel);

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

    // Decouper en chunks de 100 max (limite Worker)
    var chunks = [];
    for (var i = 0; i < all.length; i += 100) {
      chunks.push(all.slice(i, i + 100));
    }

    var failed = [];
    var totalSubmitted = 0;

    function sendChunk(idx) {
      if (idx >= chunks.length) {
        if (failed.length > 0) {
          saveRetryQueue(failed);
          console.warn(PREFIX, 'Report partiel,', failed.length, 'en queue pour retry');
        } else {
          clearRetryQueue();
        }
        return Promise.resolve({ ok: true, submitted: totalSubmitted });
      }
      return apiRequest('POST', '/report', { results: chunks[idx] }).then(function (resp) {
        if (resp && resp.ok) {
          totalSubmitted += (resp.submitted || chunks[idx].length);
        } else {
          failed = failed.concat(chunks[idx]);
        }
        return sendChunk(idx + 1);
      });
    }

    return sendChunk(0);
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

  function buildCSS(prefs) {
    var c = getColorSet(prefs);
    var css = '';

    // Style du post alerte selon le mode
    if (prefs.mode === 'background') {
      css += 'table.messagetable.hfr-redflag-flagged > tbody > tr.message,'
        + 'table.messagetable.hfr-redflag-flagged td.messCase1,'
        + 'table.messagetable.hfr-redflag-flagged td.messCase2'
        + '{ background-color: ' + c.bg + ' !important; }';
    } else if (prefs.mode === 'border') {
      css += 'table.messagetable.hfr-redflag-flagged'
        + '{ border-left: 4px solid ' + c.border + ' !important; }';
    }
    // mode badge : aucun style sur le post, juste le badge

    // Badge
    css += '.hfr-redflag-badge {'
      + '  display: inline-block; background: ' + c.badge + '; color: white;'
      + '  font-size: 10px; font-weight: bold; padding: 1px 5px;'
      + '  border-radius: 3px; margin-top: 4px;'
      + '}';

    // Widget de statut
    css += '.hfr-redflag-status {'
      + '  position: fixed; bottom: 8px; right: 8px;'
      + '  background: rgba(0,0,0,0.7); color: white;'
      + '  font-size: 11px; padding: 4px 10px; border-radius: 4px;'
      + '  z-index: 99999; font-family: sans-serif;'
      + '}';

    return css;
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

  // --- Widget de statut ---
  // En mode normal : invisible sauf alertes ou erreurs (disparait apres quelques secondes)
  // En mode debug : visible en permanence avec progression du scan

  var _widget = null;

  function getWidget() {
    if (!_widget) {
      _widget = document.createElement('div');
      _widget.className = 'hfr-redflag-status';
      _widget.style.display = 'none';
      document.body.appendChild(_widget);
    }
    return _widget;
  }

  function showWidget(text, autoHideMs) {
    var el = getWidget();
    el.textContent = text;
    el.style.display = 'block';
    el.style.opacity = '1';
    if (autoHideMs) {
      setTimeout(function () {
        el.style.transition = 'opacity 0.5s';
        el.style.opacity = '0';
        setTimeout(function () { el.style.display = 'none'; }, 500);
      }, autoHideMs);
    }
  }

  function hideWidget() {
    var el = getWidget();
    el.style.transition = 'opacity 0.5s';
    el.style.opacity = '0';
    setTimeout(function () { el.style.display = 'none'; }, 500);
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

    var prefs = loadPrefs();
    var isDebug = prefs.debug;
    GM_addStyle(buildCSS(prefs));

    if (isDebug) showWidget('RedFlag: chargement...');

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
      if (flagged > 0) {
        showWidget('RedFlag: ' + flagged + ' alert\u00e9' + (flagged > 1 ? 's' : ''), 5000);
      } else if (isDebug) {
        showWidget('RedFlag: aucune alerte', 3000);
      }
      saveCache(cache);
      return;
    }

    // Phase 2 : cache Worker (shared)
    if (isDebug) showWidget('RedFlag: interrogation du cache...');

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
        if (flagged > 0) {
          showWidget('RedFlag: ' + flagged + ' alert\u00e9' + (flagged > 1 ? 's' : ''), 5000);
        } else if (isDebug) {
          showWidget('RedFlag: aucune alerte', 3000);
        }
        saveCache(cache);
        return;
      }

      // Phase 3 : scan modo.php
      if (isDebug) showWidget('RedFlag: scan modo.php...');
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
            if (isDebug) {
              showWidget('RedFlag: ' + checked + '/' + toScan.length
                + ' (' + flagged + ' alert\u00e9' + (flagged > 1 ? 's' : '') + ')');
            }
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
        if (flagged > 0) {
          showWidget('RedFlag: ' + flagged + ' alert\u00e9' + (flagged > 1 ? 's' : ''), 5000);
        } else if (isDebug) {
          showWidget('RedFlag: aucune alerte', 3000);
        } else {
          hideWidget();
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
