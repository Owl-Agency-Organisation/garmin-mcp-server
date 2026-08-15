# Garmin MCP Server — Owl Agency

Serveur MCP distant (Streamable HTTP) exposant les données santé Garmin Connect
comme connecteur personnalisé dans claude.ai (mobile inclus).

## Tools exposés (lecture seule)

| Tool | Données |
|---|---|
| `sommeil_recent` | Score, durée totale, phases (profond / léger / paradoxal), éveil |
| `vfc_recente` | VFC nocturne moyenne, pic 5 min, moyenne 7 jours, statut |
| `resume_hebdo` | Synthèse jour par jour sommeil + VFC sur 7 jours |

## Architecture

- **Next.js + `mcp-handler`** sur Vercel, endpoint `POST /api/mcp`
- **`garmin-connect`** (librairie non officielle) : login e-mail/mot de passe
  vers l'API interne Garmin. Session mise en cache 30 min en mémoire.
- **Protection** : clé secrète obligatoire en paramètre d'URL (`?key=...`),
  claude.ai ne supportant pas les headers personnalisés.

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
https://<projet>.vercel.app/api/mcp?key=<MCP_SECRET>
```

## Limites connues

- API interne Garmin, sans garantie : peut casser si Garmin change son auth.
- MFA non supporté dans ce mode. Si Garmin l'impose, migrer vers un token
  `garth` (généré une fois en local) — changement de variable, pas d'architecture.
- Rate limiting Garmin possible : les erreurs le mentionnent, réessayer plus tard.

## Développement

Branche de travail par défaut : `develop`. `main` = production Vercel.
