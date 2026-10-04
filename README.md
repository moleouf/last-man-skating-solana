# Last Man Skating — Solana Mobile Edition

## 📲 Download APK / Télécharger l'APK

**[⬇️ Download lms-solana.apk](https://github.com/moleouf/last-man-skating-solana/releases/latest/download/lms-solana.apk)**
([all releases](https://github.com/moleouf/last-man-skating-solana/releases/latest) · Android · Devnet)

- 🇬🇧 Allow "Install unknown apps" for your browser/file manager, then open the APK. If the Play Store version of the game is installed, **uninstall it first** (different signing key). A wallet with devnet SOL is required — see [Testing](#pour-tester-lapplication-juges--testeurs).
- 🇫🇷 Autorise "Installer des applications inconnues", puis ouvre l'APK. Si la version Play Store du jeu est installée, **désinstalle-la d'abord** (signature différente). Wallet avec du SOL devnet requis : voir [Pour tester](#pour-tester-lapplication-juges--testeurs).

> 🇬🇧 **English version first.** 🇫🇷 La version française complète se trouve plus bas : [aller à la version française](#version-francaise).

Financially rewarding real mobile competition almost always falls into the
gambling category (stake + chance = unauthorized lottery in France/ANJ,
forbidden by Google Play) — **Proof of Play** distributes the weekly prize pool
according to the players' real competitive performance (server-side score, no
stake and no draw), hence outside the scope of gambling. **Solana Mobile**
provides the native self-custodial wallet (Mobile Wallet Adapter + the Seeker's
Seed Vault) needed for this, without any detour through an exchange or custodial
KYC.

Adaptation of [Last Man Skating](https://play.google.com/store/apps/details?id=fr.kristen.lastmanskating)
(3000+ organic installs on Google Play) for the **Clock In Hackathon**
(RadiantsDAO / Solana Mobile).

Last Man Skating is an isometric skateboarding battle royale in HTML5 canvas (9
worlds, boss, skin system, daily missions, real-time multiplayer via Firebase),
natively packaged for Android via Capacitor.

## What is new for the hackathon

- **Native Capacitor plugin (Kotlin)** for Mobile Wallet Adapter
  (`com.solanamobile:mobile-wallet-adapter-clientlib-ktx`) — native MWA
  integration, no wallet deep-link, compatible with Seed Vault / Seeker.
- **On-chain Anchor program** (`lms_proof_of_play`) distributing a weekly prize
  pool in LMS, in proportion to the week's real competitive performance — the
  **"Proof of Play"** model, with no stake and no chance on the amount received
  (no gambling qualification).
- Pool split: 75% proportional to the score, 25% shared equally among all active
  players above a minimum threshold.
- **"MY NFTs" wallet area** in Settings: LMS balance, grid of owned NFTs, music
  NFT filter, detail view with audio player — see the dedicated section.
- **Proximity mode ("Proof of Meet")**: detection of a real physical meeting
  (Google Nearby Connections, BLE+WiFi) between two players, confirmed by an
  on-chain wallet double signature, which atomically mints a
  **"Sanctuaire Seeker"** trophy NFT (Metaplex Core) for each of the two players
  — see the dedicated section below.

## SKR integration (Solana Mobile) — read-only holder detection

When a wallet is connected, the game reads its **SKR balance on mainnet** (read-only
`getTokenAccountsByOwner` on a public mainnet RPC — no signature, no transaction, the
game itself still runs on devnet). Official SKR mint:
`SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3` (see [solanamobile.com/skr](https://solanamobile.com/skr)).

- **"SKR Holder" skin** (cosmetic): unlocked when the wallet holds at least 1 SKR; it
  appears in the Seeker skins section of the shop.
- **"SKR : n" badge** next to the LMS balance in the "MY NFTs" wallet area.
- **Cosmetic only, client-side check**: no gameplay advantage, no score or prize-pool
  effect (consistent with the *Proof of Play* model). Not testable on devnet by judges
  (SKR only exists on mainnet): see the demo video.

**Not implemented (mainnet roadmap):** weekly Proof of Play pool funded in SKR, and
SKR-priced skins.

## Build prerequisites

- Node.js + npm
- Android Studio (SDK 36 / compileSdk 36)
- A physical Android device with an MWA-compatible wallet app installed (Mobile
  Wallet Adapter does not work on an emulator)

## Build

```bash
npm install
npx cap sync android
```

Open `android/` in Android Studio, build and run on a physical device.

The Firebase configuration (Realtime Database) is included as inline JS in
`www/index.html` — no additional configuration step is needed. It points to the
same backend as the production Play Store version; games played during the
hackathon judging period may therefore appear in the live ranking.

## Solana program

- Program: `lms_proof_of_play`
- Network: Devnet
- Program ID: `GQeKyxHQGFv46z8hM5KocYa5hrUSea1hYJrDXyH41caH`
- Source code: [`programs/lms_proof_of_play/`](./programs/lms_proof_of_play)
- Tests: [`programs/lms_proof_of_play/tests/anchor.test.ts`](./programs/lms_proof_of_play/tests/anchor.test.ts)
  — 8 passing unit tests (init pool, fund, submit_score, finalize, claim 75/25,
  anti double-claim, anti-impersonation)

### Security fix (13/09/2026)
A flaw was identified and fixed: `submit_score` reset `claimed = false` on every
call, including for a player who had already claimed their share — a re-run of
the worker (network retry, repeated manual trigger) allowed a double claim of the
same pool. Fixed by removing the unconditional reset of `claimed` in
`submit_score` (the field is now only modified by `claim_scratch` itself).
Tested in real conditions before and after the fix.

### "Sanctuaire Seeker" NFT — on-chain mint of Proximity mode (19/09/2026)

New `mint_meeting_nft` instruction (+ `initialize_mint_counter`) in the same
`lms_proof_of_play` program:

- **Atomic mint of 2 Metaplex Core NFTs in a single call** (one per player) —
  either both CPIs succeed or the whole transaction fails; no intermediate state
  is possible (eliminates by construction the risk of a wrong owner or a
  half-done mint).
- **On-chain co-signature by both players** (`player_a`, `player_b` both
  `Signer`): this double signature is the verifiable proof of the physical
  meeting, not the Nearby detection itself (which only puts the two players in
  contact on the client side).
- **Per-tier scarcity via PDA counters** (`MintCounter`: `classic_minted_count`
  / `premium_minted_count`, capped at `CLASSIC_TIER_CAP = 10 000` /
  `PREMIUM_TIER_CAP = 1 000`) rather than via `supply` on a single mint (it would
  become fungible). **Independent tiers per player** (changed on 20/09/2026, see
  `lib.rs`: `is_premium_a` / `is_premium_b`): each player receives the tier
  matching their own hardware (Seed Vault = premium). An earlier version had only
  a single tier for the whole meeting.
- **Anti-farming cooldown**: `PlayerMintRecord` PDA (seeds = the player's pubkey,
  `init_if_needed`, field `last_mint_at`) — a wallet must wait
  `MINT_COOLDOWN_SECONDS` = 86 400 s (24 h) between two mints (error
  `MintCooldownActive`). Replaces the original lifetime lock (strict `init`).
- **Metaplex Core CPI built by hand**, without a dependency on the `mpl-core`
  crate: Solana Playground only compiles a closed list of crates server-side,
  which does not include it. The `CreateV1` instruction is therefore encoded
  directly (discriminator `0`, Borsh arguments `data_state`/`name`/`uri`/
  `plugins`, 8 exact accounts with `MPL_CORE_ID` placeholders for the absent
  optional accounts — including `log_wrapper`, required despite its "optional"
  nature, confirmed empirically on devnet). See details in `lib.rs`, function
  `build_create_v1_instruction`.
- Mint limit: **one mint per wallet every 24 h** (not per phone/person) —
  nothing prevents a new wallet from minting.
- Tested and confirmed working on devnet (real mint, verified via Solscan and
  Helius DAS `getAssetsByOwner`).
- **"Seeker Squad" cosmetic skin** (bonus planned for 2 NFTs from different
  devices): **abandoned**, not implemented.

Metadata hosted on `kristen.fr` (`nft/sanctuaire-seeker-classic.json` /
`-premium.json`) — no Arweave/IPFS for the demo. No on-chain Metaplex Collection
grouping the two tiers (deliberate decision: simplicity before the deadline;
direct consequence on ownership verification, see the Front section below).

## Settlement backend (Cloudflare Worker)

The computation of weekly scores and the on-chain submission (`submit_score`,
`finalize_pool`) run on a dedicated Cloudflare Worker — see
[`lms-proof-of-play-worker/`](./lms-proof-of-play-worker) for the complete code
and its own README.

Status as of 12/09/2026:
- Worker working locally (`wrangler dev`), reads stats from Firebase RTDB,
  computes the weekly delta via a KV snapshot, submits on-chain via
  `@coral-xyz/anchor`.
- Real weekly pool initialized on-chain for `weekId = 2026-W37` (test LMS mint
  on devnet, 6 decimals).
- Still to do before final submission: fund the pool (`fund_pool`), wire
  `claim_scratch` to the front-end scratch-card animation, decide test LMS mint
  (devnet) vs mainnet LMS mint for the demo.

Status as of 13/09/2026: the 3 critical instructions (submit_score, fund_pool,
claim_scratch) are validated in real conditions on a device, Phantom wallet,
devnet — full flow working from the game up to claiming the pool.

Status as of 15/09/2026: real pool `2026-W37` successfully claimed in real
conditions on a device (see "Multi-week claim" below). Real pool **`2026-W38`**
(current week) initialized and funded on-chain — devnet test mint, claimable at
the end of the week by active players.

Fix of 19/09/2026: `fund_pool` (Playground script and the Worker's
`poolLifecycle.ts`) converted a decimal amount (`AUTO_FUND_AMOUNT` or
`AMOUNT_UI`) via `BigInt(amount)`, which rejects any non-integer value — no
effect with the integer amounts used so far, but any funding with a decimal
amount (e.g. `0.5` token) would have failed. Fixed via `BigInt(Math.round(amount
* 10 ** decimals))`.

Status as of 22/09/2026: full debug session on claiming `2026-W38` (blocked on
both test devices) — several cascading bugs found and fixed on the Worker and
game sides, including a client bug that made a claim look successful without
ever checking the on-chain confirmation. Full details in "Prize-pool debug
session — cron, timeouts, optimistic claim (22/09/2026)" below.

Status as of 30/09/2026: multi-week claim validated in real conditions on a
device (Phantom, devnet) after three additional fixes (dead MWA authToken on
`signAndSendTransactions`, on-chain confirmation broken by a signature format,
end-of-queue UX) — details in "Claim & RADAR debug session (30/09/2026)" below.

### Multi-week claim (13/09/2026)

The "CLAIM" button now scans all pending weeks (up to 8, ~2 months of history —
see `LMS_CLAIM_PENDING_WEEKS_MAX`), not only the current ISO week. If there are
several, they chain automatically: a duel-style "round" VS transition (actually
equipped character displayed) precedes each scratch card, before moving on to
the next. The countdown shown in the settings ("X d Y h left to claim...") stays
an informational reminder — not a real limit: no expiry or deadline exists
on-chain (the `claimed` field has no notion of time in the program). A strict
on-chain deadline + redistribution of unclaimed funds remains considered for the
post-hackathon roadmap, for the case where a player exceeds the 8 weeks of
history kept on the client side.

### Pool init/fund automation (15/09/2026)

`initialize_weekly_pool` **and** `fund_pool` are now triggered automatically
every Monday by the Cloudflare Worker (same cron as the settlement of the
previous week — see `lms-proof-of-play-worker/README.md`, section "Pool opening
automation"), with a default fixed amount. Manual control remains possible at any
time, without having to disable the cron: if a week's pool has already been
funded by hand (via the `/init-pool` endpoint or a Playground script) before the
cron runs, that week's auto-fund is automatically skipped (the manual amount will
not be doubled) — only init remains always idempotent and safe to leave running.

### Prize-pool debug session — cron, timeouts, optimistic claim (22/09/2026)

Debug session triggered by a player (the dev himself) unable to claim the
`2026-W38` pool on two devices. Cascading root cause, detailed in
`lms-proof-of-play-worker/README.md` (points 13-16) — summary on the game side:

- **Cloudflare cron was running on Sunday instead of Monday** (day-of-week
  convention different from Unix at Cloudflare — `1 = Sunday` for them). The
  settlement ran ~24 h before the real end of the ISO week on the client side, on
  incomplete data. Fixed on the Worker side (see its README).
- **RPC confirmation timeout treated as a failure** on 4 critical Worker calls
  (`submitScore`, `finalizePool`, `initializeWeeklyPool`, `fundPool`) — a
  transaction could succeed on-chain despite a client-side timeout, and ended up
  classified as failed (or, for `finalizePool`, crashed the request outright).
  Fixed on the Worker side.
- **Discovery (fixed on 03/10/2026): one wallet can fragment across dozens of
  different Firebase `uid`s** — each reinstall/cache clear generates a new
  anonymous-auth `uid`, while the wallet (Seed Vault) stays stable. Since the
  weekly score is computed per `uid` on the Worker side, the game history of a
  player who reinstalls fragments into several nearly blank identities. No
  consequence for now (only observed on dev wallets, very often reinstalled
  during tests), but a Worker-side fix was needed before real players arrive.
  **Fixed on 03/10/2026**: the Worker now sums the deltas of all `uid`s of the
  same wallet before the single `submit_score` (see its README, point 15).
- **Client bug fixed: optimistic claim without verifying on-chain
  confirmation.** `_lmsExecuteClaimTransaction` (`www/index.html`) treated the
  MWA plugin's `signAndSendTransactions()` as proof of success as soon as a
  signature was returned — but this method only *submits* the transaction, it
  does not confirm that it succeeded. If the program rejected it (e.g.
  `PayoutTooSmall` on an unfunded pool), the app still displayed "✅ claimed" and
  removed the week from the local queue, while `claimed` stayed `false` on-chain
  — the same week therefore came back in a loop on every new press of CLAIM,
  never succeeding. Fixed: the transaction is now explicitly confirmed (poll
  `getSignatureStatuses` until confirmation, error or timeout — new function
  `_lmsConfirmClaimSignature`) before showing a success; a real failure now
  raises a clear alert to the player instead of a silent false positive.
- **Alerts/confirmations of the claim flow replaced by app-styled popups**
  (`#lms-claim-alert-modal`, same template as the scratch popup — amber/gold
  background, `Barlow Condensed`) instead of the browser's system `alert()`/
  `confirm()` dialogs. New helpers `_lmsClaimAlert()`/`_lmsClaimConfirm()` (both
  async); all the claim-flow messages (current week, pool not finalized, already
  claimed, multi-week confirmation, transaction failure, etc.) now go through
  these popups.
- **Multi-week history raised from 8 to 9** (`_lmsRecentWeekKeys`, systematic
  on-chain check independent of the local/Firebase tracking — see "Multi-week
  claim" above): the automatic check now covers the current week + the 8
  previous ones, to exactly match the "8 weeks of history" targeted by
  `LMS_CLAIM_PENDING_WEEKS_MAX`, which were previously covered only up to 7 past
  weeks by this automatic safety net (the 8th was covered only via the more
  fragile local/Firebase tracking).
- **Rebranding "SKR" → "LMS" (historical; the token is LMS everywhere; "SKR" was only a provisional dev name, unrelated to Solana Mobile's SKR)** in all
  player-visible texts (Solana tutorial FR/EN, HOF notice, amount shown on the
  claim card) — provisional dev token name replaced by the game's.
- New debug endpoint on the Worker side, `/debug-submit-score`, to build
  claimable test weeks without going through the real Firebase computation — see
  `lms-proof-of-play-worker/README.md`.
- **`2026-W38` stays locked at an incorrect score (36 instead of the real 116)**,
  a consequence of one of the timeout bugs above that occurred before the fix —
  the pool finalized before the value could be corrected, and `submit_score`
  refuses any modification after finalization. Deliberate decision: no real
  impact at this stage (dev wallets only), no fix needed on the program side.

### Claim & RADAR debug session (30/09/2026)

New test session on a real device (Phantom, devnet), three independent problems
found and fixed:

1. **`-1/authorization request failed` on claim** — `SIGN_AND_SEND_FAILED:
   ...JsonRpc20RemoteException -1/authorization request failed`. The stored MWA
   `authToken` was no longer recognized by the wallet. The `reauthorize →
   authorize` safety net added on 20/09 existed only in `signTransactions`
   (Proximity mint); `signAndSendTransactions` (claim, durable nonce creation)
   had none. Fixed on both sides: Kotlin plugin (`SolanaWalletPlugin.kt`, same
   `try/catch` + fresh `authorize()` within the same wallet session, new token
   returned in the response) **and** JS helper `_lmsSignAndSendWithReauth()`
   which persists the refreshed token and, as a last resort, replays a full
   `authorize()` while checking that the pubkey matches the connected wallet.
2. **False "confirmation timeout" on every claim** — the Kotlin plugin returns
   signatures in **base64**, whereas `getSignatureStatuses` expects **base58**:
   the RPC never found the transaction, and `_lmsConfirmClaimSignature` (added on
   22/09) systematically timed out at 45 s, even if the transaction had succeeded
   on-chain (pool `2026-W39` did pay out its 10 LMS while the app showed "claim
   not confirmed"), also aborting the rest of the multi-week queue. Fixed:
   base64 → base58 conversion before the check, plus an **ultimate safety net**
   — on a real timeout, re-read the on-chain `PlayerScore` account: if `claimed =
   true`, the claim is considered successful.
3. **Claim queue UX**:
   - "⛓️ On-chain confirmation…" label instead of the mute three dots while
     waiting for confirmation;
   - explicit end-of-queue message ("✅ N pools claimed! Nothing left to claim
     for now.") instead of a popup closing without a word;
   - weeks whose computed `payout` is 0 (unfunded pool → guaranteed
     `PayoutTooSmall`) are no longer offered in the queue: they caused an
     unavoidable transaction error. The "Skip this week" link stays available as
     a safety net.

**RADAR fix — asymmetric Seeker skin.** Observation (one occurrence on a
device): in a RADAR duel, the "Solana/Seeker" world appeared for only one of the
two players, the other playing the standard frozen lake. Cause identified by code
analysis: the skin was armed on each device only by its own Nearby
`payloadReceived` event; but the host cuts the Nearby connection as soon as it
has received its own, and the guest can accept the Firebase invitation before
its own payload has arrived. Fixed: the Firebase invitation now carries the
`radar` flag (+ the peer's Seed Vault status), the guest arms the skin itself on
acceptance if its Nearby handshake did not complete, and a late payload no longer
resets the already-bound room code. No RTDB rule change needed (`invites` does
not forbid extra fields). Not reproduced locally: to be confirmed on two devices.

## Proximity mode — front end (real in-game mint) (19/09/2026)

End-of-match screen dedicated to Proximity mode, in `www/index.html`:

- Relay via RTDB `meetingMints/<uidLo>_<uidHi>` (canonical key, independent of
  who triggers) — **not** `duelRooms/<code>`, deleted at the exact moment the
  match ends. Tie-break by uid to designate who builds/signs first (`builder`)
  and who signs second (`signer`).
- Double signature via `signTransactions` (signs without sending — necessary
  because `signAndSendTransactions` would submit the first signature alone and
  fail for lack of the second): the `builder` builds and pre-signs on the
  Metaplex side (assets), the `signer` signs in turn on the wallet side, the
  `builder` submits the finalized transaction.
- **Bug fixed (stale RTDB status)**: since the `meetingMints/...` key was never
  cleaned up between two attempts, an old `status:'error'` from a previous
  attempt could display instantly on the `signer` side before the current
  attempt had even started (the `signer` attaches its RTDB listener immediately,
  unlike the `builder`, which first waits for the slower wallet signature). Fix:
  `_lmsProximityMintSessionStartedAt` captured at the start of the flow, any
  earlier RTDB status (with a 5 s margin) is ignored.
- **Bug fixed (expired MWA authToken)**: `SIGN_TRANSACTIONS_FAILED:
  ...JsonRpc20RemoteException -1/authorization request failed` in real
  conditions — the stored `authToken` was no longer recognized by the wallet. Fix
  on the Kotlin plugin side (`SolanaWalletPlugin.kt`, `signTransactions`): if
  `reauthorize(authToken)` fails, retry with a fresh `authorize()` before giving
  up. The new returned token is persisted on the JS side (`localStorage`), on
  both sides (builder and signer), to avoid triggering a full re-authorization on
  each following mint.
- Watchdog timeout: 25 s → 90 s (insufficient margin in real conditions), with
  additional guards before each RTDB write to avoid writing over a flow already
  closed locally (timeout or error already received).
- Firebase RTDB rule (`rules.json`, `meetingMints` node): read/write restricted
  to the two participants — the `<uidLo>_<uidHi>` key must begin or end with
  `auth.uid` (`beginsWith`/`endsWith`), and `builderUid` / `signerUid` must equal
  `auth.uid` and can no longer change once set. (Fixed on 02/10/2026: this README
  said "no constraint on `uid`", which no longer matched the rules in place.)
- **Skin gift cards (Proof of Meet, v2268–v2274)**: dedicated tab accessible from
  the Armory, one card per skin (56 entries of `AI_SKIN_REGISTRY`) rendered by a
  reusable canvas template per rarity, with a 3D flip animation (CSS `rotateY` +
  `perspective`). Transmission **over Nearby face to face only** (no remote
  version, no NFT): the giver initiates (one-way, one card per meeting),
  confirmation before sending, Accept/Decline on the receiver side, local unlock
  of the skin on the receiver without removal from the giver, daily cap of
  received cards depending on the **receiver's** device (Seeker / Seed Vault = 3,
  standard Android = 1 — v2304, computed locally, never read from a radio
  payload). Never a Seeker skin (tied to the NFT) nor a `premium` skin (in-app
  purchase). To be validated on two Android devices.

### Seeker skin unlock (ownership verification, 19/09/2026)

The "Sanctuaire Seeker" skin (armory, new dedicated section between Helmets and
Skins) is unlocked through a **real on-chain verification**, not a declarative
Firebase flag: `getAssetsByOwner` (Helius DAS, endpoint already used elsewhere in
the game) on the connected wallet, comparing each asset's `content.json_uri` with
the two metadata URLs (classic/premium). A deliberate choice rather than a
Firebase flag written on the client side (which would be forgeable — nothing
would prevent a player from writing `true` directly without ever having minted).
Cached per wallet with a 15 s cooldown (no new network call at every shop
render, but retried at each opening as long as neither of the two tiers is
confirmed owned — covers the case of a mint just made, not yet indexed on the
Helius side). Toast + sound fanfare on the first ownership confirmation.

Shop section visible but greyed out/locked (padlock) for those who own neither of
the two NFTs, rather than invisible.

Known and accepted limitation: the cosmetic unlock is verified client-side (JS
embedded in the APK, decompilable) — a motivated player could force the skin to
display without owning the real NFT. No consequence on the NFT itself (still
honest on-chain) nor on other players — same level of trust as the rest of the
game.

## Proximity mint — full validation in real conditions (20/09/2026)

Test session on two physical devices (tablet + Seeker phone), which revealed and
fixed **three independent bugs**, each masking the next (each bug prevented
reaching the execution point where the next would have shown up):

1. **Kotlin fix never actually applied** — the `reauthorize → authorize`
   fallback documented earlier (see `capacitor-solana-mwa/README.md`) had in fact
   never been copied into the plugin's real source file
   (`capacitor-solana-mwa/android/src/main/java/.../SolanaWalletPlugin.kt`), only
   discussed in conversation. Applied for real this time, confirmed by directly
   re-reading the file before the fix.
2. **Client instruction builder out of sync with the program** —
   `_lmsBuildMintMeetingNftIx` (in `www/index.html`) still encoded the old
   two-boolean format (`is_premium_a`/`is_premium_b`) instead of the single
   `is_premium` fixed earlier in `lib.rs`, and **omitted the
   `player_mint_record_a`/`_b` accounts entirely** (8 accounts sent instead of
   10). Since this code path had never been tested in real conditions (only
   Playground scripts, via the Anchor IDL, had been validated so far), this bug
   stayed invisible until this session. Fixed, with a PDA helper
   (`_lmsPlayerMintRecordPda`) added along the way.
3. **Expired blockhash (`Transaction simulation failed: Blockhash not found`)** —
   the two-human-signers flow (RTDB, wallet, return to app) exceeds the validity
   window of a classic blockhash (~60-90 s in theory, but observed insufficient
   even on attempts at ~30-40 s — Solana devnet has less regular block production
   than mainnet). Solved with a **Durable Nonce**: a dedicated nonce account,
   created only once per `builder` wallet (reused indefinitely afterwards), whose
   value never expires as long as it has not been explicitly advanced —
   completely removes the time constraint.

**Real mint confirmed successful end to end** after these three fixes, in real
conditions (Nearby → MWA double signature → mint), not only via a Playground
script.

**Classic/premium logic audited and confirmed sound**: each device detects its
own Seed Vault (`isSeedVaultAvailable`), sends that status to the other player
via the Nearby payload, and the tier is computed as the logical `AND` of both
(`bothPremium = myIsPremium && peerIsPremium`) — never a different tier per
player, correctly wired end to end. Not tested with two real Seekers
simultaneously (only one available for tests), but the code is identical for both
tiers and was fully re-read.

> *Note (03/10/2026): this description (single tier, logical `AND` of the two
> players) predates the move to independent per-player tiers (`is_premium_a` /
> `is_premium_b`, 20/09/2026, verified in `lib.rs`).*

**Fairness point identified, not yet fixed**: `payer` is currently single (only
one of the two players pays all the fees — rent of the 2 NFTs + the 2
`PlayerMintRecord` + transaction fees). A 50/50 split (each player pays their
own NFT) would be fairer and would even simplify the code (removal of the
`InvalidPayer` constraint) — not a priority, to do if time permits before the
deadline.
**Fixed since**: `lib.rs` now makes each player pay their own NFT and their own
`PlayerMintRecord` (50/50 split, verified on 03/10/2026); only the network
transaction fees remain with the builder.

## Security and reliability of the Proximity mint (02/10/2026, v2308 → v2313)

Result of the 02/10/2026 audit (`AUDIT_RESTE_A_FAIRE.md`) and of tests on two
devices. Everything is in `www/index.html`.

- **Validation of the transaction before signing (v2308)** — the `signer` no
  longer passes the `builder`'s transaction to the wallet without checking it:
  `_lmsProximityMintValidateBuilderTx` requires the right payer (the builder),
  exactly 2 instructions (`nonceAdvance` authorized by the builder, then
  `mint_meeting_nft` with the right discriminator), the 9 accounts in the
  expected order (PDAs recomputed on the signer side), and no player wallet used
  as an asset. Otherwise: error `[transaction inattendue] <reason>` and the other
  player is notified. Checked outside the game with web3.js 1.x (1 legitimate
  transaction accepted, 7 fraudulent variants refused); the nominal path was
  tested in-game on two devices.
- **Nearby contact required for the mint (v2308)** — `_lmsRadarProximityVerified`
  is true after a real Nearby exchange or, in the v2292 fallback (RADAR armed by
  a Firebase invite `radar:true` when the Nearby payload is lost), only if the
  inviter was seen over Nearby in the last 5 minutes (the invite's `radarKey`
  field = the inviter's Nearby key, compared with the keys seen by
  `endpointFound`/`connectionInitiated`). Otherwise the mint is ignored (the
  RADAR skin and the match count do not change). Before this change, a modified
  invite was enough to arm RADAR remotely. Limitation: an invite from a client
  older than v2308 has no `radarKey`; both devices must be on v2308 or later.
- **Visible NFT confirmation (v2309)** — the mint screen no longer closes by
  itself after 2.5 s: it stays open on **both** players with "VIEW MY NFT" (opens
  **MY NFTs** and reloads up to 5 times while waiting for the Helius DAS indexer)
  and "OK"; automatic fallback close after 60 s. *Tested in-game: OK
  (02/10/2026).*
- **Optional pre-creation of the nonce account (v2311 → v2313, disabled by default)** — the code exists
  (`_lmsNoncePrewarm`, called by `_lmsNearbyToggleScan` before the scan starts; status "Preparing your wallet (1
  signature, one time only)…") and creates the nonce account when the player opens RADAR for the first time with
  that wallet, never blocking (on failure or beyond `LMS_NONCE_PREWARM_MAX_WAIT_MS` = 60 s, the scan starts anyway).
  But `LMS_NONCE_PREWARM_ENABLED = false` since v2313: only the builder (smallest `uid`) needs a nonce, and nobody
  knows who it will be before the meeting, so enabling it makes every wallet that opens RADAR pay for an account
  (~0.0015 SOL, recoverable by closing it) — including those who will never be builder. By default, the nonce is
  therefore created as before, **at the end of the first match, by the builder alone, once per wallet**.
  `_lmsEnsureNonceAccount` guarantees a single creation at a time per wallet in both modes. Set the constant to `true`
  to create it on the first opening of RADAR instead. Logic tested outside the game (both settings); *the "enabled"
  setting is not validated on a device.*
- **`[FORFAIT-WD]` log (v2310)** — temporary `console.warn` in the online duel's
  forfeit watchdog (readable via `chrome://inspect` or logcat
  `Capacitor/Console`); to be removed once the point below is settled.

### Problems observed in testing, unresolved (02/10/2026)

- **RADAR match that stops immediately (1st match between two new wallets, seen
  once)**: a winner is declared without any play, then the flow moves on to the
  signature. Hypothesis (≈ 60%, unconfirmed): the forfeit watchdog
  (`_LMS_DUEL_FORFEIT_TIMEOUT_MS` = 8 s) counts from the connection to the room
  (`_lmsOnlineDuelBeginSync`) although it only acts in the `playing` state; a
  device frozen for more than 8 s before the start (slow cold start, loading,
  Nearby permission dialog) would be declared forfeit. Not reproduced since (hence
  no `[FORFAIT-WD]` line). Envisaged fix: only count from the first `playing`
  tick.
- **`SIGN_TRANSACTIONS_FAILED … Timed out waiting for response with id=1` at the
  `[signature nonce]` step**: the wallet does not answer the session's first MWA
  request. On the (slow) test tablet, 3 consecutive failures in the same process
  (23:38, 23:42, 23:53) then a success (signature in 18 s) right after a restart
  of the application. Cause not proven (hypothesis: MWA/Phantom session stuck
  until restart); to be cross-checked on another device. Pre-creating the nonce
  moves this risk out of the end of the match without removing it.

## Wallet area — "MY NFTs" (02/10/2026, v2305 → v2309)

New in `www/index.html`: a viewing area for the connected wallet's NFTs, in
Settings.

- **Location**: "Wallet" group (`#settings-wallet-group`, surrounded by a golden
  border to isolate it from the rest of the settings) = Solana Wallet row (label
  on its own line, then address · × · CLAIM), deadline reminder, **MY NFTs** row.
  The whole group follows the same visibility condition as the Wallet row
  (`_lmsSyncWalletUI`): native app only, never on Android TV (so nothing to handle
  for the directional pad).
- **Popup content** (`#nft-popup`, `_lmsNft*` functions): LMS balance
  (`getTokenAccountsByOwner` on `LMS_SOLANA_MINT`), 2-column grid via
  `getAssetsByOwner` (Helius DAS, up to 5 pages of 1000, excludes fungible tokens
  and burned assets), **ALL / 🎵 MUSIC** filter (NFTs whose `animation_url` is an
  audio), detail on tap (visual, description, attributes, audio player, mint).
  30 s cache per wallet.
- **Read-only, no signature.** Any on-chain metadata (written by anyone) goes
  through `_lmsEsc()`; only `https://` URLs are accepted for images/audio
  (`ipfs://` rewritten to an https gateway); audio is stopped on every re-render
  and on close.
- **Without a connected wallet**: a simple "Connect your wallet" message. A "paste
  an address" mode had been prototyped then **abandoned** (reserved for connected
  wallets).
- **No music volume management**: in-game music is already stopped outside a match
  (`returnToMenu()` → `stopMusic()`), so no overlap with an NFT's audio is
  possible.
- **i18n**: 13 keys added in FR and EN (parity kept: 560/560).

### Clarifications on the Proof of Meet novelties

- **"Solana Seeker world"**: this is a **visual skin of world 1 (Frozen Lake)**
  used in RADAR duels (3 replaced assets + dedicated music), not a tenth world —
  the catalog still has **9 worlds** (ids 1, 2, 3, 4, 6, 9, 10, 12, 13). No change
  to gameplay or netcode.
- **Skin cards**: 56 entries in `AI_SKIN_REGISTRY` (common 10, rare 18, epic 10,
  legendary 5, mythic 13). Gift over Nearby only, daily reception cap depending
  on the receiver's device (see above).

## RPC keys and external dependencies (02/10/2026)

- **Helius**: the devnet key is in `LMS_SOLANA_RPC` (`www/index.html`), the only
  place where it appears — the Kotlin plugin embeds neither a key nor an RPC URL
  (it only chooses the cluster). Risk accepted on devnet. **Before mainnet**: a
  new, distinct key, then either Helius's "Secure URL" (hides the key, limited to
  5 req/s per IP — to be tested on the 7 methods used: `getAccountInfo`,
  `sendTransaction`, `getLatestBlockhash`, `getAssetsByOwner`,
  `getTokenAccountsByOwner`, `getSignatureStatuses`,
  `getMinimumBalanceForRentExemption`), or a Worker proxy with a method
  allow-list.
- **QuickNode**: no longer used (confirmed on 02/10/2026); the comment that
  contained the old URL was removed from the HTML. The settlement Worker uses
  Helius devnet via the `SOLANA_RPC_URL` secret. To be verified on the production
  side with `npx wrangler secret put SOLANA_RPC_URL` (a `.dev.vars` file only
  applies to local development) before deleting the old endpoint at QuickNode.
- **web3.js** is loaded from `unpkg.com` (pinned version 1.95.3) without
  `integrity=`: to be bundled locally in the APK before mainnet (also removes the
  network dependency at launch).

## Internal audit (02/10/2026)

A factual audit of the client, the Firebase rules and the READMEs is provided in
`AUDIT_LMS.md` (zero functional bug confirmed by reproduction; main points:
grouping scores by wallet on the Worker side, capping the pending weeks read from
Firebase, integrity of the weekly XP Top 3, device clock for daily cards,
SRI/bundling of web3.js).

Update of 03/10/2026: grouping scores by wallet is **fixed** on the Worker side
(see its README, point 15). Remaining, by priority: cap the `claimPendingWeeks`
weeks read from Firebase (`slice(-8)`), the scope of the dev tools in production
(they unlock paid skins), the device clock for daily rewards, the SRI of web3.js,
and the two test problems above. Full details in `AUDIT_RESTE_A_FAIRE.md`.

## Testing the application (judges / testers)

The app is 100% installable and working, with a single condition on the Solana
side: **have a wallet with test (devnet) SOL**, as for any Solana dApp in
development — real funds are never needed.

1. Install a Mobile Wallet Adapter-compatible wallet on your Android (Phantom or
   Solflare, free on the Play Store).
2. In the wallet's settings, switch the network to **Devnet** (not Mainnet).
3. Copy your public address, go to **https://faucet.solana.com**, paste the
   address, check that "Devnet" is selected, click to receive test SOL (free,
   instant).
4. Install the Last Man Skating APK, launch the app, connect your wallet from the
   settings.
5. You can now test the "Proof of Play" prize pool and the "Proof of Meet"
   Proximity mode normally.

Without this step, any on-chain action (pool claim, NFT mint) will fail with an
"insufficient SOL" type error — this is not a bug, just the absence of devnet
transaction fees.

## License / Author

Developed solo by Moleouf (Kristen Studios Games).

---

<a id="version-francaise"></a>

# 🇫🇷 Version française

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
  hebdomadaire en LMS, proportionnellement à la performance compétitive réelle
  de la semaine — modèle **"Proof of Play"**, sans mise ni hasard sur le montant
  reçu (pas de qualification gambling).
- Split de la cagnotte : 75 % proportionnel au score, 25 % partagé également
  entre tous les joueurs actifs au-dessus d'un seuil minimal.
- **Espace Wallet « MES NFT »** dans les Réglages : solde LMS, grille des NFT
  possédés, filtre NFT musicaux, détail avec lecteur audio — voir section dédiée.
- **Mode Proximité ("Proof of Meet")** : détection de rencontre physique réelle
  (Google Nearby Connections, BLE+WiFi) entre deux joueurs, confirmée par une
  double signature wallet on-chain, qui mint atomiquement un NFT trophée
  **"Sanctuaire Seeker"** (Metaplex Core) pour chacun des deux joueurs — voir
  section dédiée ci-dessous.

## Intégration SKR (Solana Mobile) — détection des détenteurs, en lecture seule

À la connexion du wallet, le jeu lit son **solde SKR sur mainnet** (`getTokenAccountsByOwner`
en lecture seule via un RPC mainnet public — aucune signature, aucune transaction ; le jeu
lui-même reste sur devnet). Mint officiel SKR :
`SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3` (voir [solanamobile.com/skr](https://solanamobile.com/skr)).

- **Skin « Holder SKR »** (cosmétique) : débloqué si le wallet détient au moins 1 SKR ;
  il apparaît dans la section des skins Seeker de la boutique.
- **Badge « SKR : n »** à côté du solde LMS dans l'espace wallet « MES NFT ».
- **Cosmétique uniquement, contrôle côté client** : aucun avantage de gameplay, aucun effet
  sur le score ni sur la cagnotte (cohérent avec le modèle *Proof of Play*). Non testable
  en devnet par le jury (SKR n'existe que sur mainnet) : voir la vidéo de démo.

**Non implémenté (feuille de route mainnet) :** cagnotte hebdomadaire Proof of Play
alimentée en SKR, et skins payables en SKR.

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
  (deviendrait fongible). Tiers **indépendants par joueur** (changé le
  20/09/2026, voir `lib.rs` : `is_premium_a` / `is_premium_b`) : chaque joueur
  reçoit le tier correspondant à son propre matériel (Seed Vault = premium).
  Une version antérieure n'avait qu'un tier unique pour toute la rencontre.
- **Cooldown anti-farming** : PDA `PlayerMintRecord` (seeds = pubkey du joueur,
  `init_if_needed`, champ `last_mint_at`) — un wallet doit attendre
  `MINT_COOLDOWN_SECONDS` = 86 400 s (24 h) entre deux mints (erreur
  `MintCooldownActive`). Remplace le verrou à vie d'origine (`init` strict).
- **CPI vers Metaplex Core construit à la main**, sans dépendance au crate
  `mpl-core` : Solana Playground ne compile qu'une liste fermée de crates
  côté serveur, qui ne l'inclut pas. L'instruction `CreateV1` est donc encodée
  directement (discriminant `0`, arguments Borsh `data_state`/`name`/`uri`/
  `plugins`, 8 comptes exacts avec placeholders `MPL_CORE_ID` pour les comptes
  optionnels absents — y compris `log_wrapper`, requis malgré son caractère
  "optionnel", confirmé empiriquement sur devnet). Voir le détail dans
  `lib.rs`, fonction `build_create_v1_instruction`.
- Limite de mint : **un mint par wallet toutes les 24 h** (pas par
  téléphone/personne) — rien n'empêche un nouveau wallet de minter.
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
  (mint LMS de test sur devnet, 6 décimales).
- Reste à faire avant soumission finale : alimenter la pool (`fund_pool`),
  câbler `claim_scratch` sur l'animation front de la carte à gratter, décider
  mint LMS de test (devnet) vs mint LMS mainnet pour la démo.

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

Statut au 22/09/2026 : session de debug complète sur la réclamation de
`2026-W38` (bloquée sur les deux appareils de test) — plusieurs bugs en
cascade trouvés et corrigés côté Worker et côté jeu, dont un bug client
faisant croire à une réclamation réussie sans jamais vérifier la
confirmation on-chain. Détail complet dans "Session de debug cagnotte —
cron, timeouts, claim optimiste (22/09/2026)" plus bas.

Statut au 30/09/2026 : réclamation multi-semaines validée en conditions
réelles sur device (Phantom, devnet) après trois correctifs supplémentaires
(authToken MWA mort sur `signAndSendTransactions`, confirmation on-chain
cassée par un format de signature, UX de fin de file) — détail dans
"Session de debug réclamation & RADAR (30/09/2026)" plus bas.

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

### Session de debug cagnotte — cron, timeouts, claim optimiste (22/09/2026)

Session de debug déclenchée par un joueur (le dev lui-même) incapable de
réclamer la cagnotte `2026-W38` sur deux appareils. Root cause en cascade,
détaillée dans `lms-proof-of-play-worker/README.md` (points 13-16) — résumé
côté jeu :

- **Cron Cloudflare tournait le dimanche au lieu du lundi** (convention
  jour-semaine différente d'Unix chez Cloudflare — `1 = dimanche` chez eux).
  Le règlement partait ~24h avant la vraie fin de semaine ISO côté client,
  sur des données incomplètes. Corrigé côté Worker (voir son README).
- **Timeout de confirmation RPC traité comme un échec** sur 4 appels
  critiques du Worker (`submitScore`, `finalizePool`, `initializeWeeklyPool`,
  `fundPool`) — une transaction pouvait réussir on-chain malgré un timeout
  côté client, et se retrouvait classée en échec (ou, pour `finalizePool`,
  plantait carrément la requête). Corrigé côté Worker.
- **Découverte (corrigée le 03/10/2026) : un même wallet peut se fragmenter sur des
  dizaines d'`uid` Firebase différents** — chaque reinstall/cache clear
  génère un nouvel `uid` d'auth anonyme, alors que le wallet (Seed Vault)
  reste stable. Le calcul du score hebdo étant fait par `uid` côté Worker,
  l'historique de jeu d'un joueur qui réinstalle se fragmente en plusieurs
  identités quasi-vierges. Sans conséquence pour l'instant (uniquement
  constaté sur les wallets de dev, très souvent réinstallés en test), mais
  correctif nécessaire côté Worker avant l'arrivée de vrais joueurs.
  **Corrigé le 03/10/2026** : le Worker additionne désormais les deltas de
  tous les `uid` d'un même wallet avant l'unique `submit_score` (voir son
  README, point 15).
- **Bug client corrigé : réclamation optimiste sans vérifier la
  confirmation on-chain.** `_lmsExecuteClaimTransaction` (`www/index.html`)
  traitait `signAndSendTransactions()` du plugin MWA comme une preuve de
  succès dès qu'une signature était retournée — or cette méthode ne fait
  que *soumettre* la transaction, pas confirmer qu'elle a réussi. Si le
  programme la rejetait (ex. `PayoutTooSmall` sur une pool non financée),
  l'app affichait quand même "✅ réclamé" et retirait la semaine de la file
  d'attente locale, alors que `claimed` restait `false` on-chain — la même
  semaine revenait donc en boucle à chaque nouvel appui sur RÉCLAMER, sans
  jamais aboutir. Corrigé : la transaction est maintenant confirmée
  explicitement (poll `getSignatureStatuses` jusqu'à confirmation, erreur
  ou timeout — nouvelle fonction `_lmsConfirmClaimSignature`) avant
  d'afficher un succès ; un vrai échec remonte désormais une alerte claire
  au joueur au lieu d'un faux positif silencieux.
- **Alertes/confirmations du flux de réclamation remplacées par des
  popups au style de l'app** (`#lms-claim-alert-modal`, même gabarit que
  la popup de grattage — fond ambre/or, `Barlow Condensed`) au lieu des
  boîtes de dialogue système `alert()`/`confirm()` du navigateur. Nouveaux
  helpers `_lmsClaimAlert()`/`_lmsClaimConfirm()` (tous deux async), tous
  les messages du flux de claim (semaine en cours, pool non finalisée,
  déjà réclamée, confirmation multi-semaines, échec de transaction, etc.)
  passent maintenant par ces popups.
- **Historique multi-semaines porté de 8 à 9** (`_lmsRecentWeekKeys`,
  vérification systématique on-chain indépendante du tracking
  local/Firebase — voir "Réclamation multi-semaines" ci-dessus) : la
  vérification automatique couvre désormais la semaine courante + les
  8 précédentes, pour matcher exactement les "8 semaines d'historique"
  visées par `LMS_CLAIM_PENDING_WEEKS_MAX`, qui n'étaient auparavant
  couvertes qu'à hauteur de 7 semaines passées par ce filet automatique
  (la 8e ne l'était que via le tracking local/Firebase, plus fragile).
- **Rebranding "SKR" → "LMS" (historique ; le jeton est LMS partout ; « SKR » n'était qu'un nom provisoire de dev, sans lien avec le SKR de Solana Mobile)** dans tous les textes visibles du joueur
  (tutoriel Solana FR/EN, notice HOF, montant affiché sur la carte de
  réclamation) — nom de jeton provisoire de dev remplacé par celui du jeu.
- Nouvel endpoint de debug côté Worker, `/debug-submit-score`, pour
  fabriquer des semaines de test réclamables sans passer par le calcul
  Firebase réel — voir `lms-proof-of-play-worker/README.md`.
- **`2026-W38` reste verrouillée à un score incorrect (36 au lieu de 116
  réel)**, conséquence d'un des bugs de timeout ci-dessus survenu avant
  correctif — la pool s'est finalisée avant qu'on puisse corriger la
  valeur, et `submit_score` refuse toute modification post-finalisation.
  Décision assumée : impact réel nul à ce stade (wallets de dev
  uniquement), pas de correctif nécessaire côté programme.

### Session de debug réclamation & RADAR (30/09/2026)

Nouvelle session de test sur device réel (Phantom, devnet), trois problèmes
indépendants trouvés et corrigés :

1. **`-1/authorization request failed` sur la réclamation** —
   `SIGN_AND_SEND_FAILED: ...JsonRpc20RemoteException -1/authorization
   request failed`. Le `authToken` MWA stocké n'était plus reconnu par le
   wallet. Le filet `reauthorize → authorize` ajouté le 20/09 n'existait que
   dans `signTransactions` (mint Proximité) ; `signAndSendTransactions`
   (réclamation, création du nonce durable) n'en avait pas. Corrigé des deux
   côtés : plugin Kotlin (`SolanaWalletPlugin.kt`, même `try/catch` +
   `authorize()` frais dans la même session wallet, nouveau token renvoyé
   dans la réponse) **et** helper JS `_lmsSignAndSendWithReauth()` qui
   persiste le token rafraîchi et, en dernier recours, rejoue un
   `authorize()` complet en vérifiant que la pubkey correspond au wallet
   connecté.
2. **Faux "timeout de confirmation" à chaque réclamation** — le plugin
   Kotlin renvoie les signatures en **base64**, alors que
   `getSignatureStatuses` attend du **base58** : la RPC ne retrouvait jamais
   la transaction, et `_lmsConfirmClaimSignature` (ajoutée le 22/09) tombait
   systématiquement en timeout de 45 s, même si la transaction avait réussi
   on-chain (la pool `2026-W39` a bien versé ses 10 LMS pendant que l'app
   affichait "réclamation non confirmée"), en avortant en plus le reste de la
   file multi-semaines. Corrigé : conversion base64 → base58 avant la
   vérification, plus un **filet ultime** — en cas de vrai timeout, relecture
   du compte `PlayerScore` on-chain : si `claimed = true`, la réclamation est
   considérée comme réussie.
3. **UX de la file de réclamation** :
   - libellé "⛓️ Confirmation on-chain…" à la place des trois points muets
     pendant l'attente de confirmation ;
   - message de fin de file explicite ("✅ N cagnottes réclamées ! Plus rien
     à réclamer pour l'instant.") au lieu d'une popup qui se ferme sans rien
     dire ;
   - les semaines dont le `payout` calculé vaut 0 (pool non financée →
     `PayoutTooSmall` garanti) ne sont plus proposées dans la file : elles
     provoquaient une erreur de transaction inévitable. Le lien "Ignorer
     cette semaine" reste disponible en filet de sécurité.

**Correctif RADAR — skin Seeker asymétrique.** Constat (une occurrence sur
device) : en duel RADAR, le monde "Solana/Seeker" n'apparaissait que chez un
des deux joueurs, l'autre jouant le lac gelé standard. Cause identifiée par
analyse du code : le skin était armé sur chaque appareil uniquement par son
propre événement Nearby `payloadReceived` ; or l'hôte coupe la connexion
Nearby dès qu'il a reçu le sien, et l'invité peut accepter l'invitation
Firebase avant que son propre payload soit arrivé. Corrigé : l'invitation
Firebase embarque désormais le drapeau `radar` (+ statut Seed Vault du pair),
l'invité arme lui-même le skin à l'acceptation si son handshake Nearby n'a
pas abouti, et un payload tardif ne remet plus à zéro le code de salle déjà
lié. Aucune modification des règles RTDB nécessaire (`invites` n'interdit
pas les champs supplémentaires). Non reproduit en local : à confirmer sur
deux appareils.

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
  restreintes aux deux participants — la clé `<uidLo>_<uidHi>` doit commencer
  ou finir par `auth.uid` (`beginsWith`/`endsWith`), et `builderUid` /
  `signerUid` doivent valoir `auth.uid` et ne peuvent plus changer une fois
  posés. (Corrigé le 02/10/2026 : ce README indiquait « pas de contrainte sur
  `uid` », ce qui ne correspondait plus aux rules en place.)
- **Cartes de skins à s'offrir (Proof of Meet, v2268–v2274)** : onglet
  dédié accessible depuis l'Armurerie, une carte par skin (56 entrées de
  `AI_SKIN_REGISTRY`) rendue par un template canvas réutilisable par rareté,
  avec animation flip 3D (CSS `rotateY` + `perspective`). Transmission
  **Nearby en tête-à-tête uniquement** (pas de version à distance, pas de
  NFT) : le donneur initie (sens unique, une carte par rencontre),
  confirmation avant envoi, Accepter/Refuser côté receveur, déblocage local
  du skin chez le receveur sans retrait chez le donneur, plafond de cartes reçues par jour selon l'appareil du **receveur** (Seeker / Seed Vault = 3, Android standard = 1 — v2304, calculé localement, jamais lu dans un payload radio). Jamais de skin Seeker (lié au NFT) ni de
  skin `premium` (achat in-app). À valider sur deux appareils Android.

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

## Mint Proximité — validation complète en conditions réelles (20/09/2026)

Session de test sur deux appareils physiques (tablette + téléphone Seeker),
ayant révélé et corrigé **trois bugs indépendants**, chacun masquant le
suivant (chaque bug empêchait d'atteindre le point d'exécution où le
suivant se serait manifesté) :

1. **Fix Kotlin jamais réellement appliqué** — le fallback
   `reauthorize → authorize` documenté précédemment (voir
   `capacitor-solana-mwa/README.md`) n'avait en réalité jamais été copié
   dans le fichier source réel du plugin
   (`capacitor-solana-mwa/android/src/main/java/.../SolanaWalletPlugin.kt`),
   seulement discuté en conversation. Appliqué pour de vrai cette fois,
   confirmé par relecture directe du fichier avant correction.
2. **Constructeur d'instruction client désynchronisé du programme** —
   `_lmsBuildMintMeetingNftIx` (dans `www/index.html`) encodait encore
   l'ancien format à deux booléens (`is_premium_a`/`is_premium_b`) au lieu
   du `is_premium` unique corrigé plus tôt dans `lib.rs`, et **omettait
   entièrement les comptes `player_mint_record_a`/`_b`** (8 comptes
   envoyés au lieu de 10). Comme ce chemin de code n'avait jamais été
   testé en conditions réelles (seuls les scripts Playground, via l'IDL
   Anchor, avaient été validés jusque-là), ce bug est resté invisible
   jusqu'à cette session. Corrigé, avec un helper PDA
   (`_lmsPlayerMintRecordPda`) ajouté au passage.
3. **Blockhash expiré (`Transaction simulation failed: Blockhash not
   found`)** — le flux à deux signataires humains (RTDB, wallet, retour
   app) dépasse la fenêtre de validité d'un blockhash classique
   (~60-90 s en théorie, mais observé insuffisant même sur des tentatives
   à ~30-40 s — le devnet Solana a une production de blocs moins régulière
   que le mainnet). Résolu via un **Durable Nonce** : compte nonce dédié,
   créé une seule fois par wallet `builder` (réutilisé indéfiniment
   ensuite), dont la valeur ne périme jamais tant qu'elle n'a pas été
   explicitement avancée — élimine complètement la contrainte de temps.

**Mint réel confirmé réussi de bout en bout** après ces trois correctifs,
en conditions réelles (Nearby → double signature MWA → mint), pas
seulement via script Playground.

**Logique classic/premium auditée et confirmée saine** : chaque appareil
détecte son propre Seed Vault (`isSeedVaultAvailable`), transmet ce
statut à l'autre joueur via le payload Nearby, et le tier est calculé en
`ET` logique des deux (`bothPremium = myIsPremium && peerIsPremium`) —
jamais un tier différent par joueur, correctement câblé de bout en bout.
Non testé avec deux vrais Seeker simultanément (un seul disponible pour
les tests), mais le code est identique pour les deux tiers et a été relu
intégralement.

> *Note (03/10/2026) : cette description (tier unique, `ET` logique des deux
> joueurs) est antérieure au passage aux tiers indépendants par joueur
> (`is_premium_a` / `is_premium_b`, 20/09/2026, vérifié dans `lib.rs`).*

**Point d'équité identifié, pas encore corrigé** : `payer` est
actuellement unique (un seul des deux joueurs règle tous les frais —
rent des 2 NFT + des 2 `PlayerMintRecord` + frais de transaction). Un
split 50/50 (chaque joueur paie son propre NFT) serait plus équitable et
simplifierait même le code (suppression de la contrainte `InvalidPayer`)
— non prioritaire, à faire si le temps le permet avant la deadline.
**Corrigé depuis** : `lib.rs` fait désormais payer à chaque joueur son propre
NFT et son propre `PlayerMintRecord` (split 50/50, vérifié le 03/10/2026) ;
seuls les frais de transaction réseau restent à la charge du builder.

## Sécurité et fiabilité du mint Proximité (02/10/2026, v2308 → v2313)

Issu de l'audit du 02/10/2026 (`AUDIT_RESTE_A_FAIRE.md`) et de tests sur deux appareils. Tout est dans `www/index.html`.

- **Validation de la transaction avant signature (v2308)** — le `signer` ne transmet plus au wallet la transaction
  du `builder` sans la contrôler : `_lmsProximityMintValidateBuilderTx` exige le bon payeur (le builder), exactement
  2 instructions (`nonceAdvance` autorisé par le builder, puis `mint_meeting_nft` avec le bon discriminator), les
  9 comptes dans l'ordre attendu (PDA recalculées côté signataire), aucun wallet joueur utilisé comme asset.
  Sinon : erreur `[transaction inattendue] <motif>` et l'autre joueur est prévenu. Vérifié hors jeu avec web3.js 1.x
  (1 transaction légitime acceptée, 7 variantes frauduleuses refusées) ; le chemin nominal a été testé en jeu sur
  deux appareils.
- **Contact Nearby exigé pour le mint (v2308)** — `_lmsRadarProximityVerified` est vrai après un vrai échange
  Nearby, ou, dans le repli v2292 (RADAR armé par une invite Firebase `radar:true` quand le payload Nearby est
  perdu), seulement si l'inviteur a été vu en Nearby dans les 5 dernières minutes (champ `radarKey` de l'invite =
  clé Nearby de l'inviteur, comparée aux clés vues par `endpointFound`/`connectionInitiated`). Sinon le mint est
  ignoré (le skin RADAR et le décompte du match ne changent pas). Avant ce changement, une invite modifiée suffisait
  à armer RADAR à distance. Limite : une invite d'un client antérieur à v2308 n'a pas de `radarKey` ; les deux
  appareils doivent être en v2308 ou plus.
- **Confirmation visible du NFT (v2309)** — l'écran de mint ne se ferme plus seul après 2,5 s : il reste ouvert chez
  les **deux** joueurs avec « VOIR MON NFT » (ouvre **MES NFT** et recharge jusqu'à 5 fois en attendant
  l'indexeur Helius DAS) et « OK » ; fermeture automatique de secours après 60 s. *Testé en jeu : OK (02/10/2026).*
- **Pré-création optionnelle du compte nonce (v2311 → v2313, désactivée par défaut)** — le code existe
  (`_lmsNoncePrewarm`, appelée par `_lmsNearbyToggleScan` avant le démarrage du scan ; statut « Préparation du wallet
  (1 signature, une seule fois)… ») et crée le compte nonce à la première ouverture de RADAR avec ce wallet, sans
  jamais bloquer (en cas d'échec ou au-delà de `LMS_NONCE_PREWARM_MAX_WAIT_MS` = 60 s, le scan démarre quand même).
  Mais `LMS_NONCE_PREWARM_ENABLED = false` depuis v2313 : seul le builder (uid le plus petit) a besoin d'un nonce, et
  personne ne sait avant la rencontre qui ce sera ; l'activer ferait payer un compte (~0,0015 SOL, récupérable en le
  fermant) à chaque wallet qui ouvre RADAR, y compris ceux qui ne seront jamais builder. Par défaut, le nonce est
  donc créé comme avant, **à la fin du premier match, par le builder seul, une fois par wallet**.
  `_lmsEnsureNonceAccount` garantit une seule création à la fois par wallet dans les deux modes. Passer la constante à
  `true` pour le créer à la première ouverture de RADAR. Logique testée hors jeu (les deux réglages) ; *le réglage
  « activé » n'est pas validé sur appareil.*
- **Log `[FORFAIT-WD]` (v2310)** — `console.warn` temporaire dans le watchdog de forfait du duel en ligne (lisible
  via `chrome://inspect` ou logcat `Capacitor/Console`) ; à retirer une fois le point ci-dessous tranché.

### Problèmes observés en test, non résolus (02/10/2026)

- **Partie RADAR qui s'arrête immédiatement (1re partie entre deux wallets neufs, vue une fois)** : un gagnant
  est déclaré sans jeu, puis le flux passe à la signature. Hypothèse (≈ 60 %, non confirmée) : le watchdog de
  forfait (`_LMS_DUEL_FORFEIT_TIMEOUT_MS` = 8 s) compte depuis la connexion à la salle (`_lmsOnlineDuelBeginSync`)
  alors qu'il n'agit qu'en état `playing` ; un appareil gelé plus de 8 s avant le début (démarrage à froid lent,
  chargement, boîte de permission Nearby) serait déclaré forfait. Non reproduit depuis (donc aucune ligne
  `[FORFAIT-WD]`). Correctif envisagé : ne compter qu'à partir du premier tick `playing`.
- **`SIGN_TRANSACTIONS_FAILED … Timed out waiting for response with id=1` à l'étape `[signature nonce]`** :
  le wallet ne répond pas à la première requête MWA de la session. Sur la tablette de test (lente), 3 échecs
  consécutifs dans le même processus (23:38, 23:42, 23:53) puis un succès (signature en 18 s) juste après un
  redémarrage de l'application. Cause non prouvée (hypothèse : session MWA/Phantom restée bloquée jusqu'au
  redémarrage) ; à recouper sur un autre appareil. La pré-création du nonce déplace ce risque hors de la fin de
  partie sans le supprimer.

## Espace Wallet — « MES NFT » (02/10/2026, v2305 → v2309)

Nouveau dans `www/index.html` : un espace de consultation des NFT du wallet
connecté, dans les Réglages.

- **Emplacement** : groupe « Wallet » (`#settings-wallet-group`, entouré d'un
  liseret doré pour l'isoler du reste des réglages) = ligne Wallet Solana
  (libellé sur sa propre ligne, puis adresse · × · RÉCLAMER), rappel de deadline,
  ligne **MES NFT**. Le groupe entier suit la même condition de visibilité que
  la ligne Wallet (`_lmsSyncWalletUI`) : app native uniquement, jamais sur
  Android TV (donc rien à gérer pour la croix directionnelle).
- **Contenu de la popup** (`#nft-popup`, fonctions `_lmsNft*`) : solde LMS
  (`getTokenAccountsByOwner` sur `LMS_SOLANA_MINT`), grille 2 colonnes via
  `getAssetsByOwner` (Helius DAS, jusqu'à 5 pages de 1000, exclut tokens
  fongibles et assets brûlés), filtre **TOUS / 🎵 MUSICAUX** (NFT dont
  `animation_url` est un audio), détail au tap (visuel, description, attributs,
  lecteur audio, mint). Cache de 30 s par wallet.
- **Lecture seule, sans signature.** Toute métadonnée on-chain (écrite par
  n'importe qui) passe par `_lmsEsc()` ; seules les URL `https://` sont
  acceptées pour images/audio (`ipfs://` réécrit vers une passerelle https) ;
  l'audio est coupé à chaque re-rendu et à la fermeture.
- **Sans wallet connecté** : simple message « Connecte ton wallet ». Un mode
  « coller une adresse » avait été prototypé puis **abandonné** (réservé aux
  wallets connectés).
- **Pas de gestion de volume de la musique** : la musique de partie est déjà
  coupée hors match (`returnToMenu()` → `stopMusic()`), donc aucune
  superposition possible avec l'audio d'un NFT.
- **i18n** : 13 clés ajoutées en FR et EN (parité conservée : 560/560).

### Précisions sur les nouveautés Proof of Meet

- **« Monde Solana Seeker »** : c'est un **skin visuel du monde 1 (Lac Gelé)**
  utilisé en duel RADAR (3 assets remplacés + musique dédiée), pas un dixième
  monde — le catalogue compte toujours **9 mondes** (ids 1, 2, 3, 4, 6, 9, 10,
  12, 13). Aucun changement de gameplay ni de netcode.
- **Cartes de skins** : 56 entrées dans `AI_SKIN_REGISTRY` (commune 10, rare 18,
  épique 10, légendaire 5, mythique 13). Don en Nearby uniquement, plafond de
  réception par jour selon l'appareil du receveur (voir plus haut).

## Clés RPC et dépendances externes (02/10/2026)

- **Helius** : la clé devnet est dans `LMS_SOLANA_RPC` (`www/index.html`), seul
  endroit où elle apparaît — le plugin Kotlin n'embarque ni clé ni URL RPC
  (il ne choisit que le cluster). Risque accepté sur devnet. **Avant le mainnet** :
  nouvelle clé distincte, puis soit la « Secure URL » Helius (masque la clé,
  limitée à 5 req/s par IP — à tester sur les 7 méthodes utilisées :
  `getAccountInfo`, `sendTransaction`, `getLatestBlockhash`,
  `getAssetsByOwner`, `getTokenAccountsByOwner`, `getSignatureStatuses`,
  `getMinimumBalanceForRentExemption`), soit un proxy Worker avec liste blanche
  de méthodes.
- **QuickNode** : n'est plus utilisé (confirmé le 02/10/2026) ; le commentaire qui contenait l'ancienne URL a
  été retiré du HTML. Le Worker de règlement utilise Helius devnet via le secret `SOLANA_RPC_URL`. À vérifier côté
  production avec `npx wrangler secret put SOLANA_RPC_URL` (un fichier `.dev.vars` ne vaut que pour le
  développement local) avant de supprimer l'ancien endpoint chez QuickNode.
- **web3.js** est chargé depuis `unpkg.com` (version figée 1.95.3) sans
  `integrity=` : à embarquer localement dans l'APK avant le mainnet (supprime
  aussi la dépendance réseau au lancement).

## Audit interne (02/10/2026)

Un audit factuel du client, des rules Firebase et des README est fourni dans
`AUDIT_LMS.md` (zéro bug fonctionnel confirmé par reproduction ; points
principaux : regroupement des scores par wallet côté Worker, plafonnement des
semaines en attente lues dans Firebase, intégrité du Top 3 XP hebdo, horloge
appareil pour les cartes quotidiennes, SRI/embarquement de web3.js).

Mise à jour du 03/10/2026 : le regroupement des scores par wallet est **corrigé** côté Worker (voir son README,
point 15). Restent, par priorité : plafonner les semaines `claimPendingWeeks` lues dans Firebase (`slice(-8)`),
le périmètre des dev tools en production (ils débloquent les skins payants), l'horloge appareil des récompenses
quotidiennes, le SRI de web3.js, et les deux problèmes de test ci-dessus. Détail complet dans
`AUDIT_RESTE_A_FAIRE.md`.

## Pour tester l'application (juges / testeurs)

L'app est 100 % installable et fonctionnelle, à une seule condition côté
Solana : **avoir un wallet avec du SOL de test (devnet)**, comme pour
toute dApp Solana en développement — les fonds réels ne sont jamais
nécessaires.

1. Installe un wallet compatible Mobile Wallet Adapter sur ton Android
   (Phantom ou Solflare, gratuits sur le Play Store).
2. Dans les paramètres du wallet, bascule le réseau sur **Devnet** (pas
   Mainnet).
3. Copie ton adresse publique, va sur **https://faucet.solana.com**,
   colle l'adresse, vérifie que "Devnet" est sélectionné, clique pour
   recevoir du SOL de test (gratuit, instantané).
4. Installe l'APK de Last Man Skating, lance l'app, connecte ton wallet
   depuis les réglages.
5. Tu peux maintenant tester la cagnotte "Proof of Play" et le mode
   Proximité "Proof of Meet" normalement.

Sans cette étape, toute action on-chain (réclamation de cagnotte, mint de
NFT) échouera avec une erreur de type "SOL insuffisant" — ce n'est pas un
bug, juste l'absence de frais de transaction devnet.

## Licence / Auteur

Développé en solo par Moleouf (Kristen Studios Games).
