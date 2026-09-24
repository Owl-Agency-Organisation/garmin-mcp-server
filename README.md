# Garmin MCP Server — Owl Agency

Serveur MCP distant (Streamable HTTP) exposant les données santé Garmin Connect
comme connecteur personnalisé dans claude.ai (mobile inclus).

## Tools exposés (lecture seule)

| Tool | Données |
|---|---|
| `sommeil_recent` | Score, durée totale, phases (profond / léger / paradoxal), éveil |
| `vfc_recente` | VFC nocturne moyenne, pic 5 min, moyenne 7 jours, statut |
| `poids_recent` | Dernière pesée : poids (kg), IMC, masse grasse, masse musculaire, date et heure |
| `activites_recentes` | N dernières activités : type, durée, distance, calories, FC moyenne, bénéfice principal, RPE, sensations |
| `sante_jour` | Body battery (haut/bas/actuel), FC repos, stress moyen/max, pas, calories |
| `charge_entrainement` | Statut d'entraînement, charge aiguë/chronique, ratio + plage optimale, VO2 max course et vélo |
| `training_readiness` | Score de préparation, niveau, temps de récupération, facteurs VFC/sommeil/récupération |
| `analyse_seance` | Analyse du fichier FIT original d'une séance (voir ci-dessous) |
| `resume_hebdo` | Synthèse jour par jour sommeil + VFC sur 7 jours |

## `analyse_seance`

`analyse_seance({ date?: "YYYY-MM-DD", activity_id?: string })` : `activity_id`
prioritaire ; sinon toutes les activités de la date (3 max, ordre chronologique) ;
sans paramètre, la dernière activité. Une activité en échec renvoie
`{ activity_id, erreur }` sans bloquer les autres.

Chaîne : liste d'activités (même service que `activites_recentes`) →
`download-service/files/activity/{id}` (zip de l'export « original ») →
décompression `fflate` en mémoire → décodage `@garmin/fitsdk` (SDK officiel,
champs non documentés lus par numéro) → calcul → JSON compact (~7,5 Ko pour
1h15 de vélo). Le FIT n'est jamais écrit sur disque ; aucune position GPS
n'est lue ni renvoyée.

| Bloc | Contenu |
|---|---|
| `meta` | Sport, date/heure, durées, montre, capteurs externes (type, fabricant, protocole, logiciel, batterie), réglages montre (FTP, FC max/seuil/repos, poids), qualité (échantillonnage, secondes sans puissance/cadence, NP recalculée) |
| `natif` | Valeurs de la session FIT : distance, D+/D-, vitesse, FC, cadence, puissance, NP/IF/TSS/travail, meilleure 20 min, équilibre, efficacité de couple, fluidité, PCO, phases de puissance, assis/danseuse, calories, transpiration, effets d'entraînement, charge, fréquence respiratoire, RPE, sensations, impact Body Battery |
| `zones` | Temps par zone de puissance et de FC, bornes lues dans le FIT (message 216) |
| `courbe` | Meilleures puissances 5 s → 60 min avec FC et cadence moyennes |
| `pedalage` (vélo) | Par tranche de puissance : cadence, couple, part droite, efficacité, fluidité, FC, FR ; répartition par cadence |
| `symetrie` (vélo) | 4 quarts de séance, secondes pédalées à 74-108 % FTP : part droite, etc. ; part droite par tour ; écart Q4 − 1re moitié |
| `cardio` | RR (battements, artefacts, alignement), DFA-alpha1 par tranche de FC, seuils α1 = 0,75 / 0,50 (toutes fenêtres et fenêtres stables), temps par seuil, NP/FC et découplement, FR par tranche de FC, écart FC poignet/ceinture |
| `course` | Puissance Stryd (champs développeur), cadence, puissance/FC, splits par km, découplement hors 1er km |
| `natation` | Longueurs, bassin, SWOLF, allure /100 m par nage et par série |

Méthodes : NP = moyenne glissante 30 s à la puissance 4 (zéros inclus) ;
DFA-alpha1 = fenêtres de 120 s par pas de 30 s, boîtes 4-16 battements,
artefacts > 20 % de la médiane glissante sur 11 battements retirés, fenêtre
rejetée au-delà de 5 % d'artefacts ou sous 100 battements, seuils par
régression linéaire (fenêtres à FC > 110, seuil non calculé si |r| < 0,3).

### Test local (sans identifiants)

1. Exporter l'original depuis Garmin Connect (⚙ > « Exporter l'original »).
2. Déposer le zip dans `local/` (ignoré par git — jamais de FIT dans le repo).
3. Lancer :

```bash
node --no-warnings scripts/analyse-locale.mjs local/<activityId>.zip --json
```

`scripts/test-synthetique.mjs` encode des FIT course (Stryd) et natation
fictifs pour tester ces blocs sans données réelles.

## Architecture

- **Next.js + `mcp-handler`** sur Vercel, endpoint `POST /api/mcp/<secret>`
- **`lib/analyse-seance.ts`** : décodage FIT et calculs de `analyse_seance`
  (module séparé : Next.js n'autorise que les handlers en export de route).
- **`garmin-connect`** (librairie non officielle) : login e-mail/mot de passe
  vers l'API interne Garmin. Session et displayName mis en cache 30 min en mémoire.
- **Protection** : clé secrète obligatoire en segment de chemin (`/api/mcp/<MCP_SECRET>`),
  refus en 404 pour ne pas déclencher le flux OAuth de claude.ai.

## Variables d'environnement (Vercel > Settings > Environment Variables)

| Variable | Contenu |
|---|---|
| `GARMIN_EMAIL` | E-mail du compte Garmin Connect |
| `GARMIN_PASSWORD` | Mot de passe du compte (MFA doit être **désactivé**) |
| `MCP_SECRET` | Chaîne aléatoire longue protégeant l'endpoint |

Après ajout des variables : **redéployer** (Deployments > ⋯ > Redeploy).

## Ajout dans claude.ai

Paramètres > Connecteurs > Ajouter un connecteur personnalisé :

```
https://<projet>.vercel.app/api/mcp/<MCP_SECRET>
```

## Limites connues

- API interne Garmin, sans garantie : peut casser si Garmin change son auth.
- MFA non supporté dans ce mode. Si Garmin l'impose, migrer vers un token
  `garth` (généré une fois en local) — changement de variable, pas d'architecture.
- Rate limiting Garmin possible : les erreurs le mentionnent, réessayer plus tard.

## Développement

Branches courtes depuis `main`, PR, squash merge. `main` = production Vercel.
