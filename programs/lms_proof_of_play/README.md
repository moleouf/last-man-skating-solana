# lms_proof_of_play

Programme Anchor (Solana) de distribution "Proof of Play" pour Last Man
Skating. Pas de mise, pas de hasard côté chaîne : distribue une cagnotte
hebdomadaire (SPL token) proportionnellement à un score déjà validé
off-chain (Cloudflare Worker) et soumis par une autorité backend de confiance.
Distribue également des NFT trophées "Sanctuaire Seeker" (mode Proximité,
"Proof of Meet") lors de rencontres physiques confirmées entre deux joueurs.

**Program ID (devnet) :** `GQeKyxHQGFv46z8hM5KocYa5hrUSea1hYJrDXyH41caH`

## Flux — cagnotte hebdomadaire (Proof of Play)

1. **`initialize_weekly_pool(week_id)`** — ouvre la cagnotte de la semaine
   (PDA `["pool", week_id]`), crée le vault SPL qui la détient (PDA
   `["vault", week_id]`).
2. **`fund_pool(amount)`** — alimente la cagnotte (transfert SPL depuis
   n'importe quel compte financeur). Optionnel, peut être appelé plusieurs
   fois avant `finalize_pool`.
3. **`submit_score(week_id, new_score)`** — appelé UNIQUEMENT par
   `authority` (la clé du Cloudflare Worker, `SOLANA_AUTHORITY_SECRET_KEY`),
   après validation du delta hebdomadaire côté Firebase RTDB. `new_score`
   est le score CUMULÉ de la semaine (pas un delta) : le compte
   `PlayerScore` est écrasé, pas incrémenté.
4. **`finalize_pool(week_id)`** — l'autorité backend clôture la semaine :
   plus aucun `submit_score` possible, `total_score` figé. **Irréversible
   en pratique** : cas réel du 22/09/2026 où un score erroné (36 au lieu
   de 116, bug côté Worker — voir `lms-proof-of-play-worker/README.md`,
   point 14) a été verrouillé après une finalisation automatique déclenchée
   avant qu'on puisse le corriger. Aucune instruction d'annulation/correction
   post-finalisation n'existe dans ce programme.
5. **`claim_scratch(week_id)`** — le joueur (signataire) réclame sa part :
   `payout = 75% * pot * (son_score / total_score) + 25% * pot / nb_joueurs_éligibles`.
   Transfert SPL direct depuis le vault (signé par le PDA `weekly_pool`),
   marque `claimed = true`.

Seuil d'éligibilité à l'enveloppe équitable (25%) : `EQUAL_SHARE_MIN_SCORE = 9`.

`initialize_weekly_pool` et `fund_pool` sont désormais déclenchés
automatiquement chaque semaine par le Cloudflare Worker (voir
`lms-proof-of-play-worker/`, `poolLifecycle.ts`) — l'appel manuel décrit
ci-dessus reste possible (endpoint `/init-pool` ou script Playground) sans
provoquer de double financement (garde-fou sur `total_pot > 0`).

## Flux — NFT "Sanctuaire Seeker" (mode Proximité / Proof of Meet)

6. **`initialize_mint_counter()`** — à appeler une seule fois après le
   premier déploiement du programme (pas par semaine, contrairement à la
   cagnotte). Crée le PDA singleton `MintCounter` (seeds `["mint_counter"]`)
   qui porte la rareté globale des deux tiers.
7. **`mint_meeting_nft(is_premium, name_a, uri_a, name_b, uri_b)`** — mint
   atomique de 2 NFT Metaplex Core (un par joueur) en un seul appel :
   - `player_a` et `player_b` doivent tous deux **signer** la transaction —
     c'est cette double signature qui constitue la preuve on-chain de la
     rencontre physique (la détection Nearby côté client ne fait que mettre
     les deux joueurs en contact, elle n'est pas vérifiable on-chain).
   - `is_premium` est **unique pour la rencontre** (pas un bool par
     joueur) : PREMIUM uniquement si les deux joueurs ont Seed Vault
     (Seeker des deux côtés), classic sinon — jamais un tier différent
     entre les deux joueurs d'une même rencontre.
   - Rareté par tier via le compteur `MintCounter`
     (`classic_minted_count`/`premium_minted_count`), plafonnée à
     `CLASSIC_TIER_CAP = 10 000` / `PREMIUM_TIER_CAP = 1 000` — pas de
     `supply` sur un mint unique (deviendrait fongible).
   - Anti-double-mint : PDA `PlayerMintRecord` (seeds `["player_mint",
     player_pubkey]`) créé en `init` pour chacun des deux joueurs — un
     deuxième mint pour un joueur déjà servi échoue automatiquement
     ("already in use"), sans vérification manuelle à écrire. Limite par
     **wallet**, pas par téléphone/personne : un nouveau wallet peut
     toujours re-mint.
   - `payer` doit être `player_a` ou `player_b` (vérifié explicitement) —
     un seul des deux règle tous les frais (rent des comptes + frais de
     transaction), pas de split 50/50 actuellement.

## CPI Metaplex Core — construit à la main, sans le crate `mpl-core`

Particularité importante de ce programme : **aucune dépendance à
`mpl-core`** dans `Cargo.toml`. Raison : Solana Playground (utilisé pour
builder et déployer ce programme) ne compile qu'une liste fermée de crates
pré-approuvés côté serveur, qui n'inclut pas `mpl-core` — impossible de le
faire fonctionner même en l'ajoutant explicitement à `Cargo.toml`. Le CPI
vers l'instruction `CreateV1` de Metaplex Core est donc encodé à la main
(voir `build_create_v1_instruction` dans `src/lib.rs`), avec seulement
`anchor_lang::solana_program` et `borsh` :

- Discriminant d'instruction : `0u8`.
- Arguments Borsh : `data_state` (1 octet, `AccountState` = `0`, confirmé
  empiriquement sur devnet), `name`, `uri`, `plugins` (toujours `None`
  ici, `1` octet).
- 8 comptes exacts, dans l'ordre : `asset`, `collection`, `authority`,
  `payer`, `owner`, `update_authority`, `system_program`, `log_wrapper`.
  Les comptes optionnels absents (`collection`, `authority`,
  `update_authority`, `log_wrapper`) sont remplacés par l'adresse du
  programme Metaplex Core lui-même (`CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`),
  en lecture seule, non-signataire — convention interne non documentée
  dans les guides officiels, reproduite depuis le code source généré du
  crate. `log_wrapper` a nécessité une correction : malgré son caractère
  "optionnel", l'omettre entièrement provoque une erreur runtime
  `insufficient account keys for instruction` — il doit lui aussi recevoir
  ce placeholder.

Si Metaplex Core publie une nouvelle version de son instruction `Create`
(changement de discriminant, d'ordre de comptes ou d'arguments), ce code
devra être mis à jour manuellement — aucune vérification de compatibilité
automatique n'existe puisqu'on ne dépend plus du crate officiel.

## Sécurité

Le programme ne juge jamais de la légitimité d'un match — il fait
entièrement confiance à `authority` (le Worker Cloudflare) pour la
cagnotte, et aux deux signatures de `mint_meeting_nft` pour la rencontre
Proximité. C'est le client/backend qui porte la responsabilité anti-spoof,
pas le contrat on-chain.

**Anti-triche (collusion / self-play) — limitation connue, choix délibéré
de ne pas la corriger :** `duelStats`/`ffaStats` sont des compteurs
auto-déclarés côté client (RTDB Firebase), sans lien vérifiable avec
l'identité réelle de l'adversaire. Un joueur pourrait en théorie gonfler
son score en jouant contre un second compte qu'il contrôle. Seul
garde-fou actuel : un plafond hebdomadaire par joueur (21 duels / 14 FFA)
qui borne l'ampleur d'un abus sans l'empêcher structurellement.

Un correctif existe sur le papier (nœud `matchHistory/{matchId}`
enregistrant les deux `uid` à la fin de chaque match, score calculé
uniquement à partir de victoires contre un adversaire distinct), mais il
**ne sera pas implémenté**. Décision assumée : le modèle économique du
jeu repose sur les revenus publicitaires (AdMob) de la version grand
public, qui restent générés que le score soit "légitime" ou non — un
abus de ce mécanisme ne coûte donc rien au projet et n'est pas considéré
comme un risque justifiant la complexité additionnelle avant la deadline
du hackathon. Documenté ici en toute transparence plutôt que corrigé.

Autres protections déjà en place : anti double-claim (`claimed` bool sur
`PlayerScore`), vérification stricte que le signataire de `claim_scratch`
correspond au `player` du `PlayerScore` visé (seeds PDA), calculs de
payout en `u128` pour éviter tout overflow, anti-double-mint par wallet
sur `mint_meeting_nft` (voir ci-dessus).

**Skin cosmétique "Seeker Squad"** (bonus initialement prévu pour la
possession de 2 NFT provenant de devices différents) : **abandonné**, ne
sera pas implémenté.

## Tests

8/8 tests unitaires passants (`anchor.test.ts`, environnement Solana
Playground — pas de Chai disponible, mini-implémentation maison des
assertions nécessaires). Couvre : initialisation, funding, soumission de
3 scores (dont un pile au seuil d'éligibilité), finalisation, split 75/25
correct pour un score dominant et un score minimal-mais-éligible, refus
d'un double claim, refus qu'un joueur réclame le score d'un autre.

Les 3 instructions critiques de la cagnotte (`submit_score`,
`claim_scratch`, `finalize_pool`) ont en plus été validées manuellement
on-chain sur devnet, avec un wallet Seeker physique + Phantom.

`initialize_mint_counter` et `mint_meeting_nft` ont été validés
manuellement on-chain sur devnet via des scripts client Playground (voir
`client/`, ci-dessous) : mint réel confirmé (asset créé, owner =
programme Metaplex Core, vérifié via Solscan et Helius DAS
`getAssetsByOwner`), puis en conditions réelles depuis le jeu (rencontre
Nearby → double signature MWA → mint) après correction de deux bugs de
robustesse côté client (statut RTDB obsolète, `authToken` MWA expiré —
voir le README racine pour le détail).

### Scripts client (`client/`)

- `client.ts` — boilerplate Playground d'origine (vérif adresse/solde).
- `client-fund-pool.ts` — init + financement manuel de la cagnotte
  hebdomadaire (utilisé pour les tests avant automatisation Worker).
- `client-mintNFT.ts` — test de bout en bout de `mint_meeting_nft` avec
  deux wallets jetables générés localement (`Keypair.generate()`).

## Limitations connues (au-delà de l'anti-triche)

- Mint SKR encore en mode test devnet — SKR n'existe qu'en mainnet
  (aucun déploiement devnet officiel), un jeton de test Playground est
  utilisé en lieu et place pour la démo, documenté comme tel.
- `week_id` plafonné à `WEEK_ID_LEN = 8` caractères pour les seeds PDA —
  compatible avec le format `"YYYY-Www"` (ex. `"2026-W37"`) utilisé côté
  client, mais à surveiller si le format change.
- Le CPI Metaplex Core codé à la main (voir section dédiée ci-dessus)
  n'a pas de garantie de compatibilité avec une future version de
  l'instruction `Create` du programme officiel.
- Pas de Collection Metaplex on-chain regroupant les NFT "Sanctuaire
  Seeker" — décision assumée (simplicité avant deadline). Conséquence :
  la vérification de possession côté jeu se fait par comparaison exacte
  de l'URI de métadonnées plutôt que par filtrage sur une collection.
- `payer` de `mint_meeting_nft` supporte tous les frais seul (pas de
  split 50/50 entre les deux joueurs).

## Build & déploiement

Développé et testé sur Solana Playground. Dépendances : `anchor-lang
0.29.0`, `anchor-spl 0.29.0` uniquement (voir `Cargo.toml`) — **aucune
dépendance à `mpl-core`**, voir la section CPI ci-dessus pour la raison.
Pour redéployer une IDL à jour côté client
(`lms-proof-of-play-worker/src/idl/`), exporter depuis Playground (bouton
"Export IDL") après tout changement du programme.
