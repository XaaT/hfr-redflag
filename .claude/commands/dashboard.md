Récupère toutes les issues du repo GitHub XaaT/hfr-redflag via `gh issue list --repo XaaT/hfr-redflag --state all --json number,title,state,labels,createdAt,assignees,milestone`.

Affiche un dashboard complet et structuré avec :

## 1. Progression globale
- Barre de progression (issues fermées / total)
- Compteurs : total, open, closed

## 2. Tableau des issues
Pour chaque issue, affiche sur une ligne :
- Numéro
- Priorité (P0 critique, P1 haute, P2 moyenne, P3 basse) selon cette table :
  - #1 Détection modo.php → P0, Core, Phase Fondation, dépend de #2, effort S
  - #2 Extraction DOM → P0, Core, Phase Fondation, pas de dépendance, effort S
  - #3 CF Worker + Cache → P1, Infra, Phase Core, dépend de #1 et #6, effort L
  - #4 Affichage visuel → P1, UI, Phase Core, dépend de #1 et #2, effort M
  - #5 Compat multi-moteurs → P2, Compat, Phase Polish, dépend de #4, effort M
  - #6 Throttling → P0, Safety, Phase Fondation, dépend de #2, effort M
  - #7 Failover → P2, Résilience, Phase Polish, dépend de #3, effort M
- État (open/closed)
- Catégorie
- Phase (Fondation → Core → Polish)
- Dépendances
- Effort estimé (S/M/L)
- Titre

Pour les issues non listées ci-dessus (nouvelles issues), déduis la priorité, catégorie, phase, dépendances et effort à partir du contenu de l'issue.

Groupe les issues par phase.

## 3. Graphe de dépendances
Affiche un graphe ASCII montrant les dépendances entre issues :
```
Phase Fondation:  #2 ──┬──▶ #1 ──┬──▶ #6
                       │         │
Phase Core:            │         ├──▶ #3 (+ #6)
                       │         │
                       └─────────┴──▶ #4
Phase Polish:                    #3 ──▶ #7
                                 #4 ──▶ #5
```

## 4. Roadmap
Suggère un ordre d'exécution optimal basé sur les dépendances :
- Étape 1 : #2 + #6 (parallélisable, pas de dépendances)
- Étape 2 : #1 (dépend de #2)
- Étape 3 : #4 Affichage (MVP fonctionnel, mode local)
- Étape 4 : #3 CF Worker (scalabilité)
- Étape 5 : #7 + #5 (polish)

Indique clairement quand le MVP est utilisable.

## 5. Prochaine action
Identifie la ou les prochaines issues à traiter en se basant sur :
- Les dépendances (on ne peut pas commencer une issue si ses dépendances ne sont pas fermées)
- La priorité

## Formatage
- Utilise du markdown riche avec des tableaux
- Utilise des emojis pour les statuts : 🔴 P0, 🟠 P1, 🟡 P2, ⚪ P3, ✅ done, 🔓 open, 🔒 bloquée
- Sois concis mais complet
