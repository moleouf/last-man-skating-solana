# lms-proof-of-play-worker

Cloudflare Worker qui calcule les scores hebdo et soumet `submitScore` +
`finalizePool` on-chain — remplace la Cloud Function Firebase évitée pour
ne pas activer de carte bancaire.

## Statut

Worker fonctionnel, testé de bout en bout sur devnet — **`submit_score`
confirmé avec succès on-chain le 12/09/2026** (signature vérifiée sur
Solana Explorer, statut "Success", finalisée).

✅ Fait :
1. **`wallets/{uid}`** — Rule RTDB ajoutée, écriture client fonctionnelle
   (adresse bien reçue dans `wallets/{uid}` avec `address` + `ts`).
2. **`src/idl/lms_proof_of_play.json`** — exporté/converti à la main
   (pré-0.30), **validé en conditions réelles** : `submit_score` appelé
   via ce fichier IDL a réussi on-chain (discriminators corrects).
3. **KV `WEEK_SNAPSHOT_KV`** — namespace créé, id renseigné dans `wrangler.jsonc`.
4. **RPC devnet** — migré de l'endpoint public `api.devnet.solana.com`
   (bloqué par rate-limit IP, erreur 403) vers un endpoint dédié QuickNode.
   Timeout de confirmation augmenté à 60s dans `solanaSubmit.ts` (le
   endpoint public confirmait sous 10s ; QuickNode a mis plus de 30s sur au
   moins un test, d'où l'ajustement).
5. **Pool hebdomadaire réelle** initialisée on-chain pour `weekId = 2026-W37`
   (mint de test devnet, 6 décimales, simulant SKR).
6. Les 8 tests unitaires Anchor passent (init pool, fund, submit_score,
   finalize, claim 75/25, anti double-claim, anti-usurpation).

⚠️ Limitation connue (anti-triche) :
- `duelStats`/`ffaStats` sont des compteurs auto-déclarés par le client
  (`wins`/`losses`), sans lien vérifiable avec l'identité de l'adversaire.
  Un joueur avec wallet connecté peut gonfler son score en jouant contre un
  second compte qu'il contrôle (collusion/self-play) — la seule protection
  actuelle est un plafond hebdomadaire par joueur dans `scoring.ts`
  (max 294 points/semaine : `duelWins` capé à 21, `ffaWins` capé à 14),
  qui limite l'ampleur mais n'empêche pas la fraude elle-même.
- Correctif prévu (post-hackathon) : enregistrer les deux `uid` de chaque
  match dans un nouveau nœud `matchHistory/{matchId}` au moment où une
  `duelRooms`/`ffaRooms` se termine, et calculer le score hebdo à partir de
  cet historique (victoires contre un adversaire distinct uniquement)
  plutôt que du compteur agrégé actuel.

✅ Fait (suite) :
7. **`fund_pool` réel** — pool `2026-W37` alimentée avec succès le
   12/09/2026 (1000 tokens de test, mint devnet 6 décimales). Testé via
   script Solana Playground (mint + fundPool), pas encore automatisé
   dans le worker (voir "Ce que ce worker suppose déjà fait ailleurs").

✅ Fait (suite) :
8. **`claim_scratch` validé de bout en bout** — flux complet testé sur
   device réel le 13/09/2026 : wallet connecté → lecture on-chain
   (WeeklyPool/PlayerScore) → construction transaction côté client →
   signature via MWA/Phantom → confirmation on-chain → tokens reçus.
   Double-claim bien bloqué par le programme (`AlreadyClaimed`) lors
   d'une tentative répétée.

Les 3 instructions critiques (submit_score, fund_pool, claim_scratch)
sont maintenant validées en conditions réelles, pas seulement en tests
Playground.

⏳ Reste à faire avant soumission finale :
- Décision mint devnet (simulation) vs SKR mainnet réel pour la démo
- Déplacer `SOLANA_RPC_URL` (worker) de `vars` vers un secret Cloudflare
- Limitation anti-triche (collusion/self-play) toujours ouverte —
  documentée, correctif reporté après le hackathon
- Limitation multi-semaines : l'UI ne gère que la semaine courante,
  pas de rattrapage de gains de semaines passées non réclamées

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
- `solanaSubmit.ts` : timeout de confirmation porté à 60s (voir Statut
  ci-dessus).

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

## Développement local

Le stockage KV local (Miniflare) peut échouer silencieusement si le chemin
du projet est trop long (limite Windows ~260 caractères) — symptôme observé :
`internal error; reference = ...` sur toute lecture/écriture KV. Si ça arrive,
forcer un répertoire de stockage local court :

```bash
wrangler dev --persist-to="C:\wrangler-state"
```

(déjà intégré dans le script `dev` de `package.json`)

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
  Pour `2026-W37`, la pool a été initialisée et alimentée manuellement
  via des scripts de test Solana Playground, avec un mint devnet de test
  (6 décimales) simulant SKR — fait.
- Le noeud `wallets/{uid}` — fait.

## Premier run après déploiement (ou après tout reset du KV)

Le tout premier run n'a aucun snapshot précédent dans le KV — `weekSnapshot.ts`
traite alors chaque joueur comme ayant un delta de 0 (aucun score, personne
n'est payé) et se contente d'enregistrer le premier snapshot. C'est le run
*suivant*, une semaine plus tard (ou le prochain appel manuel après une
nouvelle partie jouée), qui produira le premier vrai règlement.