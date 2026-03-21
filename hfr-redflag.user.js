// ==UserScript==
// @name         HFR RedFlag
// @namespace    https://github.com/XaaT/hfr-redflag
// @version      0.2.0
// @description  Met en evidence les posts alertes a la moderation sur forum.hardware.fr
// @author       xat
// @match        https://forum.hardware.fr/forum2.php*
// @match        https://forum.hardware.fr/hfr/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  var PREFIX = '[HFR RedFlag]';

  // --- Etape 1 : Extraction des donnees de la page ---

  // Extraire cat et post depuis l'URL
  function parsePageUrl() {
    var params = new URLSearchParams(window.location.search);
    // URL classique : forum2.php?config=hfr.inc&cat=13&post=18045&page=4321
    var cat = params.get('cat');
    var post = params.get('post');
    var page = params.get('page');

    // URL rewritee : /hfr/Discussions/Viepratique/toulouse-sujet_18045_4322.htm
    if (!cat || !post) {
      // On cherche les meta ou liens modo.php dans la page pour recuperer cat
      var modoLink = document.querySelector('a[href*="modo.php"]');
      if (modoLink) {
        var modoUrl = new URL(modoLink.href, window.location.origin);
        var modoParams = new URLSearchParams(modoUrl.search);
        cat = cat || modoParams.get('cat');
        post = post || modoParams.get('post');
        page = page || modoParams.get('page');
      }
    }

    // Dernier fallback pour les URLs rewritees : extraire depuis le path
    // Format: /hfr/.../nom-sujet_POST_PAGE.htm
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

  // Extraire les numreponse depuis la variable JS listenumreponse
  function extractNumreponses() {
    // Methode 1 : lire la variable globale
    if (typeof listenumreponse !== 'undefined' && Array.isArray(listenumreponse)) {
      return listenumreponse.map(function (n) { return parseInt(n, 10); });
    }

    // Methode 2 : parser les scripts de la page
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

    // Methode 3 : fallback DOM - scanner les ancres
    var anchors = document.querySelectorAll('td.messCase1 a[name^="t"]');
    var nums = [];
    anchors.forEach(function (a) {
      var num = parseInt(a.name.substring(1), 10);
      if (!isNaN(num)) nums.push(num);
    });
    return nums;
  }

  // --- Etape 2 : Detection via modo.php ---

  // Construire l'URL modo.php pour un post
  function buildModoUrl(cat, post, numreponse) {
    return 'https://forum.hardware.fr/user/modo.php?config=hfr.inc'
      + '&cat=' + cat
      + '&post=' + post
      + '&numreponse=' + numreponse
      + '&page=1&ref=1';
  }

  // Checker un post via modo.php, retourne une Promise
  // Resolve: { numreponse, flagged: true/false } ou null si erreur
  function checkPost(cat, post, numreponse) {
    return new Promise(function (resolve) {
      var url = buildModoUrl(cat, post, numreponse);
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = 10000;
      xhr.onload = function () {
        if (xhr.status === 200) {
          var html = xhr.responseText;
          // Si la page contient un textarea -> formulaire d'alerte -> pas alerte
          var hasForm = html.indexOf('<textarea') !== -1
            || html.indexOf('Raison de la demande') !== -1;
          if (hasForm) {
            resolve({ numreponse: numreponse, flagged: false });
          } else {
            // Verifier qu'on a bien un message de moderation et pas une erreur
            var hasModMsg = html.indexOf('modération') !== -1
              || html.indexOf('mod\u00e9ration') !== -1
              || html.indexOf('moderation') !== -1;
            if (hasModMsg) {
              resolve({ numreponse: numreponse, flagged: true });
            } else {
              // Page inattendue (pas connecte, erreur, etc.)
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

  // Queue throttlee : execute les checks avec un debit limite
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

  // --- Etape 3 : Affichage visuel ---

  // Injecter le CSS
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

  // Marquer un post comme alerte dans le DOM
  function markPostFlagged(numreponse) {
    var anchor = document.querySelector('a[name="t' + numreponse + '"]');
    if (!anchor) return;

    // Remonter au table.messagetable
    var table = anchor.closest('table.messagetable');
    if (!table) return;

    table.classList.add('hfr-redflag-flagged');

    // Ajouter le badge dans messCase1
    var cell = table.querySelector('td.messCase1');
    if (cell && !cell.querySelector('.hfr-redflag-badge')) {
      var badge = document.createElement('div');
      badge.className = 'hfr-redflag-badge';
      badge.textContent = '\u26A0 Alert\u00e9';
      cell.appendChild(badge);
    }
  }

  // Widget de statut en bas a droite
  function createStatusWidget() {
    var el = document.createElement('div');
    el.className = 'hfr-redflag-status';
    el.textContent = 'RedFlag: scan...';
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

  // Cle de cache : "cat:numreponse"
  function cacheKey(cat, numreponse) {
    return cat + ':' + numreponse;
  }

  // Verifier si une entree de cache est encore fraiche
  function isCacheFresh(entry) {
    if (!entry) return false;
    // Alerte = permanent
    if (entry.flagged) return true;
    // Pas alerte = TTL de 1h
    var age = Date.now() - entry.checkedAt;
    return age < 3600000; // 1h
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
    console.log(PREFIX, numreponses.length, 'posts trouves:', numreponses);

    if (numreponses.length === 0) {
      console.log(PREFIX, 'Aucun post trouve, arret.');
      return;
    }

    // Charger le cache
    var cache = loadCache();
    var toCheck = [];
    var alreadyFlagged = 0;

    numreponses.forEach(function (num) {
      var key = cacheKey(pageInfo.cat, num);
      var entry = cache[key];
      if (isCacheFresh(entry)) {
        if (entry.flagged) {
          markPostFlagged(num);
          alreadyFlagged++;
        }
        // Pas alerte + frais -> on skip
      } else {
        toCheck.push(num);
      }
    });

    console.log(PREFIX, alreadyFlagged, 'posts alertes (cache),', toCheck.length, 'a verifier');

    if (toCheck.length === 0) {
      console.log(PREFIX, 'Rien a verifier, tout est en cache.');
      return;
    }

    // Injecter les styles
    injectStyles();

    // Widget de statut
    var widget = createStatusWidget();
    var checked = 0;
    var flagged = alreadyFlagged;

    // Queue throttlee : 1 requete toutes les 400ms (~2.5 req/s)
    var queue = new ThrottledQueue(400);

    // Lancer les checks
    var promises = toCheck.map(function (num) {
      return queue.add(function () {
        return checkPost(pageInfo.cat, pageInfo.post, num).then(function (result) {
          checked++;
          if (result) {
            var key = cacheKey(pageInfo.cat, num);
            cache[key] = {
              flagged: result.flagged,
              checkedAt: Date.now()
            };
            if (result.flagged) {
              flagged++;
              markPostFlagged(num);
              console.log(PREFIX, 'ALERTE:', num);
            }
          }
          updateStatusWidget(widget, checked, flagged, toCheck.length);
        });
      });
    });

    Promise.all(promises).then(function () {
      saveCache(cache);
      console.log(PREFIX, 'Scan termine.', flagged, 'alertes sur', numreponses.length, 'posts.');
      if (flagged === alreadyFlagged) {
        widget.textContent = 'RedFlag: aucune alerte';
      }
      removeStatusWidget(widget);
    });
  }

  // Attendre que le DOM soit pret
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
