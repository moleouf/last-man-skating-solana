# Last Man Skating — Solana Mobile Edition

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

## Licence / Auteur

Développé en solo par Moleouf (Kristen Studios Games).
