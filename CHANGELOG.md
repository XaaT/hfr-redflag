# Changelog

## 0.7.3 — 2026-03-22

### Corrections
- Color picker : bordure gris clair par défaut (plus de débordement visuel)
- Sélection d'un preset remet le picker en mode gradient arc-en-ciel

## 0.7.2 — 2026-03-22

### Corrections
- 6 presets classiques : rouge, orange, jaune, vert, bleu, violet (suppression du preset "sombre")
- Color picker custom : garde le "+" visible quand une couleur perso est sélectionnée

## 0.7.1 — 2026-03-22

### Corrections
- Color picker : fond arc-en-ciel avec "+" pour indiquer que c'est un sélecteur custom
- Color picker : affiche sa propre couleur une fois sélectionné (pas celle du preset)
- Preset "sombre" revu pour être plus visible comme pastille

## 0.7.0 — 2026-03-22

### Nouveautés
- Widget discret : invisible par défaut, apparaît 5s uniquement si alertes trouvées ou erreur
- Mode debug : toggle dans les préférences, affiche la progression du scan comme avant
- Sélecteur de couleur personnalisée (color picker) en plus des 5 presets
- Presets couleurs revus : rouge, bleu, vert, violet, sombre

### Corrections
- Suppression des couleurs orange et jaune (trop similaires), remplacées par vert

## 0.6.1 — 2026-03-22

### Corrections
- Fix report échoué quand la retry queue dépasse 100 items (limite Worker) — découpe en chunks de 100
- Fix URL de mise à jour (`@updateURL`/`@downloadURL`) pour contourner le cache CDN GitHub

## 0.6.0 — 2026-03-22

### Nouveautés
- Panneau de préférences accessible via le menu Tampermonkey (clic sur l'icône TM → "RedFlag: Preferences")
- Choix du style d'affichage : fond coloré (défaut), bordure gauche, ou badge uniquement
- Choix de la couleur : rouge, orange, jaune, bleu, violet, sombre (pour dark themes)
- Aperçu en direct dans le panneau de préférences
- Compatible Tampermonkey, Violentmonkey et Greasemonkey v4

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
