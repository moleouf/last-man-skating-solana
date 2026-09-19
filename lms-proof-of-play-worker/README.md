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
   dans le worker à ce moment-là (voir "Automatisation de l'ouverture de
   pool" ci-dessous pour la suite).

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

✅ Fait (suite) :
9. **Fix désync cron/client (13/09/2026)** — le cron tournait à 3h UTC le
   lundi, alors que le client bascule de semaine ISO à 0h UTC pile
   (`_lmsWeekKey()`) : fenêtre de 3h où le bouton RÉCLAMER ne trouvait plus
   la pool de la semaine qui venait de finir (déjà "passée" côté client,
   pas encore réglée on-chain côté worker). Cron déplacé à 00:01 UTC
   (`wrangler.jsonc`), `weekIdBeingSettled()` ajusté en conséquence (recul
   de 5 min au lieu de 24h).
10. **Fix perte de delta sur échec total** — `saveSnapshot()` avançait le
    snapshot KV inconditionnellement juste après la soumission on-chain,
    même quand TOUTES les soumissions de la semaine échouaient (ex. tout
    le monde en `PoolAlreadyFinalized`). Le delta de la semaine disparaissait
    alors sans être ni payé ni reporté. Corrigé : le snapshot n'avance que
    si au moins une soumission a réussi (`succeeded.length > 0`) — un run
    entièrement raté laisse le snapshot inchangé, donc rejouable au run
    suivant. La réponse JSON du endpoint inclut maintenant `snapshotAdvanced`
    pour vérifier ça facilement après coup.

✅ Fait (suite) :
11. **Automatisation de l'ouverture ET du financement de pool (15/09/2026)** —
    `initialize_weekly_pool` **et** `fund_pool` pour la semaine à venir
    sont maintenant déclenchés automatiquement par le même cron que le
    règlement (00:01 UTC le lundi), immédiatement après la finalisation
    de la semaine précédente. Voir `src/poolLifecycle.ts`.
    - **Init** : idempotente — une pool déjà initialisée ne fait pas
      échouer le run, l'erreur "already in use" est attrapée et
      journalisée sans stopper le reste du cron.
    - **Fund** : montant fixe défini par le secret `AUTO_FUND_AMOUNT`
      (voir "Secrets" ci-dessous). Garde-fou intégré : `fund_pool`
      s'additionne à chaque appel (il ne remplace jamais le pot existant),
      donc si la pool a déjà un `totalPot > 0` au moment où le cron tourne
      (= financée manuellement avant, via `/init-pool` ou un script
      Playground), l'auto-fund est **sauté** pour cette semaine — pas de
      double financement.
    - **Override manuel, sans toucher au cron** : un endpoint protégé
      `/init-pool` (même garde `X-Trigger-Secret` que `/run-settlement`)
      permet d'initialiser et/ou financer n'importe quelle semaine à la
      main, à tout moment. Utilise-le *avant* le passage du cron pour
      fixer un montant différent une semaine donnée — le cron détectera
      le pot déjà non-nul et laissera ton montant tel quel.

✅ Fait (suite) :
12. **Fix montant décimal (19/09/2026)** — `poolLifecycle.ts` convertissait
    `AUTO_FUND_AMOUNT` en unités brutes via `BigInt(amountUi)`, qui rejette
    toute valeur non entière (`BigInt(0.5)` lève une exception). Sans effet
    tant que `AUTO_FUND_AMOUNT` reste un entier (`"10"`, utilisé jusqu'ici),
    mais aurait fait échouer silencieusement l'auto-fund dès qu'un montant
    décimal serait configuré. Corrigé :
    `BigInt(Math.round(amountUi * 10 ** mintInfo.decimals))`.

⏳ Reste à faire avant soumission finale :
- Décision mint devnet (simulation) vs SKR mainnet réel pour la démo
- Limitation anti-triche (collusion/self-play) toujours ouverte —
  documentée, correctif reporté après le hackathon
- ~~Limitation multi-semaines~~ : réglée côté client le 13/09/2026 — le
  bouton RÉCLAMER rattrape maintenant jusqu'à 8 semaines de gains non
  réclamés (voir README racine, section "Réclamation multi-semaines").
  Toujours pas de deadline on-chain au-delà de cet historique.
- ~~Automatisation de l'initialisation de pool~~ : réglée le 15/09/2026
  (voir point 11 ci-dessus). Le financement (`fund_pool`) reste manuel
  par défaut, par choix.
- ~~Bug montant décimal~~ : réglé le 19/09/2026 (voir point 12 ci-dessus).

## `@coral-xyz/anchor` (SDK JS) — vérifié le 19/09/2026

`poolLifecycle.ts` construit le programme via
`new anchor.Program(idl as anchor.Idl, provider)` (sans `programId` en 2e
argument) — syntaxe valide à partir de la version 0.30 du SDK JS
`@coral-xyz/anchor`. **Confirmé dans `package.json` : `"@coral-xyz/anchor":
"^0.30.1"`** — la syntaxe actuelle est donc correcte, rien à corriger.

Rappel pour référence future : ceci est indépendant de la version
`anchor-lang` (Rust) du programme on-chain, restée en `0.29.0` (voir
`programs/lms_proof_of_play/README.md`) — les deux versionnent des choses
différentes (SDK client JS vs crate Rust on-chain) et n'ont pas à
correspondre entre elles.

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
  ci-dessus). Expose aussi `walletFromSecretKey`, une implémentation
  minimale du wallet Anchor (l'`anchor.Wallet` standard du SDK plante dans
  l'environnement Workers) — réutilisée telle quelle par `poolLifecycle.ts`
  plutôt que dupliquée.
- `poolLifecycle.ts` (nouveau, 15/09/2026) : ouverture **et financement**
  automatiques de la pool de la semaine à venir
  (`initialize_weekly_pool` + `fund_pool`), appelés depuis le même cron que
  le règlement. Voir "Automatisation de l'ouverture de pool" ci-dessus et
  le point d'attention sur la version d'Anchor JS ci-dessus.

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
# et /init-pool

npx wrangler secret put SOLANA_MINT_ADDRESS
# adresse du mint SPL (jeton de test devnet actuel) — utilisé par
# poolLifecycle.ts pour initialiser/financer la pool

# Optionnel — laisse absent pour garder fund_pool 100% manuel :
npx wrangler secret put AUTO_FUND_AMOUNT
# montant fixe (en unités du jeton, PAS en unités brutes/décimales) à
# transférer automatiquement chaque semaine, ex. "10" ou "0.5" (les
# montants décimaux sont supportés depuis le fix du 19/09/2026, voir
# point 12 ci-dessus). Absent ou vide = fund_pool reste manuel, seule
# l'init est automatique.
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

# Initialiser/financer une semaine à la main (nouveau) :
curl -X POST "http://localhost:8787/init-pool?weekId=2026-W39&amount=10" \
  -H "X-Trigger-Secret: <ta valeur de MANUAL_TRIGGER_SECRET>"
# `amount` est optionnel : sans lui, seule l'init est faite (pas de fund_pool)
```

## Déploiement

```bash
npm run deploy
```

Le Cron Trigger défini dans `wrangler.jsonc` s'active automatiquement au
déploiement — vérifiable dans le dashboard Cloudflare (Workers & Pages >
ton worker > Triggers).

**Rappel** : un `git push` ne redéploie jamais ce Worker tout seul — c'est
`npx wrangler deploy` (ou `npm run deploy`) qui pousse le code en
production. Un commit GitHub sans redéploiement documente le code mais ne
change rien au comportement réel du Worker en ligne.

## Ce que ce worker fait / suppose déjà fait ailleurs

- `initialize_weekly_pool` **et** `fund_pool` pour le `weekId` à venir —
  **automatisés** depuis le 15/09/2026, déclenchés par le même cron que
  le règlement (voir `src/poolLifecycle.ts`), avec un montant fixe défini
  par `AUTO_FUND_AMOUNT`. L'intervention manuelle reste possible à tout
  moment (endpoint `/init-pool` ou scripts Playground) sans désactiver le
  cron : le garde-fou "totalPot > 0" empêche l'auto-fund de s'additionner
  à un montant déjà posé à la main. Pour `2026-W37` et `2026-W38`, la
  pool a été initialisée et alimentée manuellement via des scripts de
  test Solana Playground, avec un mint devnet de test (6 décimales)
  simulant SKR.
- Le noeud `wallets/{uid}` — fait.
- Le mint des NFT "Sanctuaire Seeker" (mode Proximité) — **hors périmètre
  de ce Worker**, géré entièrement on-chain par le programme
  `lms_proof_of_play` (instruction `mint_meeting_nft`) et déclenché
  directement depuis le jeu (double signature MWA des deux joueurs), sans
  intervention de ce Worker ni d'aucune autorité backend. Voir
  `programs/lms_proof_of_play/README.md`.

## Premier run après déploiement (ou après tout reset du KV)

Le tout premier run n'a aucun snapshot précédent dans le KV — `weekSnapshot.ts`
traite alors chaque joueur comme ayant un delta de 0 (aucun score, personne
n'est payé) et se contente d'enregistrer le premier snapshot. C'est le run
*suivant*, une semaine plus tard (ou le prochain appel manuel après une
nouvelle partie jouée), qui produira le premier vrai règlement.
