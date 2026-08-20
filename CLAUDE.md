# CLAUDE.md — garmin-mcp-server

Contexte de travail pour toute session Claude (Claude Code local ou claude.ai) sur ce repo.

## Objet du projet

Serveur MCP distant (Streamable HTTP) exposant les données santé Garmin Connect de Phil comme connecteur personnalisé claude.ai, accessible depuis l'app mobile. Usage personnel, lecture seule exclusivement. Les données alimentent le protocole nutrition/entraînement documenté dans Notion (pages « Nutrition et carb cycling », « Protocole perte de gras », contrat « AGENTS »).

## Architecture

- **Stack** : Next.js 15 (App Router) + `mcp-handler` 2.x + `garmin-connect` 1.6.x + Zod 4.
- **Fichier unique de logique** : `app/api/mcp/[secret]/route.ts` — tout le serveur y vit.
- **Hosting** : Vercel, projet `garmin-mcp-server` (équipe `owl-agency`), production = `main`.
- **URL connecteur** : `https://garmin-mcp-server-owl-agency.vercel.app/api/mcp/<MCP_SECRET>`.
- **Auth Garmin** : e-mail + mot de passe en variables d'environnement Vercel (`GARMIN_EMAIL`, `GARMIN_PASSWORD`). API interne non officielle, session et displayName mis en cache 30 min en mémoire de lambda.

## Pièges connus (ne pas redécouvrir)

1. **Jamais de 401.** claude.ai interprète un 401 comme « ce serveur exige OAuth » et tente un enregistrement dynamique qui échoue. Le refus d'accès renvoie **404**. Le secret vit dans le **chemin** de l'URL (les paramètres de requête ne sont pas fiables côté claude.ai).
2. **Champs Garmin variables.** Les réponses diffèrent selon la source (saisie manuelle vs balance, modèle de montre). Exemple vécu : `calendarDate` absent des pesées manuelles → repli sur le timestamp epoch `date`. Toujours extraire défensivement (`?? null`), jamais de crash sur un champ manquant.
3. **Valeurs négatives = absence.** Garmin encode « non mesuré » par -1/-2 sur le stress et la FC. Helper `nonNegatif()` obligatoire sur ces champs.
4. **displayName requis** pour l'endpoint usersummary — récupéré via `getUserProfile()`, mis en cache module.
5. **MFA non supporté.** Si Garmin l'impose : migrer vers un token `garth` (généré une fois en local via `uvx garth login`, durée ~1 an), remplacer les variables d'env. Changement de variables et d'init client, pas d'architecture.
6. **Endpoints internes utilisés** (appels directs via `client.get`) : `hrv-service/hrv/{date}`, `weight-service/weight/latest?date=`, `usersummary-service/usersummary/daily/{displayName}?calendarDate=`, `metrics-service/metrics/trainingstatus/aggregated/{date}`, `metrics-service/metrics/maxmet/daily/{date}/{date}`.

## Conventions du repo

- **Branches courtes depuis `main`**, une par évolution, PR, **squash merge**. Pas de branche `develop` persistante (les squash la font diverger — conflit vécu sur la PR #1).
- **Compilation locale avant tout push** (`npm run build`). Aucun push de code non compilé.
- Nommage des tools et des champs de sortie **en français** (`sommeil_recent`, `poids_kg`) : ce sont les libellés que Claude manipule en conversation avec Phil.
- Lecture seule stricte : aucun tool d'écriture vers Garmin sans décision explicite de Phil.
- Après merge : Vercel redéploie `main` automatiquement (~1 min). Vérification sanité : POST sur l'endpoint avec un faux secret → 404 attendu.

## Documentation vivante (obligatoire après chaque merge)

Toute session qui merge une PR sur ce repo **doit** mettre à jour la page Notion du projet avant de clôturer :

- **Page** : « Garmin MCP Server », id `3c221516-46fb-81db-ae11-f058ee97f7b2`, dans « Projets en cours ».
- **À mettre à jour** : ligne dans le tableau Historique (date + PR + résumé une ligne), tableau des tools si le périmètre a changé, date du bandeau de statut en tête de page.
- Méthode : `update_content` avec old_str exact issu d'un fetch préalable de la page (règles du contrat AGENTS applicables : pré-lecture avant écriture, remplacements minimaux).

Cette règle est le mécanisme d'automatisation décidé par Phil le 20/08/2026 — pas de GitHub Action, la documentation suit le workflow des agents.

## Tools exposés (7)

Voir README.md pour le détail. Sommeil, VFC, poids (date + heure), activités (calories), santé du jour (body battery, FC repos, états repos/stress/actif), charge d'entraînement + VO2 max, résumé hebdo.

Distinction sémantique importante : dans les graphiques Garmin, « Repos » est un **état** de la ligne du temps (classification VFC minute par minute), pas la FC de repos. Les deux existent dans `sante_jour` (`temps_repos` vs `fc_repos`).

## Historique des décisions structurantes

- PR #2 : tool poids (remplace PR #1, conflit develop/main).
- Correctifs directs sur main (17/08, phase de débogage initiale) : secret en chemin + 404, à la suite de l'échec d'enregistrement du connecteur.
- PR #4 : date + heure de pesée (repli epoch).
- PR #5 : sante_jour + charge_entrainement.
- PR #6 : durées des états repos/stress/actif (correction d'interprétation par Phil).
- PR #7 : CLAUDE.md.
- PR #8 : règle de documentation vivante (synchronisation Notion après chaque merge).
