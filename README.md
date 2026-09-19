# Last Man Skating — Solana Mobile Edition

Récompenser financièrement la compétition mobile réelle tombe presque toujours dans la
case gambling (mise + hasard = loterie non autorisée en France/ANJ, interdite par Google
Play) — **Proof of Play** distribue la cagnotte hebdomadaire selon la performance
compétitive réelle des joueurs (score serveur, sans mise ni tirage au sort), donc hors
du champ du gambling. **Solana Mobile** apporte le wallet self-custodial natif
(Mobile Wallet Adapter + Seed Vault du Seeker) nécessaire pour ça, sans détour par un
exchange ou du KYC custodial.

Adaptation de [Last Man Skating](https://play.google.com/store/apps/details?id=fr.kristen.lastmanskating)
(2000+ installs organiques sur Google Play) pour le **Clock In Hackathon** (RadiantsDAO / Solana Mobile).

Last Man Skating est un battle royale de skate isométrique en HTML5 canvas (9 mondes,
boss, système de skins, missions quotidiennes, multi temps réel via Firebase),
packagé nativement pour Android via Capacitor.

## Ce qui est nouveau pour le hackathon

- **Plugin Capacitor natif (Kotlin)** pour Mobile Wallet Adapter
  (`com.solanamobile:mobile-wallet-adapter-clientlib-ktx`) — intégration MWA native,
  pas de deep-link wallet, compatible Seed Vault / Seeker.
- **Programme Anchor on-chain** (`lms_proof_of_play`) distribuant une cagnotte
  hebdomadaire en SKR, proportionnellement à la performance compétitive réelle
  de la semaine — modèle **"Proof of Play"**, sans mise ni hasard sur le montant
  reçu (pas de qualification gambling).
- Split de la cagnotte : 75 % proportionnel au score, 25 % partagé également
  entre tous les joueurs actifs au-dessus d'un seuil minimal.
- **Mode Proximité ("Proof of Meet")** : détection de rencontre physique réelle
  (Google Nearby Connections, BLE+WiFi) entre deux joueurs, confirmée par une
  double signature wallet on-chain, qui mint atomiquement un NFT trophée
  **"Sanctuaire Seeker"** (Metaplex Core) pour chacun des deux joueurs — voir
  section dédiée ci-dessous.

## Prérequis pour builder

- Node.js + npm
- Android Studio (SDK 36 / compileSdk 36)
- Un appareil Android physique avec une app wallet compatible MWA installée
  (le Mobile Wallet Adapter ne fonctionne pas en émulateur)

## Build

```bash
npm install
npx cap sync android
```

Ouvrir `android/` dans Android Studio, builder et lancer sur un device physique.

La configuration Firebase (Realtime Database) est incluse en JS inline dans
`www/index.html` — aucune étape de configuration supplémentaire nécessaire.
Elle pointe vers le même backend que la version Play Store en production ;
les parties jouées pendant la période de jugement du hackathon peuvent donc
apparaître dans le classement live.

## Programme Solana

- Programme : `lms_proof_of_play`
- Réseau : Devnet
- Program ID : `GQeKyxHQGFv46z8hM5KocYa5hrUSea1hYJrDXyH41caH`
- Code source : [`programs/lms_proof_of_play/`](./programs/lms_proof_of_play)
- Tests : [`programs/lms_proof_of_play/tests/anchor.test.ts`](./programs/lms_proof_of_play/tests/anchor.test.ts)
  — 8 tests unitaires passants (init pool, fund, submit_score, finalize,
  claim 75/25, anti double-claim, anti-usurpation)

### Correctif de sécurité (13/09/2026)
Faille identifiée et corrigée : `submit_score` réinitialisait `claimed = false`
à chaque appel, y compris pour un joueur ayant déjà réclamé sa part — un
re-run du worker (retry réseau, déclenchement manuel répété) permettait un
double claim de la même cagnotte. Corrigé en retirant la réinitialisation
inconditionnelle de `claimed` dans `submit_score` (le champ n'est plus
modifié que par `claim_scratch` lui-même). Testé en conditions réelles
avant et après le correctif.

### NFT "Sanctuaire Seeker" — mint on-chain du mode Proximité (19/09/2026)

Nouvelle instruction `mint_meeting_nft` (+ `initialize_mint_counter`) dans le même
programme `lms_proof_of_play` :

- **Mint atomique de 2 NFT Metaplex Core en un seul appel** (un par joueur) — soit
  les deux CPI réussissent, soit toute la transaction échoue ; aucun état
  intermédiaire possible (élimine par construction le risque de owner erroné ou
  de mint à moitié).
- **Co-signature on-chain des deux joueurs** (`player_a`, `player_b` tous deux
  `Signer`) : c'est cette double signature qui constitue la preuve vérifiable de
  la rencontre physique, pas la détection Nearby elle-même (qui ne fait que
  mettre les deux joueurs en contact côté client).
- **Rareté par tier via compteurs PDA** (`MintCounter` : `classic_minted_count`
  / `premium_minted_count`, plafonnés à `CLASSIC_TIER_CAP = 10 000` /
  `PREMIUM_TIER_CAP = 1 000`) plutôt que via `supply` sur un mint unique
  (deviendrait fongible). Un seul tier par rencontre (pas un par joueur) :
  PREMIUM uniquement si les deux joueurs ont Seed Vault (Seeker des deux
  côtés), classic sinon.
- **Anti-double-mint** : PDA `PlayerMintRecord` (seeds = pubkey du joueur),
  créé en `init` (pas `init_if_needed`) — un deuxième mint pour un joueur déjà
  servi échoue automatiquement à la création de ce compte ("already in use"),
  sans logique de vérification manuelle à écrire.
- **CPI vers Metaplex Core construit à la main**, sans dépendance au crate
  `mpl-core` : Solana Playground ne compile qu'une liste fermée de crates
  côté serveur, qui ne l'inclut pas. L'instruction `CreateV1` est donc encodée
  directement (discriminant `0`, arguments Borsh `data_state`/`name`/`uri`/
  `plugins`, 8 comptes exacts avec placeholders `MPL_CORE_ID` pour les comptes
  optionnels absents — y compris `log_wrapper`, requis malgré son caractère
  "optionnel", confirmé empiriquement sur devnet). Voir le détail dans
  `lib.rs`, fonction `build_create_v1_instruction`.
- Limite de mint : **un NFT par wallet** (pas par téléphone/personne) —
  rien n'empêche un nouveau wallet de re-mint, mais un wallet donné ne peut
  jamais en obtenir un deuxième.
- Testé et confirmé fonctionnel sur devnet (mint réel, vérifié via Solscan et
  Helius DAS `getAssetsByOwner`).
- **Skin cosmétique "Seeker Squad"** (bonus prévu pour 2 NFT de devices
  différents) : **abandonné**, non implémenté.

Métadonnées hébergées sur `kristen.fr` (`nft/sanctuaire-seeker-classic.json` /
`-premium.json`) — pas d'Arweave/IPFS pour la démo. Pas de Collection Metaplex
on-chain regroupant les deux tiers (décision assumée : simplicité avant la
deadline ; conséquence directe sur la vérification de possession, voir
section Front ci-dessous).

## Backend de règlement (Cloudflare Worker)

Le calcul des scores hebdomadaires et la soumission on-chain (`submit_score`,
`finalize_pool`) tournent sur un Cloudflare Worker dédié — voir
[`lms-proof-of-play-worker/`](./lms-proof-of-play-worker) pour le code
complet et son propre README.

Statut au 12/09/2026 :
- Worker fonctionnel en local (`wrangler dev`), lit les stats depuis Firebase
  RTDB, calcule le delta hebdo via un snapshot KV, soumet on-chain via
  `@coral-xyz/anchor`.
- Pool hebdomadaire réelle initialisée on-chain pour `weekId = 2026-W37`
  (mint de test devnet à 6 décimales, simulant SKR).
- Reste à faire avant soumission finale : alimenter la pool (`fund_pool`),
  câbler `claim_scratch` sur l'animation front de la carte à gratter, décider
  mint devnet vs SKR mainnet réel pour la démo.

Statut au 13/09/2026 : les 3 instructions critiques (submit_score,
fund_pool, claim_scratch) sont validées en conditions réelles sur
device, wallet Phantom, devnet — flux complet fonctionnel du jeu
jusqu'à la réclamation de la cagnotte.

Statut au 15/09/2026 : pool réelle `2026-W37` réclamée avec succès en
conditions réelles sur device (voir "Réclamation multi-semaines"
ci-dessous). Pool réelle **`2026-W38`** (semaine en cours) initialisée
et financée on-chain — mint de test devnet, réclamable en fin de
semaine par les joueurs actifs.

Correctif du 19/09/2026 : `fund_pool` (script Playground et
`poolLifecycle.ts` du Worker) convertissait un montant décimal
(`AUTO_FUND_AMOUNT` ou `AMOUNT_UI`) via `BigInt(amount)`, qui rejette
toute valeur non entière — sans effet avec les montants entiers utilisés
jusqu'ici, mais aurait fait échouer tout financement en montant décimal
(ex. `0.5` token). Corrigé via `BigInt(Math.round(amount * 10 **
decimals))`.

### Réclamation multi-semaines (13/09/2026)

Le bouton "RÉCLAMER" scanne désormais toutes les semaines en attente
(jusqu'à 8, ~2 mois d'historique — voir `LMS_CLAIM_PENDING_WEEKS_MAX`),
pas seulement la semaine ISO courante. S'il y en a plusieurs, elles
s'enchaînent automatiquement : une transition "manche" façon VS de duel
(perso réellement équipé affiché) précède chaque carte à gratter, avant
de passer à la suivante. Le compte à rebours affiché dans les réglages
("Encore Xj Yh pour réclamer...") reste un rappel informatif — pas une
vraie limite : aucune expiration ni deadline n'existe on-chain (le champ
`claimed` n'a pas de notion de temps dans le programme). Une deadline
stricte on-chain + redistribution des fonds non réclamés reste envisagée
en roadmap post-hackathon, pour le cas où un joueur dépasserait les 8
semaines d'historique conservées côté client.

### Automatisation init/fund de la pool (15/09/2026)

`initialize_weekly_pool` **et** `fund_pool` sont désormais déclenchés
automatiquement chaque lundi par le Cloudflare Worker (même cron que le
règlement de la semaine précédente — voir
`lms-proof-of-play-worker/README.md`, section "Automatisation de
l'ouverture de pool"), avec un montant fixe par défaut. La main manuelle
reste possible à tout moment, sans avoir à désactiver le cron : si la
pool d'une semaine a déjà été financée à la main (via l'endpoint
`/init-pool` ou un script Playground) avant que le cron ne tourne,
l'auto-fund de cette semaine-là est automatiquement sauté (le montant
manuel ne sera pas doublé) — seule l'init reste, elle, toujours
idempotente et sans risque à laisser tourner.

## Mode Proximité — front (mint réel en jeu) (19/09/2026)

Écran de fin de match dédié au mode Proximité, dans `www/index.html` :

- Relais via RTDB `meetingMints/<uidLo>_<uidHi>` (clé canonique, indépendante
  de qui déclenche) — **pas** `duelRooms/<code>`, supprimée au moment exact
  où le match finit. Tie-break par uid pour désigner qui construit/signe en
  premier (`builder`) et qui signe en second (`signer`).
- Double signature via `signTransactions` (signe sans envoyer — nécessaire
  car `signAndSendTransactions` soumettrait la première signature seule et
  échouerait faute de la seconde) : le `builder` construit et pré-signe côté
  Metaplex (assets), le `signer` signe à son tour côté wallet, le `builder`
  soumet la transaction finalisée.
- **Bug corrigé (statut RTDB obsolète)** : la clé `meetingMints/...` n'étant
  jamais nettoyée entre deux essais, un ancien `status:'error'` d'une
  tentative précédente pouvait s'afficher instantanément côté `signer` avant
  même que la tentative en cours n'ait commencé (le `signer` attache son
  listener RTDB immédiatement, contrairement au `builder` qui attend d'abord
  la signature wallet, plus lente). Fix : `_lmsProximityMintSessionStartedAt`
  capturé au début du flux, tout statut RTDB antérieur (avec 5 s de marge)
  est ignoré.
- **Bug corrigé (authToken MWA expiré)** : `SIGN_TRANSACTIONS_FAILED:
  ...JsonRpc20RemoteException -1/authorization request failed` en conditions
  réelles — le `authToken` stocké n'était plus reconnu par le wallet. Fix
  côté plugin Kotlin (`SolanaWalletPlugin.kt`, `signTransactions`) : si
  `reauthorize(authToken)` échoue, retente un `authorize()` frais avant
  d'abandonner. Le nouveau token renvoyé est persisté côté JS
  (`localStorage`), des deux côtés (builder et signer), pour éviter de
  redéclencher une ré-autorisation complète à chaque mint suivant.
- Timeout watchdog : 25 s → 90 s (marge insuffisante en conditions réelles),
  avec gardes supplémentaires avant chaque écriture RTDB pour éviter d'écrire
  par-dessus un flux déjà fermé localement (timeout ou erreur déjà reçue).
- Règle Firebase RTDB (`rules.json`, nœud `meetingMints`) : lecture/écriture
  restreinte aux deux participants via `auth != null` (pas de contrainte sur
  `uid` — cohérent avec le niveau de confiance déjà appliqué ailleurs dans le
  jeu, ex. `submit_score`).
- Animation flip 3D (CSS `rotateY` + `perspective`) prévue pour l'onglet
  "cartes à s'offrir" (Proof of Meet, Nearby en tête-à-tête uniquement) —
  reste à faire : template de carte réutilisable, logique de transmission.

### Déblocage du skin Seeker (vérification de possession, 19/09/2026)

Le skin "Sanctuaire Seeker" (armurerie, nouvelle section dédiée entre Casques
et Skins) est débloqué via une **vérification on-chain réelle**, pas un flag
Firebase déclaratif : `getAssetsByOwner` (Helius DAS, endpoint déjà utilisé
ailleurs dans le jeu) sur le wallet connecté, comparaison de
`content.json_uri` de chaque asset aux deux URLs de métadonnées
(classic/premium). Choix assumé plutôt qu'un flag Firebase écrit côté client
(qui serait falsifiable — rien n'empêcherait un joueur d'écrire directement
`true` sans jamais avoir minté). Mise en cache par wallet avec cooldown de
15 s (pas de nouvel appel réseau à chaque rendu de la boutique, mais
re-tentative à chaque ouverture tant qu'aucun des deux tiers n'est confirmé
possédé — couvre le cas d'un mint tout juste fait, pas encore indexé côté
Helius). Toast + fanfare sonore à la première confirmation de possession.

Section boutique visible mais grisée/verrouillée (cadenas) pour qui ne
possède aucun des deux NFT, plutôt qu'invisible.

Limite connue et assumée : le déblocage cosmétique est vérifié côté client
(JS embarqué dans l'APK, désassemblable) — un joueur motivé pourrait forcer
l'affichage du skin sans posséder le NFT réel. Sans conséquence sur le NFT
lui-même (toujours honnête on-chain) ni sur les autres joueurs — même niveau
de confiance que le reste du jeu.

## Licence / Auteur

Développé en solo par Moleouf (Kristen Studios Games).
