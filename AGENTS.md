# HFR RedFlag

## Projet

Userscript Tampermonkey pour forum.hardware.fr (HFR) qui met en évidence
les posts ayant été alertés à la modération via un indicateur visuel (fond rouge, icône).

## Architecture

### Détection des alertes

Chaque post HFR possède un lien d'alerte vers `modo.php`. N'importe quel utilisateur
authentifié peut vérifier le statut d'alerte d'un post via :

```
https://forum.hardware.fr/user/modo.php?config=hfr.inc&cat={cat}&post={post}&numreponse={numreponse}&page={page}&ref={ref}
```

**Vérifié** : les paramètres `page` et `ref` sont ignorés par modo.php pour la détection
d'alerte. Testé avec `page=9999` et `page=1` sur le même post : réponse identique.
Le lien retour utilise `javascript:history.back(1)`, pas une URL construite.
Seuls `cat`, `post` et `numreponse` identifient le post. On peut hardcoder `page=1&ref=1`.

#### Détection binaire

La détection est binaire, pas besoin de distinguer les sous-états :

| Réponse modo.php | Statut | Action |
|---|---|---|
| Formulaire avec textarea "Raison de la demande de modération" | **Pas alerté** | Stocker `flagged = false` + timestamp |
| N'importe quoi d'autre (message de traitement, formulaire pour rejoindre, etc.) | **Alerté** | Stocker `flagged = true` (permanent) |
| Erreur, timeout, réponse inattendue | **Inconnu** | Ne rien stocker |

Un post alerté ne peut pas revenir en arrière. C'est **définitif**.

#### États modo.php connus (référence)

| Contenu de la réponse | Signification |
|---|---|
| Formulaire "Raison de la demande de modération" | Pas alerté |
| "Votre demande de modération sur ce message a été traitée le..." | Alerté par l'utilisateur courant, traité |
| "Une demande de modération sur ce message a déjà été traitée" | Alerté par un autre, traité |
| TODO: identifier le message exact | Alerté en attente de traitement |
| TODO: identifier le message exact | Alerté par un autre, utilisateur a rejoint la demande |
| TODO: formulaire pour rejoindre ? | Alerté par un autre, en attente, pas encore rejoint |

Note : un utilisateur peut **se joindre** à une demande de modération existante non traitée.
Les messages exacts de certains états restent à confirmer.

**TODO** : sauvegarder les pages HTML brutes de chaque état modo.php rencontré (avec leur URL)
dans un dossier `samples/` du repo, pour servir de référence et de fixtures de test.

### Contraintes

- **Authentification requise** : modo.php nécessite un cookie de session HFR valide.
  Le script tourne dans le navigateur de l'utilisateur connecté, donc OK côté client.
  Un serveur (CF Worker) ne peut PAS faire ces requêtes directement.
- **Rate limiting HFR** : le forum est rate-limité. Une page peut contenir ~40 posts,
  donc 40 requêtes modo.php par page = risque de blocage.
- **Pages instables** : quand un post est supprimé, tous les posts suivants décalent de page.
  Le numéro de page n'est PAS un identifiant stable pour un ensemble de posts.
- **`numreponse` unique par catégorie, pas globalement** : vérifié avec des posts du même jour
  (2026-03-21) : cat=13 à ~74M, cat=6 à ~27M, cat=5 à ~16M, cat=8 à ~5.4M, cat=23 à ~2.7M.
  C'est un auto-increment **par catégorie**. Deux catégories peuvent avoir le même numreponse.
  La clé unique d'un post est **`(cat, numreponse)`**.

### Stratégie : Hybride client + cache CF Worker + D1

```
┌──────────────────────────────────────────────────────┐
│                  Cloudflare Worker                     │
│                                                        │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐           │
│  │  Router   │  │  Auth    │  │  Rate     │           │
│  │  (fetch)  │──│  Guard   │──│  Limiter  │           │
│  └──────────┘  └──────────┘  └───────────┘           │
│       │                                                │
│  ┌────┴─────────────────────────────┐                 │
│  │            Handlers              │                 │
│  │  ┌──────────┐  ┌─────────────┐  │                 │
│  │  │GET /check │  │POST /report │  │                 │
│  │  └──────────┘  └─────────────┘  │                 │
│  │  ┌──────────┐  ┌─────────────┐  │                 │
│  │  │GET /topic │  │GET /stats   │  │                 │
│  └──┴──────────┴──┴─────────────┴──┘                 │
│       │                                                │
│  ┌────┴──────┐                                        │
│  │    D1     │                                        │
│  │  (SQLite) │                                        │
│  └───────────┘                                        │
└──────────────────────────────────────────────────────┘
        ▲               │
        │ POST /report  │ GET /check
        │               ▼
┌─────────────────────────────────────┐
│     Userscript (navigateur)         │
│                                      │
│  ┌───────────┐  ┌────────────────┐  │
│  │ DOM Parser │  │ Scan Manager   │  │
│  │            │  │ (throttle +    │  │
│  │ Extrait    │  │  queue modo.php│  │
│  │ numreponse │  │  requests)     │  │
│  └─────┬─────┘  └───────┬────────┘  │
│        │                 │           │
│  ┌─────┴─────────────────┴────────┐  │
│  │         Cache local            │  │
│  │       (localStorage)           │  │
│  └────────────────────────────────┘  │
│        │                              │
│  ┌─────┴──────────────────────────┐  │
│  │       UI Renderer              │  │
│  │  (fond rouge, icônes, badges)  │  │
│  └────────────────────────────────┘  │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────┐
│  HFR        │
│  modo.php   │
└─────────────┘
```

#### Flow détaillé

1. L'utilisateur charge une page HFR
2. **DOM Parser** extrait les `numreponse` de tous les posts
   (via `listenumreponse` en JS ou parsing du DOM) + `cat`, `post` depuis l'URL
3. **Cache local** vérifie si les posts sont connus en localStorage
4. Pour les posts inconnus ou périmés → requête au CF Worker :
   `GET /check?cat=13&ids=74419930,74419934,...`
5. Le Worker retourne les statuts connus depuis D1
6. Pour chaque post retourné :
   - `flagged = true` → afficher indicateur, terminé
   - `flagged = false` + `checkedAt` frais → rien, terminé
   - `flagged = false` + `checkedAt` périmé → re-vérifier
7. Pour les posts absents ou périmés → **Scan Manager** interroge `modo.php` en throttlé
   (2-3 req/s max)
8. Détection : formulaire/textarea → pas alerté. Autre chose → alerté. Erreur → skip.
9. Les résultats sont remontés au CF Worker : `POST /report` (1 requête batch)
10. Le Worker fait un `INSERT OR REPLACE` en transaction D1
11. **UI Renderer** applique les indicateurs visuels sur les posts alertés
12. **Cache local** sauvegarde les résultats en localStorage

### Base de données D1

**Pourquoi D1 et pas KV** : KV free tier = 1k écritures/jour, insuffisant pour du
crowdsourced data. D1 = 100k écritures/jour, SQL, edge, même écosystème CF Workers.

**Pourquoi par post et pas par page** : les numéros de page sont instables (un post supprimé
décale tout).

**Clé primaire `(cat, numreponse)`** : `numreponse` est un auto-increment par catégorie, pas
global. Deux catégories peuvent avoir le même numreponse. La paire `(cat, numreponse)` est
l'identifiant unique d'un post.

```sql
CREATE TABLE posts (
  cat        INTEGER NOT NULL,
  numreponse INTEGER NOT NULL,
  post_id    INTEGER NOT NULL,
  flagged    BOOLEAN NOT NULL,
  checked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cat, numreponse)
);

CREATE INDEX idx_topic ON posts(cat, post_id);
```

- `flagged = true` → permanent, jamais re-vérifié
- `flagged = false` → `checked_at` sert de TTL, re-vérifié quand périmé
- Post absent de la DB → inconnu, à vérifier

#### Budget D1 estimé

- 500 pages uniques/jour × 40 posts = 20k upserts/jour (pire cas)
- En régime de croisière, la majorité des posts sont déjà en DB → très peu de writes
- Les flagged ne sont jamais ré-écrits
- Largement dans les 100k writes/jour du free tier

### Endpoints API

#### `GET /check?cat={cat}&ids={numreponse1,numreponse2,...}`

Retourne les statuts connus des posts demandés pour une catégorie donnée.
Le paramètre `cat` est **obligatoire** (numreponse n'est pas unique sans la catégorie).

```json
{
  "74419934": { "flagged": true },
  "74419930": { "flagged": false, "checkedAt": "2026-03-21T15:00:00Z" }
}
```

Les IDs absents de la réponse = inconnus, jamais vérifiés.
Le client décide si `checkedAt` est assez frais selon la politique de fraîcheur.

#### `POST /report`

Le client remonte les résultats de son scan modo.php.

```json
{
  "results": [
    { "numreponse": 74419930, "cat": 13, "post": 18045, "flagged": false },
    { "numreponse": 74419934, "cat": 13, "post": 18045, "flagged": true }
  ]
}
```

Réponse : `{ "ok": true, "updated": 2 }`.
Le Worker exécute tout dans un seul `INSERT OR REPLACE` en transaction D1.

**Règle importante** : un `POST /report` avec `flagged = false` ne peut PAS écraser un
`flagged = true` existant. Un post alerté reste alerté. Le Worker doit vérifier avant d'écrire.

#### `GET /topic?cat={cat}&post={post}`

Tous les posts alertés d'un topic (toutes pages).

```json
{
  "flagged": [
    { "numreponse": 74419934 },
    { "numreponse": 74500123 }
  ],
  "total": 2
}
```

#### `GET /stats`

Métriques globales (monitoring).

```json
{
  "totalPosts": 15234,
  "flaggedPosts": 342
}
```

### Auth Guard

Pas d'auth lourde (pas de comptes utilisateur), protection anti-abus :

- **Header obligatoire** : `X-HFR-RF-Version: 0.1.0` — identifie les requêtes du script
- **Rate limit par IP** :
  - GET /check : 60/min
  - POST /report : 10/min
  - GET /topic : 20/min
  - GET /stats : 5/min
- **Validation** : `numreponse`, `cat`, `post` doivent être des entiers positifs,
  `flagged` un booléen
- **Aucune donnée utilisateur** : pas de cookie, pseudo ou identifiant HFR transmis à l'API
- **Protection flagged** : un POST ne peut pas passer un post de `flagged=true` à `flagged=false`

### Politique de fraîcheur (côté client)

Le client décide quand re-vérifier un post `flagged=false` :

| Contexte | TTL |
|---|---|
| Post récent (< 24h) | 30min - 1h |
| Post de quelques jours | 2 - 4h |
| Post ancien (> 1 semaine) | 12 - 24h |

Les posts `flagged=true` ne sont jamais re-vérifiés.

**Cache localStorage** : le client stocke localement les résultats pour éviter de re-fetch
le CF Worker à chaque navigation (TTL aligné sur la politique ci-dessus).

### Confiance et abus

Pour v1, on fait confiance aux reporters. L'indicateur est purement informatif.
Si abus constaté → piste pour v2 : système de consensus (N reporters concordants
avant de marquer un post comme flagged dans la DB partagée).

### Paramètres extraits de l'URL HFR

Depuis l'URL du topic :
```
forum2.php?config=hfr.inc&cat=13&subcat=432&post=18045&page=4321
```

Depuis le lien modo.php de chaque post :
```
modo.php?config=hfr.inc&cat={cat}&post={post}&numreponse={numreponse}&page={page}&ref={ref}
```

Les paramètres essentiels : `cat`, `post`, `numreponse`.
`page` et `ref` sont ignorés par modo.php — on peut hardcoder `page=1&ref=1`.

Construction de l'URL modo.php par le script :
```
https://forum.hardware.fr/user/modo.php?config=hfr.inc&cat={cat}&post={post}&numreponse={numreponse}&page=1&ref=1
```

### Affichage

- **Post alerté** : fond rouge clair + icône drapeau rouge
- **Post alerté par l'utilisateur courant** (détecté via "Votre demande") : variante visuelle possible
- **Post non alerté** : aucun changement

### Structure DOM HFR (vérifié)

- **Posts** : `table.messagetable` → `tr.message` (40/page, sauf dernière page)
- **Colonne auteur** : `td.messCase1` contient `<a name="t{numreponse}">`
- **Colonne contenu** : `td.messCase2` contient `<div id="para{numreponse}">`
- **`listenumreponse`** : toujours présent dans un `<script>`, tableau JS des numreponse
  de la page, dans l'ordre d'affichage. C'est la source la plus fiable pour lister les posts.
- **Publicités** : 3-4 `table.messagetable` supplémentaires (auteur = "Publicite"),
  sans ancre `<a name="t...">` → filtrer en vérifiant la présence de l'ancre.
- **Posts supprimés** : disparaissent du DOM sans placeholder, ce qui décale les pages.
- **Liens obfusqués** : les liens d'action (quote, alerte) sont encodés via un système
  de cryptlink custom (alphabet hex `0A12B34C56D78E9F` dans `/js/common.js`).
  Le script n'a pas besoin de les décoder car on construit l'URL modo.php nous-mêmes.

## Stack technique

- **Userscript** : JavaScript vanilla, Tampermonkey
  - `GM_xmlhttpRequest` pour les requêtes cross-origin vers le CF Worker
  - `fetch` ou `XMLHttpRequest` pour les requêtes modo.php (same-origin)
- **API cache** : Cloudflare Worker + D1 (SQLite edge)
- **Repo** : https://github.com/XaaT/hfr-redflag

## Conventions

- Git identity : `xat <xat@azora.fr>`
- Pas d'accents dans le code source JS et les commentaires JS (compatibilité encodage)
- Documentation (AGENTS.md, README) : français avec accents
- Code commenté en français
