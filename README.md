# [HFR] RedFlag

Userscript pour [forum.hardware.fr](https://forum.hardware.fr) qui met en évidence les posts ayant été alertés à la modération. Les posts alertés sont marqués visuellement (fond coloré, bordure ou badge selon vos préférences).

Les résultats sont partagés entre tous les utilisateurs du script via un cache commun — un post scanné par un utilisateur est immédiatement visible par les autres.

## Installation

1. Installer [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Opera) ou [Violentmonkey](https://violentmonkey.github.io/)
2. [Cliquer ici pour installer le script](https://github.com/XaaT/hfr-redflag/raw/refs/heads/master/hfr-redflag.user.js)
3. Tampermonkey propose l'installation — confirmer
4. Naviguer sur un topic HFR — le script scanne automatiquement les posts

Les mises à jour sont automatiques via Tampermonkey.

## Comment ça marche

1. Le script extrait les posts de la page
2. Il vérifie d'abord le **cache local** (localStorage) puis le **cache partagé** (API)
3. Pour les posts inconnus, il interroge `modo.php` en arrière-plan (throttlé)
4. Si un post a été alerté, il est marqué visuellement
5. Les résultats sont remontés au cache partagé pour les autres utilisateurs

La détection est binaire : si `modo.php` affiche le formulaire d'alerte, le post n'est pas alerté. Sinon, il l'est. Un post alerté est définitif — il ne peut pas revenir en arrière.

L'utilisateur doit être connecté à HFR pour que la détection fonctionne.

## Préférences

Accessible via le menu Tampermonkey → **RedFlag: Preferences**.

### Style d'affichage
- **Fond coloré** (défaut) — le post entier est coloré
- **Bordure gauche** — une bordure colorée sur le côté, discret
- **Badge uniquement** — juste le badge "Alerté", aucun changement de fond

### Couleurs
6 presets : rouge, orange, jaune, vert, bleu, violet + un sélecteur de couleur personnalisée.

### Mode debug
Active le widget de progression permanent en bas à droite (progression du scan, alertes trouvées). Désactivé par défaut — le widget n'apparaît que si des alertes sont trouvées (5 secondes).

## Architecture

```
Navigateur (Tampermonkey)          Cloudflare (cache partagé)
┌─────────────────────┐           ┌──────────────────────┐
│  1. Cache local      │           │  CF Worker + D1      │
│  2. GET /check ──────┼──────────▶│  (SQLite edge)       │
│  3. Scan modo.php    │           │                      │
│  4. POST /report ────┼──────────▶│  Stocke les résultats│
│  5. Affichage        │           └──────────────────────┘
└─────────────────────┘
```

- **Cache local** : localStorage, TTL 1h pour les "pas alerté", permanent pour les alertés
- **Cache partagé** : Cloudflare D1 (SQLite edge), partagé entre tous les utilisateurs
- **Failover** : si le Worker est down, le script fonctionne en mode local (circuit breaker avec backoff exponentiel). Les résultats non envoyés sont mis en queue et retransmis automatiquement.

## Configuration avancée

Les constantes sont dans le bloc `CONFIG` en haut du script :

| Paramètre | Défaut | Description |
|---|---|---|
| `throttleDelay` | 200ms | Délai entre chaque requête modo.php (~5 req/s) |
| `cacheTtl` | 1h | TTL du cache local pour les posts non alertés |
| `cbThreshold` | 3 | Erreurs consécutives avant circuit breaker |
| `cbBaseDelay` | 5 min | Délai initial du circuit breaker |
| `cbMaxDelay` | 30 min | Délai max du circuit breaker |

## Debug

### Mode debug

Activer dans les préférences (menu TM → RedFlag: Preferences → Mode debug). Affiche le widget de progression permanent pendant le scan.

### Commandes console

Commandes à coller dans la console du navigateur (F12). Sur Firefox, taper d'abord `autoriser le collage`.

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

## Releases

Les releases sont publiées via des tags Git. Chaque release contient le BBCode prêt à copier-coller sur HFR.

Voir les [releases](https://github.com/XaaT/hfr-redflag/releases) et le [CHANGELOG.md](CHANGELOG.md) pour l'historique.

## Licence

[MIT](LICENSE)
