# HFR RedFlag

## Projet

Userscript Greasemonkey/Tampermonkey pour forum.hardware.fr (HFR) qui met en évidence
les posts ayant été alertés à la modération via un indicateur visuel (fond rouge, icône).

## Architecture

### Détection des alertes

Chaque post HFR possède un lien d'alerte vers `modo.php`. N'importe quel utilisateur
authentifié peut vérifier le statut d'alerte d'un post via :

```
https://forum.hardware.fr/user/modo.php?config=hfr.inc&cat={cat}&post={post}&numreponse={numreponse}&page={page}&ref={ref}
```

#### États connus de modo.php

| Contenu de la réponse | État | Détection |
|---|---|---|
| Formulaire "Raison de la demande de modération" | Pas alerté | Présence du formulaire / textarea |
| "Votre demande de modération sur ce message a été traitée le..." | Alerté par l'utilisateur courant, traité | Contient "Votre demande de modération" + "traitée" |
| "Une demande de modération sur ce message a déjà été traitée" | Alerté par un autre, traité | Contient "Une demande de modération" + "traitée" |
| TODO: identifier le message exact | Alerté par l'utilisateur courant, en attente | TODO |
| TODO: identifier le message exact | Alerté par un autre, en attente + utilisateur courant a rejoint la demande | TODO |
| Formulaire pour se joindre à la demande ? | Alerté par un autre, en attente, pas encore rejoint | TODO |

Note : un utilisateur peut **se joindre** à une demande de modération existante non traitée.
Cela implique au moins un état intermédiaire où le formulaire propose de rejoindre la demande
plutôt que d'en créer une nouvelle. Les messages exacts de ces états restent à confirmer.

**TODO** : sauvegarder les pages HTML brutes de chaque état modo.php rencontré (avec leur URL)
dans un dossier `samples/` du repo, pour servir de référence et de fixtures de test.

### Contraintes

- **Authentification requise** : modo.php nécessite un cookie de session HFR valide.
  Le script tourne dans le navigateur de l'utilisateur connecté, donc OK côté client.
  Un serveur (CF Worker) ne peut PAS faire ces requêtes directement.
- **Rate limiting HFR** : le forum est rate-limité. Une page peut contenir ~40 posts,
  donc 40 requêtes modo.php par page = risque de blocage.

### Stratégie : Hybride client + cache Cloudflare Worker

```
                          ┌──────────────┐
                          │  CF Worker   │
                          │  (KV Store)  │
                          └──────┬───────┘
                                 │
                    GET /status   │  POST /report
                    (batch)      │  (batch)
                                 │
┌─────────┐    ┌─────────────────┴─────────────────┐
│  HFR    │◄───│         Userscript (navigateur)    │
│ modo.php│    │                                     │
└─────────┘    └─────────────────────────────────────┘
```

#### Flow

1. L'utilisateur charge une page HFR
2. Le script extrait les `numreponse` de tous les posts de la page
   (via `listenumreponse` en JS ou parsing du DOM)
3. Requête batch au CF Worker : `GET /status?posts=74419930,74419934,...`
4. Le Worker retourne les statuts connus depuis le KV store
5. Pour les posts **non connus** du cache, le script interroge `modo.php` en **throttlé**
   (ex: 2-3 requêtes/seconde max, avec un quota par page)
6. Les résultats sont remontés au CF Worker : `POST /report` avec les statuts détectés
7. Le script applique l'indicateur visuel (fond rouge / icône) sur les posts alertés

#### CF Worker (free tier)

- **Runtime** : Cloudflare Workers (gratuit : 100k req/jour)
- **Stockage** : KV Store (gratuit : 1k écritures/jour, 100k lectures/jour)
- **Endpoints** :
  - `GET /status?cat={cat}&post={post}&ids={numreponse1,numreponse2,...}` → retourne les statuts connus
  - `POST /report` → body JSON avec les statuts détectés par le client
- **Schéma KV** : clé = `{cat}:{post}:{numreponse}`, valeur = `{status, reportedBy, timestamp}`
- **TTL** : à définir (les alertes traitées sont permanentes, les "pas alerté" doivent expirer)

### Paramètres extraits de l'URL HFR

Depuis l'URL du topic :
```
forum2.php?config=hfr.inc&cat=13&subcat=432&post=18045&page=4321
```

Depuis le lien modo.php de chaque post :
```
modo.php?config=hfr.inc&cat={cat}&post={post}&numreponse={numreponse}&page={page}&ref={ref}
```

Les paramètres essentiels : `cat`, `post`, `numreponse`, `page`, `ref`.

### Affichage

- **Post alerté (traité)** : fond rouge clair + icône drapeau rouge
- **Post alerté par l'utilisateur courant** : fond rouge + mention "votre alerte"
- **Post alerté en attente** : fond orange (si on détecte cet état)
- **Post non alerté** : aucun changement

## Stack technique

- **Userscript** : JavaScript vanilla (Greasemonkey/Tampermonkey)
  - `GM_xmlhttpRequest` pour les requêtes cross-origin vers le CF Worker
  - `fetch` ou `XMLHttpRequest` pour les requêtes modo.php (same-origin)
- **API cache** : Cloudflare Worker + KV
- **Repo** : https://github.com/XaaT/hfr-redflag

## Conventions

- Git identity : `xat <xat@azora.fr>`
- Pas d'accents dans le code source JS et les commentaires JS (compatibilité encodage)
- Documentation (AGENTS.md, README) : français avec accents
- Code commenté en français
