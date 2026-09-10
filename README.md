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
- Code source : `programs/lms_proof_of_play/src/lib.rs`
- Tests : `tests/lms_proof_of_play.test.ts`

## Licence / Auteur

Développé en solo par Moleouf (Kristen Studios Games).
