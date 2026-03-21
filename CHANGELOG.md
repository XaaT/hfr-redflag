# Changelog

## 0.5.2 — 2026-03-22

### Améliorations
- Renommage du script en `[HFR] RedFlag` pour cohérence avec les conventions TM
- Ajout de l'icône favicon HFR dans Tampermonkey

## 0.5.1 — 2026-03-21

### Corrections
- Détection binaire stricte : si modo.php n'affiche pas le formulaire → alerté (au lieu de chercher "modération" dans la réponse)
- Remplacement de `.finally()` par `.then(next, next)` pour compatibilité vieux Firefox/Greasemonkey v4
- Cache local : seuil de nettoyage abaissé de 50k à 5k entrées
- Log explicite quand le quota localStorage est atteint (au lieu de silencieux)
- Worker : renommage `updated` → `submitted` (sémantique correcte)
- Worker : suppression du dead code (`routes`)

## 0.5.0 — 2026-03-21

### Refactoring
- Bloc `CONFIG` centralisé pour toutes les constantes configurables
- Helpers localStorage génériques (`lsGet`, `lsSet`, `lsRemove`)
- Nettoyage automatique du cache au-delà de 5k entrées (`pruneCache`)
- CSS extrait en variable
- Sections clairement délimitées et commentées
- Worker : signatures handlers simplifiées, constante `MAX_ITEMS`

## 0.4.2 — 2026-03-21

### Corrections
- Retrait des logs de debug temporaires

## 0.4.1 — 2026-03-21

### Corrections
- Fix retry queue : les reports en attente sont maintenant envoyés même quand le tableau de nouveaux résultats est vide
- Ajout de logs de debug temporaires pour diagnostic

## 0.4.0 — 2026-03-21

### Nouveautés
- Circuit breaker : après 3 échecs consécutifs du Worker, les appels sont suspendus avec backoff exponentiel (5min → 30min max)
- Retry queue : les POST /report échoués sont sauvegardés en localStorage et retentés automatiquement
- Le script fonctionne à 100% en mode local si le Worker est indisponible

## 0.3.1 — 2026-03-21

### Nouveautés
- Compatibilité Greasemonkey v4 et Violentmonkey via shims (`GM.xmlHttpRequest`, `GM.addStyle`)
- Fallback DOM pour `GM_addStyle` si absent

## 0.3.0 — 2026-03-21

### Nouveautés
- Cache partagé via Cloudflare Worker + D1 (SQLite edge)
- Les scans d'un utilisateur profitent à tous les autres
- Flow : localStorage → Worker → modo.php → report Worker
- Endpoints API : `/check`, `/report`, `/topic`, `/stats`
- Protection anti-rollback : un post alerté ne peut pas être marqué non-alerté

## 0.2.0 — 2026-03-21

### Nouveautés
- Détection des posts alertés via modo.php (détection binaire)
- Affichage : fond rouge + badge "Alerté" sur les posts flaggés
- Throttling : 2.5 req/s par onglet
- Cache localStorage : alerté = permanent, non alerté = TTL 1h
- Widget de progression en bas à droite
- Auto-update via `@updateURL` / `@downloadURL`
- URL modo.php simplifiée (`page=1&ref=1` en dur)

## 0.1.0 — 2026-03-21

### Initial
- Structure du projet : squelette userscript, AGENTS.md, LICENSE MIT
