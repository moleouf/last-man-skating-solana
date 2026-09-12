# lms-proof-of-play-worker

Cloudflare Worker qui calcule les scores hebdo et soumet `submitScore` +
`finalizePool` on-chain — remplace la Cloud Function Firebase évitée pour
ne pas activer de carte bancaire.

## Statut

Worker fonctionnel, testé de bout en bout sur devnet le 12/09/2026.

✅ Fait :
1. **`wallets/{uid}`** — Rule RTDB ajoutée, écriture client fonctionnelle
   (confirmé : adresse bien reçue dans `wallets/{uid}` avec `address` + `ts`).
2. **`src/idl/lms_proof_of_play.json`** — exporté depuis Solana Playground,
   présent dans `src/idl/`.
3. **KV `WEEK_SNAPSHOT_KV`** — namespace créé, id renseigné dans `wrangler.jsonc`.

Pool hebdomadaire réelle initialisée on-chain pour `weekId = 2026-W37`
(mint de test devnet, 6 décimales — voir "Ce que ce worker suppose déjà
fait ailleurs"). Les 8 tests unitaires Anchor passent (init pool, fund,
submit_score, finalize, claim 75/25, anti double-claim, anti-usurpation).

⏳ Reste à faire :
- `fund_pool` réel (la pool `2026-W37` n'a pas encore été alimentée)
- Lien `claim_scratch` ↔ animation front (carte à gratter)
- Décision mint devnet (simulation) vs SKR mainnet réel avant soumission finale

## Ce qui a changé par rapport à la version précédente (Firestore)

- `firestoreQuery.ts` → `rtdbQuery.ts` : API REST RTDB (`GET /duelStats.json`,
  `/ffaStats.json`, `/wallets.json`) au lieu de Firestore.
- `firebaseAuth.ts` : scope OAuth `firebase.database` au lieu de
  `datastore.readonly`. **Donne au compte de service le rôle IAM "Firebase
  Realtime Database Viewer"** (Google Cloud Console > IAM) — c'est ce rôle,
  pas le scope, qui garantit un accès lecture seule.
- `scoring.ts` : formule réduite à `duelWins`/`ffaWins` — `ffaEliminations`
  et `missionsCompleted` n'ont aucune donnée synchronisée serveur (confirmé
  dans le HTML : missions 100% `localStorage`, aucun champ éliminations FFA
  dans les Rules).
- `weekSnapshot.ts` (nouveau) : `duelStats`/`ffaStats` sont cumulatifs à vie,
  pas hebdo — ce fichier calcule le delta hebdo via un snapshot KV pris au
  run précédent.
- `index.ts` : calcul de `week_id` réécrit pour être identique à
  `_lmsWeekKey()` côté jeu (ISO 8601 Thursday-based) — l'ancienne formule
  pouvait diverger. Le secret du endpoint manuel vient maintenant de
  `env.MANUAL_TRIGGER_SECRET` (plus de valeur en dur dans le code).

## Installation

```bash
npm install
npx wrangler login
npx wrangler kv namespace create WEEK_SNAPSHOT_KV
# colle l'id retourné dans wrangler.jsonc à la place de METS-TON-KV-ID-ICI
```

## Secrets (jamais dans le code, jamais commités)

```bash
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
# colle le JSON complet du compte de service (Firebase Console >
# Paramètres du projet > Comptes de service > Générer une nouvelle clé privée)

npx wrangler secret put SOLANA_AUTHORITY_SECRET_KEY
# colle la clé privée base58 du wallet authority

npx wrangler secret put MANUAL_TRIGGER_SECRET
# choisis une valeur aléatoire longue, sert à protéger /run-settlement
```

## Test en local (sans attendre le cron)

```bash
npm run dev
curl -X POST "http://localhost:8787/run-settlement?weekId=2026-W37" \
  -H "X-Trigger-Secret: <ta valeur de MANUAL_TRIGGER_SECRET>"
```

## Déploiement

```bash
npm run deploy
```

Le Cron Trigger défini dans `wrangler.jsonc` s'active automatiquement au
déploiement — vérifiable dans le dashboard Cloudflare (Workers & Pages >
ton worker > Triggers).

## Ce que ce worker suppose déjà fait ailleurs

- `initialize_weekly_pool` et `fund_pool` pour le `weekId` de la semaine —
  pas automatisé ici volontairement, tant que le montant de la cagnotte
  n'est pas déterminé par une logique automatique (sponsoring, tips...).
  Pour `2026-W37`, la pool a été initialisée manuellement via un script de
  test Solana Playground avec un mint devnet de test (6 décimales) simulant
  SKR — pas encore alimentée (`fund_pool` en attente).
- Le noeud `wallets/{uid}` (voir section Statut ci-dessus) — désormais fait.

## Premier run après déploiement

Le tout premier run n'a aucun snapshot précédent dans le KV — `weekSnapshot.ts`
traite alors chaque joueur comme ayant un delta de 0 (aucun score, personne
n'est payé) et se contente d'enregistrer le premier snapshot. C'est le run
*suivant*, une semaine plus tard, qui produira le premier vrai règlement. Si
tu veux tester le calcul de score sans attendre une semaine réelle, force un
snapshot antérieur dans le KV à la main avant de déclencher `/run-settlement`.