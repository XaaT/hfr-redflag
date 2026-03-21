# HFR RedFlag

Userscript pour [forum.hardware.fr](https://forum.hardware.fr) qui met en évidence les posts ayant été alertés à la modération. Les posts alertés sont affichés avec un fond rouge et un badge "Alerté".

Les résultats sont partagés entre tous les utilisateurs du script via un cache commun — un post scanné par un utilisateur est immédiatement visible par les autres.

## Installation

1. Installer [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Opera) ou [Violentmonkey](https://violentmonkey.github.io/)
2. [Cliquer ici pour installer le script](https://raw.githubusercontent.com/XaaT/hfr-redflag/master/hfr-redflag.user.js)
3. Tampermonkey propose l'installation — confirmer
4. Naviguer sur un topic HFR — le script scanne automatiquement les posts

Les mises à jour sont automatiques via Tampermonkey.

## Comment ça marche

1. Le script extrait les posts de la page
2. Il vérifie d'abord le **cache local** (localStorage) puis le **cache partagé** (API)
3. Pour les posts inconnus, il interroge `modo.php` en arrière-plan (throttlé)
4. Si un post a été alerté, il est affiché en rouge avec un badge
5. Les résultats sont remontés au cache partagé pour les autres utilisateurs

### Détection

La détection est binaire : si `modo.php` affiche le formulaire d'alerte, le post n'est pas alerté. Sinon, il l'est. Un post alerté est définitif — il ne peut pas revenir en arrière.

L'utilisateur doit être connecté à HFR pour que la détection fonctionne.

## Architecture

```
Navigateur (Tampermonkey)          Cloudflare (cache partagé)
┌─────────────────────┐           ┌──────────────────────┐
│  1. Cache local      │           │  CF Worker + D1      │
│  2. GET /check ──────┼──────────▶│  (SQLite edge)       │
│  3. Scan modo.php    │           │                      │
│  4. POST /report ────┼──────────▶│  Stocke les résultats│
│  5. Affichage rouge  │           └──────────────────────┘
└─────────────────────┘
```

- **Cache local** : localStorage, TTL 1h pour les "pas alerté", permanent pour les alertés
- **Cache partagé** : Cloudflare D1 (SQLite edge), partagé entre tous les utilisateurs
- **Failover** : si le Worker est down, le script fonctionne en mode local (circuit breaker)

## Configuration

Les constantes sont dans le bloc `CONFIG` en haut du script :

| Paramètre | Défaut | Description |
|---|---|---|
| `throttleDelay` | 200ms | Délai entre chaque requête modo.php (~5 req/s) |
| `cacheTtl` | 1h | TTL du cache local pour les posts non alertés |
| `cbThreshold` | 3 | Erreurs consécutives avant circuit breaker |
| `cbBaseDelay` | 5 min | Délai initial du circuit breaker |

## Debug

Commandes à coller dans la console du navigateur (F12) :

```js
// Simuler Worker down (circuit ouvert 1 min)
localStorage.setItem('hfr_redflag_circuit', JSON.stringify({failures: 3, openUntil: Date.now() + 60000}));

// Reset circuit breaker
localStorage.removeItem('hfr_redflag_circuit');

// Voir la retry queue
JSON.parse(localStorage.getItem('hfr_redflag_failed_reports'));

// Vider le cache local (force re-scan de tous les posts)
localStorage.removeItem('hfr_redflag_cache');

// Voir le cache local
JSON.parse(localStorage.getItem('hfr_redflag_cache'));
```

## Compatibilité

| Moteur | Support |
|---|---|
| Tampermonkey | Complet (cible principale) |
| Violentmonkey | Complet |
| Greasemonkey v4+ | Complet (shims intégrés) |

## Changelog

Voir [CHANGELOG.md](CHANGELOG.md) pour le détail ou le header du script pour un résumé.

## Licence

[MIT](LICENSE)
