# lms_proof_of_play

> 🇬🇧 **English version first.** 🇫🇷 La version française complète se trouve plus bas : [aller à la version française](#version-francaise).

Anchor (Solana) "Proof of Play" distribution program for Last Man Skating. No
stake, no on-chain randomness: it distributes a weekly prize pool (SPL token)
in proportion to a score already validated off-chain (Cloudflare Worker) and
submitted by a trusted backend authority. It also distributes "Sanctuaire
Seeker" trophy NFTs (Proximity mode, "Proof of Meet") for confirmed physical
meetings between two players.

**Program ID (devnet):** `GQeKyxHQGFv46z8hM5KocYa5hrUSea1hYJrDXyH41caH`

## Flow — weekly prize pool (Proof of Play)

1. **`initialize_weekly_pool(week_id)`** — opens the week's pool (PDA
   `["pool", week_id]`) and creates the SPL vault that holds it (PDA
   `["vault", week_id]`).
2. **`fund_pool(amount)`** — funds the pool (SPL transfer from any funding
   account). Optional, may be called several times before `finalize_pool`.
3. **`submit_score(week_id, new_score)`** — called ONLY by `authority` (the
   Cloudflare Worker key, `SOLANA_AUTHORITY_SECRET_KEY`), after the weekly
   delta has been validated on the Firebase RTDB side. `new_score` is the
   week's CUMULATIVE score (not a delta): the `PlayerScore` account is
   overwritten, not incremented.
4. **`finalize_pool(week_id)`** — the backend authority closes the week: no more
   `submit_score` is possible, `total_score` is frozen. **Irreversible in
   practice**: real case of 22/09/2026 where a wrong score (36 instead of 116,
   a Worker-side bug — see `lms-proof-of-play-worker/README.md`, point 14) was
   locked in by an automatic finalization triggered before it could be
   corrected. No cancel/correct instruction exists in this program after
   finalization.
5. **`claim_scratch(week_id)`** — the player (signer) claims their share:
   `payout = 75% * pot * (their_score / total_score) + 25% * pot / eligible_players`.
   Direct SPL transfer from the vault (signed by the `weekly_pool` PDA), sets
   `claimed = true`.

Eligibility threshold for the equal-share envelope (25%):
`EQUAL_SHARE_MIN_SCORE = 9`.

`initialize_weekly_pool` and `fund_pool` are now triggered automatically every
week by the Cloudflare Worker (see `lms-proof-of-play-worker/`,
`poolLifecycle.ts`) — the manual call described above remains possible
(`/init-pool` endpoint or Playground script) without causing double funding
(guard on `total_pot > 0`).

## Flow — "Sanctuaire Seeker" NFT (Proximity mode / Proof of Meet)

6. **`initialize_mint_counter()`** — to be called only once after the program's
   first deployment (not per week, unlike the pool). Creates the singleton
   `MintCounter` PDA (seeds `["mint_counter"]`) that carries the global
   scarcity of the two tiers.
7. **`mint_meeting_nft(is_premium_a, is_premium_b, name_a, uri_a, name_b, uri_b)`**
   — atomic mint of 2 Metaplex Core NFTs (one per player) in a single call:
   - `player_a` and `player_b` must both **sign** the transaction — this double
     signature is the on-chain proof of the physical meeting (Nearby detection
     on the client side only puts the two players in contact; it cannot be
     verified on-chain).
   - **Independent tiers** (IDL of 20/09/2026): `is_premium_a` and
     `is_premium_b` are two distinct booleans; each player receives the tier
     matching their own hardware (Seed Vault = premium). This paragraph
     previously described a single `is_premium` for the whole meeting.
   - Per-tier scarcity via the `MintCounter` counter
     (`classic_minted_count`/`premium_minted_count`), capped at
     `CLASSIC_TIER_CAP = 10 000` / `PREMIUM_TIER_CAP = 1 000` — no `supply` on a
     single mint (it would become fungible).
   - Per-wallet limit: `PlayerMintRecord` PDA (seeds `["player_mint",
     player_pubkey]`, field `last_mint_at`) for each of the two players. The
     lifetime lock was replaced by a **cooldown** (error `MintCooldownActive`,
     6012; `MINT_COOLDOWN_SECONDS` = 86 400 s, i.e. 24 h, verified in `lib.rs`
     on 03/10/2026). The limit is per **wallet**, not per phone/person: a new
     wallet can always mint. The client reads `last_mint_at` before starting the
     flow.
   - Fees (verified in `lib.rs`, 03/10/2026): `player_a` and `player_b` are both
     signers and writable; each pays the rent of **their own** NFT (`CreateV1`
     CPI, payer = the player) and, the first time only, of their own
     `PlayerMintRecord` (`init_if_needed`). There is no longer a single `payer`
     account nor an `InvalidPayer` constraint. Network transaction fees are
     those of the `fee payer` of the transaction built on the client side (the
     builder).

## Metaplex Core CPI — hand-built, without the `mpl-core` crate

Important particularity of this program: **no dependency on `mpl-core`** in
`Cargo.toml`. Reason: Solana Playground (used to build and deploy this program)
only compiles a closed list of server-side pre-approved crates, which does not
include `mpl-core` — impossible to make it work even by explicitly adding it to
`Cargo.toml`. The CPI to Metaplex Core's `CreateV1` instruction is therefore
encoded by hand (see `build_create_v1_instruction` in `src/lib.rs`), with only
`anchor_lang::solana_program` and `borsh`:

- Instruction discriminator: `0u8`.
- Borsh arguments: `data_state` (1 byte, `AccountState` = `0`, confirmed
  empirically on devnet), `name`, `uri`, `plugins` (always `None` here, `1`
  byte).
- 8 exact accounts, in order: `asset`, `collection`, `authority`, `payer`,
  `owner`, `update_authority`, `system_program`, `log_wrapper`. Absent optional
  accounts (`collection`, `authority`, `update_authority`, `log_wrapper`) are
  replaced by the address of the Metaplex Core program itself
  (`CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`), read-only, non-signer — an
  internal convention not documented in the official guides, reproduced from the
  crate's generated source code. `log_wrapper` required a correction: despite
  being "optional", omitting it entirely causes a runtime error
  `insufficient account keys for instruction` — it must also receive this
  placeholder.

If Metaplex Core publishes a new version of its `Create` instruction (change of
discriminator, account order or arguments), this code will have to be updated
manually — no automatic compatibility check exists since we no longer depend on
the official crate.

## Security

The program never judges the legitimacy of a match — it fully trusts `authority`
(the Cloudflare Worker) for the prize pool, and the two signatures of
`mint_meeting_nft` for the Proximity meeting. Anti-spoofing responsibility lies
with the client/backend, not the on-chain contract.

**Anti-cheat (collusion / self-play) — known limitation, deliberate choice not
to fix it:** `duelStats`/`ffaStats` are client-side self-declared counters
(Firebase RTDB), with no verifiable link to the real identity of the opponent. A
player could in theory inflate their score by playing against a second account
they control. The only current safeguard: a per-player weekly cap (21 duels / 14
FFA) that bounds the scale of an abuse without structurally preventing it.

A fix exists on paper (a `matchHistory/{matchId}` node recording both `uid`s at
the end of each match, score computed only from victories against a distinct
opponent), but it **will not be implemented**. Deliberate decision: the game's
business model relies on advertising revenue (AdMob) from the public version,
which is generated whether or not the score is "legitimate" — abuse of this
mechanism therefore costs the project nothing and is not considered a risk
justifying the extra complexity before the hackathon deadline. Documented here
transparently rather than fixed.

Other protections already in place: anti double-claim (`claimed` bool on
`PlayerScore`), strict check that the signer of `claim_scratch` matches the
`player` of the targeted `PlayerScore` (PDA seeds), `u128` payout calculations
to avoid any overflow, 24 h per-wallet cooldown on `mint_meeting_nft` (see
above).

**"Seeker Squad" cosmetic skin** (bonus originally planned for owning 2 NFTs
from different devices): **abandoned**, will not be implemented.

## Tests

8/8 unit tests passing (`anchor.test.ts`, Solana Playground environment — no
Chai available, a home-made mini-implementation of the needed assertions).
Covers: initialization, funding, submission of 3 scores (including one exactly
at the eligibility threshold), finalization, correct 75/25 split for a dominant
score and a minimal-but-eligible score, refusal of a double claim, refusal of a
player claiming another's score.

The 3 critical pool instructions (`submit_score`, `claim_scratch`,
`finalize_pool`) were additionally validated manually on-chain on devnet, with a
physical Seeker wallet + Phantom.

`initialize_mint_counter` and `mint_meeting_nft` were validated manually
on-chain on devnet via Playground client scripts (see `client/`, below): real
mint confirmed (asset created, owner = Metaplex Core program, checked via
Solscan and Helius DAS `getAssetsByOwner`), then in real conditions from the
game (Nearby meeting → MWA double signature → mint) after fixing two
client-side robustness bugs (stale RTDB status, expired MWA `authToken` — see
the root README for details).

### Client scripts (`client/`)

- `client.ts` — original Playground boilerplate (address/balance check).
- `client-fund-pool.ts` — manual init + funding of the weekly pool (used for
  tests before the Worker automation).
- `client-mintNFT.ts` — end-to-end test of `mint_meeting_nft` with two
  throwaway wallets generated locally (`Keypair.generate()`).

## Known limitations (beyond anti-cheat)

- The token is **LMS**. The current mint is a devnet test mint (6 decimals,
  created via Solana Playground); the mainnet LMS mint remains to be deployed.
- `week_id` capped at `WEEK_ID_LEN = 8` characters for PDA seeds — compatible
  with the `"YYYY-Www"` format (e.g. `"2026-W37"`) used on the client side, but
  to watch if the format changes.
- The hand-coded Metaplex Core CPI (see dedicated section above) has no
  guarantee of compatibility with a future version of the official program's
  `Create` instruction.
- No on-chain Metaplex Collection grouping the "Sanctuaire Seeker" NFTs —
  deliberate decision (simplicity before deadline). Consequence: ownership
  verification on the game side is done by exact comparison of the metadata URI
  rather than by filtering on a collection.
- Fee sharing of `mint_meeting_nft`: 50/50 per player (see the "Fees" point of
  flow 7), verified in `lib.rs`.

## Build & deployment

Developed and tested on Solana Playground. Dependencies: `anchor-lang 0.29.0`,
`anchor-spl 0.29.0` only (see `Cargo.toml`) — **no dependency on `mpl-core`**,
see the CPI section above for the reason. To redeploy an up-to-date IDL on the
client side (`lms-proof-of-play-worker/src/idl/`), export from Playground
("Export IDL" button) after any change to the program.

## Audit of 02/10/2026 — what concerns this program

The Rust code was re-read on 03/10/2026 for `submit_score`, `finalize_pool`,
`claim_scratch` and `mint_meeting_nft` (no obvious flaw on these instructions);
`initialize_weekly_pool`, `fund_pool` and the Metaplex CPI were not re-read. The
other points come from the client, the RTDB rules and the READMEs.

- The program now exposes **7 instructions**: `initialize_weekly_pool`,
  `fund_pool`, `submit_score`, `finalize_pool`, `claim_scratch`,
  `initialize_mint_counter`, `mint_meeting_nft`.
- **The client only reads `PlayerScore`**: it never writes a score on-chain
  (only the Worker's `authority` does).
- **Wallet / `uid` fragmentation** (see Worker README, point 15): **fixed on the
  Worker side on 03/10/2026** (the deltas of all `uid`s of the same wallet are
  summed before the single `submit_score`). The program itself still overwrites
  the `PlayerScore`: it is the Worker that guarantees a single submission per
  wallet.
- **`wallets/{uid}` is not proof of ownership**: the rules only check the format
  of the address. A user can declare another wallet's address as their own,
  which authorizes them to write into `claimPendingWeeks/<that address>/…`. On
  the client side, the list of weeks read from Firebase is not capped before the
  on-chain scan (see `AUDIT_LMS.md`, F-01).

## Update of 02/10/2026 — what the meeting mint proves (and does not prove)

- The **co-signature** proves that **two wallets consented** to the same
  transaction. Nothing about physical proximity enters `mint_meeting_nft`: the
  instruction only receives the two players, the two assets, the tiers and the
  names/URIs. Exact wording to use: "meeting co-signed by two wallets, triggered
  by a Nearby connection" — and not "cryptographic proof of proximity".
- On the client side, the mint is launched only if RADAR mode is armed **and** a
  Nearby contact has been observed (`_lmsRadarProximityVerified`, v2308). A
  modified client can bypass this local condition; for a proof truly tied to the
  local channel, the transaction to co-sign would have to travel over Nearby
  rather than Firebase (a `sendPayload` method to add to the Kotlin plugin,
  which today only exposes `setLocalPayload`, `start`, `connectTo`, `stop`,
  `isSupported`, `getState`). Not implemented.
- The signer now validates the builder's entire transaction before showing it to
  the wallet (root README).
- **Tiers, names and URIs are declared by the client (verified in `lib.rs`,
  03/10/2026)**: `is_premium_a/b`, `name_a/b` and `uri_a/b` are arguments not
  checked by the program, which only applies the caps (`CLASSIC_TIER_CAP`
  10 000 / `PREMIUM_TIER_CAP` 1 000) and the 24 h per-wallet cooldown. In normal
  play, the app only sends `is_premium = true` on a device with Seed Vault; but
  a modified client or a script (outside the app) with two wallets controlled by
  the same person could co-sign a "premium" mint without Seed Vault, consume the
  premium cap by rotating wallets (cost: account rent), or unlock the game's
  `seekerNft` skin, which compares the URI. Cosmetic and scarcity impact,
  consistent with the already documented choice not to judge legitimacy on-chain;
  worth keeping in mind for the "scarcity" pitch.

---

<a id="version-francaise"></a>

# 🇫🇷 Version française

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
7. **`mint_meeting_nft(is_premium_a, is_premium_b, name_a, uri_a, name_b, uri_b)`** — mint
   atomique de 2 NFT Metaplex Core (un par joueur) en un seul appel :
   - `player_a` et `player_b` doivent tous deux **signer** la transaction —
     c'est cette double signature qui constitue la preuve on-chain de la
     rencontre physique (la détection Nearby côté client ne fait que mettre
     les deux joueurs en contact, elle n'est pas vérifiable on-chain).
   - **Tiers indépendants** (IDL du 20/09/2026) : `is_premium_a` et
     `is_premium_b` sont deux booléens distincts ; chaque joueur reçoit le
     tier correspondant à son propre matériel (Seed Vault = premium). Ce
     paragraphe décrivait avant un `is_premium` unique pour la rencontre.
   - Rareté par tier via le compteur `MintCounter`
     (`classic_minted_count`/`premium_minted_count`), plafonnée à
     `CLASSIC_TIER_CAP = 10 000` / `PREMIUM_TIER_CAP = 1 000` — pas de
     `supply` sur un mint unique (deviendrait fongible).
   - Limite par wallet : PDA `PlayerMintRecord` (seeds `["player_mint",
     player_pubkey]`, champ `last_mint_at`) pour chacun des deux joueurs.
     Le verrou à vie a été remplacé par un **cooldown** (erreur
     `MintCooldownActive`, 6012 ; `MINT_COOLDOWN_SECONDS` = 86 400 s, soit
     24 h, vérifié dans `lib.rs` le 03/10/2026). Limite par
     **wallet**, pas par téléphone/personne : un nouveau wallet peut
     toujours minter. Le client lit `last_mint_at` avant d'engager le flux.
   - Frais (vérifié dans `lib.rs`, 03/10/2026) : `player_a` et `player_b`
     sont tous deux signataires et modifiables ; chacun paie le rent de
     **son propre** NFT (CPI `CreateV1`, payeur = le joueur) et, la première
     fois seulement, de son propre `PlayerMintRecord` (`init_if_needed`). Il
     n'y a plus de compte `payer` unique ni de contrainte `InvalidPayer`. Les
     frais de transaction réseau sont ceux du `fee payer` de la transaction
     construite côté client (le builder).

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
payout en `u128` pour éviter tout overflow, cooldown de 24 h par wallet
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

- Le jeton est **LMS**. Le mint actuel est un mint de test sur devnet
  (6 décimales, créé via Solana Playground) ; le mint LMS mainnet reste à
  déployer.
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
- Partage des frais de `mint_meeting_nft` : 50/50 par joueur (voir le point
  « Frais » du flux 7), vérifié dans `lib.rs`.

## Build & déploiement

Développé et testé sur Solana Playground. Dépendances : `anchor-lang
0.29.0`, `anchor-spl 0.29.0` uniquement (voir `Cargo.toml`) — **aucune
dépendance à `mpl-core`**, voir la section CPI ci-dessus pour la raison.
Pour redéployer une IDL à jour côté client
(`lms-proof-of-play-worker/src/idl/`), exporter depuis Playground (bouton
"Export IDL") après tout changement du programme.

## Audit du 02/10/2026 — ce qui touche ce programme

Le code Rust a été relu le 03/10/2026 pour `submit_score`, `finalize_pool`,
`claim_scratch` et `mint_meeting_nft` (aucune faille manifeste sur ces
instructions) ; `initialize_weekly_pool`, `fund_pool` et le CPI Metaplex n'ont
pas été relus. Les autres points viennent du client, des rules RTDB et des
README.

- Le programme expose désormais **7 instructions** : `initialize_weekly_pool`,
  `fund_pool`, `submit_score`, `finalize_pool`, `claim_scratch`,
  `initialize_mint_counter`, `mint_meeting_nft`.
- **Le client ne fait que lire `PlayerScore`** : il n'écrit jamais de score
  on-chain (seule l'`authority` du Worker le fait).
- **Fragmentation wallet / `uid`** (voir README du Worker, point 15) : **corrigée
  côté Worker le 03/10/2026** (les deltas de tous les `uid` d'un même wallet sont
  additionnés avant l'unique `submit_score`). Le programme, lui, écrase toujours
  le `PlayerScore` : c'est le Worker qui garantit un seul envoi par wallet.
- **`wallets/{uid}` n'est pas une preuve de possession** : les rules vérifient
  seulement le format de l'adresse. Un utilisateur peut déclarer l'adresse d'un
  autre wallet comme sienne, ce qui l'autorise à écrire dans
  `claimPendingWeeks/<cette adresse>/…`. Côté client, la liste des semaines
  lue dans Firebase n'est pas plafonnée avant le scan on-chain (voir `AUDIT_LMS.md`,
  F-01).

## Mise à jour du 02/10/2026 — ce que prouve (et ne prouve pas) le mint de rencontre

- La **co-signature** prouve que **deux wallets ont consenti** à la même transaction. Rien de la proximité physique
  n'entre dans `mint_meeting_nft` : l'instruction ne reçoit que les deux joueurs, les deux assets, les tiers et les
  noms/URI. Formulation exacte à utiliser : « rencontre co-signée par deux wallets, déclenchée par une connexion
  Nearby » — et non « preuve cryptographique de proximité ».
- Côté client, le mint n'est lancé que si le mode RADAR est armé **et** qu'un contact Nearby a été constaté
  (`_lmsRadarProximityVerified`, v2308). Un client modifié peut contourner cette condition locale ; pour une preuve
  réellement liée au canal local, il faudrait faire transiter la transaction à co-signer par Nearby plutôt que par
  Firebase (méthode `sendPayload` à ajouter au plugin Kotlin, qui n'expose aujourd'hui que `setLocalPayload`, `start`,
  `connectTo`, `stop`, `isSupported`, `getState`). Non implémenté.
- Le signataire valide désormais toute la transaction du builder avant de la montrer au wallet (README racine).
- **Tiers, noms et URI sont déclarés par le client (vérifié dans `lib.rs`, 03/10/2026)** : `is_premium_a/b`,
  `name_a/b` et `uri_a/b` sont des arguments non contrôlés par le programme, qui n'applique que les plafonds
  (`CLASSIC_TIER_CAP` 10 000 / `PREMIUM_TIER_CAP` 1 000) et le cooldown de 24 h par wallet. Dans le jeu normal,
  l'appli n'envoie `is_premium = true` que sur un appareil avec Seed Vault ; mais un client modifié ou un script (hors
  appli) avec deux wallets contrôlés par la même personne pourrait co-signer un mint « premium » sans Seed Vault,
  consommer le plafond premium en renouvelant les wallets (coût : le rent des comptes), ou débloquer le skin
  `seekerNft` du jeu, qui compare l'URI. Impact cosmétique et de rareté, cohérent avec le choix déjà documenté de ne
  pas juger la légitimité côté chaîne ; à garder en tête pour le discours « rareté ».
