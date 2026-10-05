# lms-proof-of-play-worker

> 🇬🇧 **English version first.** 🇫🇷 La version française complète se trouve plus bas : [aller à la version française](#version-francaise).

Cloudflare Worker that computes weekly scores and submits `submitScore` +
`finalizePool` on-chain — replaces the Firebase Cloud Function, avoided so as not
to enable a credit card.

## Status

Working Worker, tested end to end on devnet — **`submit_score` successfully
confirmed on-chain on 12/09/2026** (signature verified on Solana Explorer,
"Success" status, finalized).

✅ Done:
1. **`wallets/{uid}`** — RTDB rule added, client write working (address properly
   received in `wallets/{uid}` with `address` + `ts`).
2. **`src/idl/lms_proof_of_play.json`** — exported/converted by hand (pre-0.30),
   **validated in real conditions**: `submit_score` called through this IDL file
   succeeded on-chain (correct discriminators).
3. **KV `WEEK_SNAPSHOT_KV`** — namespace created, id filled in `wrangler.jsonc`.
4. **Devnet RPC** — migrated from the public endpoint `api.devnet.solana.com`
   (blocked by IP rate limit, 403 error) to a dedicated QuickNode endpoint
   (since replaced by Helius devnet: QuickNode is no longer used, 02/10/2026).
   Confirmation timeout raised to 60 s in `solanaSubmit.ts` (the public endpoint
   confirmed within 10 s; QuickNode took more than 30 s on at least one test,
   hence the adjustment).
5. **Real weekly pool** initialized on-chain for `weekId = 2026-W37` (test LMS
   mint on devnet, 6 decimals).
6. The 8 Anchor unit tests pass (init pool, fund, submit_score, finalize, claim
   75/25, anti double-claim, anti-impersonation).

⚠️ Known limitation (anti-cheat):
- `duelStats`/`ffaStats` are counters self-declared by the client
  (`wins`/`losses`), with no verifiable link to the opponent's identity. A
  player with a connected wallet can inflate their score by playing against a
  second account they control (collusion/self-play) — the only current
  protection is a per-player weekly cap in `scoring.ts` (max 294 points/week:
  `duelWins` capped at 21, `ffaWins` capped at 14), which limits the scale but
  does not prevent the fraud itself.
- Planned fix (post-hackathon): record both `uid`s of each match in a new
  `matchHistory/{matchId}` node when a `duelRooms`/`ffaRooms` ends, and compute
  the weekly score from that history (victories against a distinct opponent
  only) rather than from the current aggregated counter.

✅ Done (continued):
7. **Real `fund_pool`** — pool `2026-W37` successfully funded on 12/09/2026
   (1000 test tokens, devnet mint with 6 decimals). Tested via a Solana
   Playground script (mint + fundPool), not yet automated in the worker at that
   time (see "Pool opening automation" below for what followed).

✅ Done (continued):
8. **`claim_scratch` validated end to end** — full flow tested on a real device
   on 13/09/2026: wallet connected → on-chain read (WeeklyPool/PlayerScore) →
   transaction built on the client side → signed via MWA/Phantom → on-chain
   confirmation → tokens received. Double claim properly blocked by the program
   (`AlreadyClaimed`) on a repeated attempt.

The 3 critical instructions (submit_score, fund_pool, claim_scratch) are now
validated in real conditions, not only in Playground tests.

✅ Done (continued):
9. **Cron/client desync fix (13/09/2026)** — the cron ran at 3:00 UTC on Mondays,
   while the client switches ISO week at exactly 0:00 UTC (`_lmsWeekKey()`): a
   3-hour window where the CLAIM button could no longer find the pool of the week
   that had just ended (already "past" on the client side, not yet settled
   on-chain by the worker). Cron moved to 00:01 UTC (`wrangler.jsonc`),
   `weekIdBeingSettled()` adjusted accordingly (5-minute lookback instead of
   24 h).
10. **Delta loss on total failure fix** — `saveSnapshot()` advanced the KV
    snapshot unconditionally right after the on-chain submission, even when ALL
    of the week's submissions failed (e.g. everyone in `PoolAlreadyFinalized`).
    The week's delta then vanished without being paid or carried over. Fixed: the
    snapshot only advances if at least one submission succeeded
    (`succeeded.length > 0`) — a fully failed run leaves the snapshot unchanged,
    so it can be replayed on the next run. The endpoint's JSON response now
    includes `snapshotAdvanced` to check this easily afterwards.

✅ Done (continued):
11. **Automation of pool opening AND funding (15/09/2026)** —
    `initialize_weekly_pool` **and** `fund_pool` for the upcoming week are now
    triggered automatically by the same cron as the settlement (00:01 UTC on
    Monday), right after the previous week's finalization. See
    `src/poolLifecycle.ts`.
    - **Init**: idempotent — an already initialized pool does not fail the run,
      the "already in use" error is caught and logged without stopping the rest
      of the cron.
    - **Fund**: fixed amount defined by the `AUTO_FUND_AMOUNT` secret (see
      "Secrets" below). Built-in safeguard: `fund_pool` adds up on each call (it
      never replaces the existing pot), so if the pool already has a
      `totalPot > 0` when the cron runs (= funded manually beforehand, via
      `/init-pool` or a Playground script), auto-fund is **skipped** for that
      week — no double funding.
    - **Manual override, without touching the cron**: a protected `/init-pool`
      endpoint (same `X-Trigger-Secret` guard as `/run-settlement`) lets you
      initialize and/or fund any week by hand, at any time. Use it *before* the
      cron runs to set a different amount for a given week — the cron will detect
      the already non-zero pot and leave your amount as is.

✅ Done (continued):
12. **Decimal amount fix (19/09/2026)** — `poolLifecycle.ts` converted
    `AUTO_FUND_AMOUNT` to raw units via `BigInt(amountUi)`, which rejects any
    non-integer value (`BigInt(0.5)` throws). No effect as long as
    `AUTO_FUND_AMOUNT` stays an integer (`"10"`, used so far), but it would have
    silently failed auto-fund as soon as a decimal amount was configured. Fixed:
    `BigInt(Math.round(amountUi * 10 ** mintInfo.decimals))`.

✅ Done (continued):
13. **Cron on Sunday instead of Monday fix (22/09/2026)** —
    `"crons": ["1 0 * * 1"]` in `wrangler.jsonc` actually ran on **Sunday**
    00:01 UTC, not Monday. Cloudflare interprets the day of week differently
    from standard Unix cron: for them `1 = Sunday` (`0`/`7 = Sunday`, `1 =
    Monday` elsewhere). Confirmed by the dashboard itself ("Runs At 12:01 AM on
    **Sunday**"). Real consequence: the settlement ran ~24 h before the real end
    of the ISO week on the client side, on an incomplete delta, and advanced the
    KV snapshot prematurely. Fixed with the 3-letter form (`"1 0 * * MON"`),
    which removes the ambiguity without depending on the provider's convention.
14. **"Confirmation timeout ≠ failure" fix** on the 4 critical `.rpc()` calls
    (`submitScore`, `finalizePool` in `solanaSubmit.ts`; `initializeWeeklyPool`,
    `fundPool` in `poolLifecycle.ts`). Real case observed on `2026-W38`: a 60 s
    timeout classified the submission as "failed" while the transaction had
    actually been accepted on-chain (checked on Solana Explorer) — which made
    `finalizePool()` get skipped (never called if no success was detected) and,
    once `finalizePool` itself was hit by the same problem, crashed the whole
    request (uncaught exception → generic 500 instead of the result JSON).
    `resolveTimeoutSignature()` (exported from `solanaSubmit.ts`, reused by
    `poolLifecycle.ts`) extracts the signature from the timeout error message
    and checks the real state via `getSignatureStatus` before concluding to a
    failure.
    - **Side effect discovered on `2026-W38`**: the real score (116, correctly
      computed from the 14/09 KV snapshot) had been overwritten with **36** by a
      test run prior to the fix, then the pool ended up finalizing (through one
      of the "false positive" timeouts above) before the value could be
      corrected. `submit_score` has no on-chain anti-regression guard (intended
      design — see `programs/lms_proof_of_play/README.md` if its `lib.rs`
      documents this choice), so nothing prevented the overwrite, but **once
      finalized, no correction is possible anymore** (`PoolAlreadyFinalized` on
      any new attempt). **Decision: we leave `2026-W38` at 36 as is** — no real
      impact (only dev/test wallets at this stage), but worth keeping in mind: a
      score resubmission must be verified (`_lmsGetClaimContext` on the client
      side, or a direct read of the `PlayerScore` account) **before**
      `finalize_pool`, not after.
15. **Discovery, FIXED on 03/10/2026: fragmentation of one wallet across several
    Firebase `uid`s.** `duelStats`/`ffaStats`/`wallets` are indexed by
    anonymous-auth `uid`, which changes on **every reinstall/cache clear**
    (observed in test production: a single wallet, `6pDn...ZoU2`, linked to **24
    different `uid`s**). Since `weekSnapshot.ts`/`index.ts` compute the delta and
    eligibility **per `uid`**, the history of a player who reinstalls fragments
    into several nearly blank identities, and above all: if 2+ `uid`s of the same
    wallet have a score > 0 in the same week, the submission loop does one
    `submit_score` per `uid` on the **same** `PlayerScore` PDA — `submit_score`
    overwrites (does not accumulate), so only the loop's last call survives, the
    others are silently lost.
    **Fix (03/10/2026, deployed)**: `groupDeltasByWallet` (`weekSnapshot.ts`) sums
    the deltas of all `uid`s sharing the same wallet address **before**
    `computeWeeklyScore`, and `index.ts` now sends only one `submit_score` per
    wallet. The weekly cap (21 duels / 14 FFA) therefore applies to the wallet's
    total. A wallet with a single `uid` gets exactly the same score as before.
    The settlement's JSON response contains a `mergedWallets` field (wallets
    whose several `uid`s were summed; empty in the normal case) — to be looked at
    on the next cron run (`wrangler tail`). Tested outside the Worker (pure
    function, 4 cases); `wrangler deploy --dry-run` and the deployment pass.
    **Confirmed in real conditions on 05/10/2026** (first real settlement,
    `2026-W40`: `mergedWallets` correctly listed 2 wallets, 3 and 14 `uid`s
    summed — see point 17). Does not cover two `uid`s linked to two
    *different* wallets (accepted behavior, see the program README).
16. **New `/debug-submit-score` endpoint** (`index.ts`) — submits a **fixed**
    score (not computed from Firebase) for a single given wallet/`weekId`, via
    the same `submitWeeklyScoresOnChain` as the real settlement (so
    `finalizePool` also follows automatically on success). Used to build
    claimable test weeks without touching the KV snapshot or the real delta
    computation. Parameters: `?weekId=...&wallet=...&score=...`, same
    `X-Trigger-Secret` guard as the other manual endpoints. **Always initialize
    AND fund the pool (`/init-pool?...&amount=...`) BEFORE calling this
    endpoint**: once the pool is finalized (which happens automatically as soon
    as the first `submit_score` succeeds), `fund_pool` becomes permanently
    impossible (`PoolAlreadyFinalized`) — real case on `2026-W34`, left as is as
    a non-regression test of point 14 (the client must now show a clear failure
    on a claim of 0, instead of a false success — fix on the game side, see the
    README/changelog of the `last_man_skating` repo, not this one).


✅ Done (continued) — first real settlement (`2026-W40`, Monday 05/10/2026, 00:01 UTC):
17. **Discovery, FIXED on 05/10/2026: accounts created during the week were not
    paid at their first Monday.** The run itself was clean (log: `submitted: 2`,
    `failed: 0`, `snapshotAdvanced: true`; `mergedWallets`: `APrJ…` = 3 `uid`s,
    score 90, and `6pDn…` = 14 `uid`s, score 10, both matching the `wallets`
    export). But `computeWeeklyDeltas` gave a delta of **0** to any `uid` absent
    from the previous snapshot (a "safe" rule meant to avoid paying months of
    history), and the snapshot then recorded that `uid`'s totals — so its wins
    only counted from the *following* week: first payout two Mondays after the
    first match. Wins of W40 for accounts created that week (estimated ~59 duel
    wins + ~6 FFA wins on 9 wallets) were lost: pool finalized and snapshot
    already advanced, no automatic recovery.
    **Fix (05/10/2026, deployed)**: once a baseline exists, a `uid` absent from
    the previous snapshot is a new player and its delta = its **current totals**
    (baseline 0/0). Why it is safe: `duelStats/{uid}` / `ffaStats/{uid}` only
    exist from the first recorded online match, so an absent `uid` had played no
    online match before the previous snapshot. The very first run
    (`previousSnapshot === null`) still pays nobody (no baseline).
    **Known limit**: a `uid` that receives a *copied* history (sync code /
    migration, `_lmsCopyProgressBetweenUids` on the game side) is paid for it —
    bounded by the per-wallet weekly cap in `scoring.ts` (21 duels / 14 FFA =
    294 points), i.e. at most one full week.
    Checked on the live Worker with `/run-settlement?...&dryRun=1`: accounts
    created that day appear in `plan` with their score.
18. **Unpaid `uid`s no longer consume their delta (05/10/2026).** Until then the
    snapshot advanced for **everyone** as soon as one submission succeeded
    (point 10 only covered the "all failed" case): a wallet whose submission
    failed, or a player with no linked wallet (`skippedNoWallet`), silently lost
    the week. New `holdBackTotals()` (`weekSnapshot.ts`) keeps the previous
    snapshot values for those `uid`s (a new `uid` is stored at 0/0), so their
    delta is recomputed and paid at the next settlement. Consequence: a player
    who has not linked a wallet yet accumulates wins and is paid when they link
    one (still capped per week by `scoring.ts`).
19. **Safeguard + diagnostics (05/10/2026).**
    - **Pool guard**: before submitting, `runWeeklySettlement` reads the pool
      on-chain. If it is missing, already finalized, or **not funded**
      (`totalPot = 0`), it aborts (`aborted: true`, `abortReason`) without
      submitting, finalizing or advancing the snapshot (except at the very first
      run, to set the baseline). Reason: `finalize_pool` is irreversible and
      `fund_pool` refuses a finalized pool, so settling an unfunded pool would
      make every claim fail with `PayoutTooSmall`. Bypass with `?force=1`.
    - **Settlement journal in the KV**: every report is stored under
      `settlement-log:<weekId>:<ISO time>` (Cloudflare Observability logs expire
      quickly and hide empty arrays such as `failedDetails`). A cron crash is
      journaled too. The report now has a per-wallet `plan` (uids, raw wins,
      score) and `heldBackUids`.
    - The KV key `previous-totals-snapshot` keeps a copy of the snapshot that
      was just replaced, to allow recomputing a past delta.
    - New endpoints and options, see "Diagnostic endpoints" below; new file
      `src/poolInspect.ts` (read-only on-chain reading, replicates the
      `claim_scratch` formula).

⏳ Still to do before final submission:
- Decision: test LMS mint (devnet) vs mainnet LMS mint for the demo
- Anti-cheat limitation (collusion/self-play) still open — documented, fix
  postponed until after the hackathon
- ~~Grouping by wallet (not by `uid`) for score computation~~: fixed on
  03/10/2026 (see point 15 above); confirmed at the first real settlement on 05/10/2026
  (`mergedWallets` field).
- ~~Multi-week limitation~~: fixed on the client side on 13/09/2026 — the CLAIM
  button now catches up on up to 8 weeks of unclaimed winnings (see root README,
  "Multi-week claim" section). Still no on-chain deadline beyond that history.
- ~~Pool initialization automation~~: fixed on 15/09/2026 (see point 11 above).
  Funding (`fund_pool`) has supported optional auto-fund since that date
  (`AUTO_FUND_AMOUNT` secret absent = manual by choice) — **`AUTO_FUND_AMOUNT` is
  configured and active since 22/09/2026**: the full cycle (init + fund + submit
  + finalize) now runs on its own every week, with no manual intervention. The
  `/init-pool?...&amount=...` endpoint remains available for an additional
  one-off funding (event, promo) without touching the secret or disabling
  auto-fund for the following weeks.
- ~~Decimal amount bug~~: fixed on 19/09/2026 (see point 12 above).
- ~~Sunday/Monday cron desync~~: fixed on 22/09/2026 (see point 13).
- ~~Confirmation timeout classified as failure~~: fixed on 22/09/2026 (see point
  14).


## `@coral-xyz/anchor` (JS SDK) — verified on 19/09/2026

`poolLifecycle.ts` builds the program through
`new anchor.Program(idl as anchor.Idl, provider)` (without `programId` as 2nd
argument) — valid syntax from version 0.30 of the `@coral-xyz/anchor` JS SDK.
**Confirmed in `package.json`: `"@coral-xyz/anchor": "^0.30.1"`** — the current
syntax is therefore correct, nothing to fix.

Reminder for future reference: this is independent of the `anchor-lang` (Rust)
version of the on-chain program, which stays at `0.29.0` (see
`programs/lms_proof_of_play/README.md`) — the two version different things
(client JS SDK vs on-chain Rust crate) and do not have to match.

## What changed compared to the previous version (Firestore)

- `firestoreQuery.ts` → `rtdbQuery.ts`: RTDB REST API (`GET /duelStats.json`,
  `/ffaStats.json`, `/wallets.json`) instead of Firestore.
- `firebaseAuth.ts`: OAuth scope `firebase.database` instead of
  `datastore.readonly`. **Give the service account the IAM role "Firebase
  Realtime Database Viewer"** (Google Cloud Console > IAM) — it is this role,
  not the scope, that guarantees read-only access.
- `scoring.ts`: formula reduced to `duelWins`/`ffaWins` — `ffaEliminations` and
  `missionsCompleted` have no server-synchronized data (confirmed in the HTML:
  missions 100% `localStorage`, no FFA eliminations field in the Rules).
- `weekSnapshot.ts` (new): `duelStats`/`ffaStats` are lifetime cumulative, not
  weekly — this file computes the weekly delta via a KV snapshot taken at the
  previous run.
- `index.ts`: `week_id` computation rewritten to be identical to `_lmsWeekKey()`
  on the game side (ISO 8601 Thursday-based) — the old formula could diverge.
  The manual endpoint's secret now comes from `env.MANUAL_TRIGGER_SECRET` (no
  more hardcoded value in the code).
- `solanaSubmit.ts`: confirmation timeout raised to 60 s (see Status above).
  Also exposes `walletFromSecretKey`, a minimal implementation of the Anchor
  wallet (the SDK's standard `anchor.Wallet` crashes in the Workers
  environment) — reused as is by `poolLifecycle.ts` rather than duplicated.
- `poolLifecycle.ts` (new, 15/09/2026): automatic opening **and funding** of the
  upcoming week's pool (`initialize_weekly_pool` + `fund_pool`), called from the
  same cron as the settlement. See "Pool opening automation" above and the note
  on the Anchor JS version above.

- `weekSnapshot.ts` (05/10/2026): new `uid`s are paid from their current totals
  (once a baseline exists), `holdBackTotals()` for unpaid `uid`s, copy of the
  previous snapshot in the KV.
- `index.ts` (05/10/2026): pool guard, KV settlement journal, `dryRun`/`force`
  options, endpoints `/last-settlement` and `/inspect-pool`.
- `poolInspect.ts` (new, 05/10/2026): read-only on-chain inspection of a pool
  and of the players' scores.

## Installation

```bash
npm install
npx wrangler login
npx wrangler kv namespace create WEEK_SNAPSHOT_KV
# paste the returned id into wrangler.jsonc in place of METS-TON-KV-ID-ICI
```

## Secrets (never in the code, never committed)

```bash
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
# paste the service account's full JSON (Firebase Console >
# Project settings > Service accounts > Generate new private key)

npx wrangler secret put SOLANA_AUTHORITY_SECRET_KEY
# paste the authority wallet's base58 private key

npx wrangler secret put MANUAL_TRIGGER_SECRET
# choose a long random value, used to protect /run-settlement
# and /init-pool

npx wrangler secret put SOLANA_MINT_ADDRESS
# address of the SPL mint (current devnet test token) — used by
# poolLifecycle.ts to initialize/fund the pool

# Optional — leave absent to keep fund_pool 100% manual:
npx wrangler secret put AUTO_FUND_AMOUNT
# fixed amount (in token units, NOT raw/decimal units) to transfer
# automatically every week, e.g. "10" or "0.5" (decimal amounts are
# supported since the 19/09/2026 fix, see point 12 above). Absent or
# empty = fund_pool stays manual, only init is automatic.
```

**State on this project: configured and active since 22/09/2026.** The exact
value cannot be consulted afterwards — Cloudflare secrets are write-only,
`wrangler secret list` shows only the names, never the values. To recover it:
read `fundAmountUi` in the logs of the next cron run (`npx wrangler tail`), or in
the response of an `/init-pool?weekId=<week not yet funded>` (without `amount`,
so that `AUTO_FUND_AMOUNT` applies instead of being replaced — this really funds
that week, it is not a mere read), or directly `totalPot` of the `WeeklyPool`
account of an auto-funded week on Solana Explorer. To change it, setting the
secret again overwrites it without needing to know the old value.

## Local development

Local KV storage (Miniflare) can fail silently if the project path is too long
(Windows ~260 character limit) — observed symptom: `internal error; reference =
...` on any KV read/write. If this happens, force a short local storage
directory:

```bash
wrangler dev --persist-to="C:\wrangler-state"
```

(already built into the `dev` script of `package.json`)

```bash
npm run dev
curl -X POST "http://localhost:8787/run-settlement?weekId=2026-W37" \
  -H "X-Trigger-Secret: <your MANUAL_TRIGGER_SECRET value>"

# Initialize/fund a week by hand (new):
curl -X POST "http://localhost:8787/init-pool?weekId=2026-W39&amount=10" \
  -H "X-Trigger-Secret: <your MANUAL_TRIGGER_SECRET value>"
# `amount` is optional: without it, only init is done (no fund_pool)

# Build a claimable test week, fixed score independent of the real Firebase
# computation (22/09/2026) — ALWAYS after an /init-pool with `amount`
# confirmed `funded: true`, otherwise the pool finalizes at 0 with no way back:
curl -X POST "http://localhost:8787/debug-submit-score?weekId=2026-W33&wallet=<pubkey>&score=42" \
  -H "X-Trigger-Secret: <your MANUAL_TRIGGER_SECRET value>"
```

## Diagnostic endpoints (05/10/2026)

All protected by the same `X-Trigger-Secret` header. They never write on-chain
(except `/run-settlement` without `dryRun`, which is the real settlement).

```bash
# Simulate a settlement: nothing submitted, snapshot and journal untouched.
# Shows per wallet the merged uids, raw wins and score (`plan`), `mergedWallets`,
# `skippedNoWallet`.
curl -H "X-Trigger-Secret: <value>" "https://<worker>.workers.dev/run-settlement?weekId=2026-W41&dryRun=1"

# On-chain state of a pool: pot, vault balance, finalized, diagnostics;
# add &wallet=<pubkey> for one player, or &all=1 for every score of the week
# with the amount each wallet will receive.
curl -H "X-Trigger-Secret: <value>" "https://<worker>.workers.dev/inspect-pool?weekId=2026-W40&all=1"

# Reports of past settlements, kept in the KV (survive Observability logs).
curl -H "X-Trigger-Secret: <value>" "https://<worker>.workers.dev/last-settlement?weekId=2026-W40"
```

`/run-settlement?...&force=1` bypasses the pool guard (point 19).

## Deployment

```bash
npm run deploy
```

The Cron Trigger defined in `wrangler.jsonc` activates automatically on
deployment — verifiable in the Cloudflare dashboard (Workers & Pages > your
worker > Triggers).

**Reminder**: a `git push` never redeploys this Worker by itself — it is `npx
wrangler deploy` (or `npm run deploy`) that pushes the code to production. A
GitHub commit without redeployment documents the code but changes nothing to the
live Worker's real behavior.

## What this worker does / assumes done elsewhere

- `initialize_weekly_pool` **and** `fund_pool` for the upcoming `weekId` —
  **automated** since 15/09/2026, triggered by the same cron as the settlement
  (see `src/poolLifecycle.ts`), with a fixed amount defined by
  `AUTO_FUND_AMOUNT`. Manual intervention remains possible at any time
  (`/init-pool` endpoint or Playground scripts) without disabling the cron: the
  "totalPot > 0" safeguard prevents auto-fund from adding to an amount already
  set by hand. For `2026-W37` and `2026-W38`, the pool was initialized and
  funded manually via Solana Playground test scripts, with the devnet test LMS
  mint (6 decimals).
- The `wallets/{uid}` node — done.
- Minting of the "Sanctuaire Seeker" NFTs (Proximity mode) — **out of scope for
  this Worker**, handled entirely on-chain by the `lms_proof_of_play` program
  (`mint_meeting_nft` instruction) and triggered directly from the game (MWA
  double signature of the two players), without any intervention from this
  Worker or any backend authority. See `programs/lms_proof_of_play/README.md`.

## First run after deployment (or after any KV reset)

The very first run has no previous snapshot in the KV — `weekSnapshot.ts` then
treats each player as having a delta of 0 (no score, nobody is paid) and merely
records the first snapshot. It is the *next* run, a week later (or the next
manual call after a new game played), that will produce the first real
settlement.

Once a baseline exists, a `uid` that is absent from the snapshot (new player) is
paid from its current totals — see point 17. Only the very first run pays nobody.

## Points of attention (audit of 02/10/2026)

The Worker code was re-read on 03/10/2026 (no blocking flaw found other than
point 15, since fixed); these points also come from the READMEs, the RTDB rules
and the client.

- **Point 15 (grouping by wallet)**: fixed on 03/10/2026 (see above); confirmed
  at the first real settlement (05/10/2026) via the `mergedWallets` field.
- **RPC endpoint**: QuickNode is no longer used; the Worker must point to Helius
  devnet via the `SOLANA_RPC_URL` secret. A `.dev.vars` only applies to `wrangler
  dev`: for production, `npx wrangler secret put SOLANA_RPC_URL` (secret values
  are never shown by `wrangler secret list`). Only delete the old endpoint at
  QuickNode after this update.
- **Scores = client-declared counters**: the RTDB rules let each user write their
  own `duelStats`/`ffaStats` (`wins`/`losses` ≤ 100000, non-decreasing total).
  The weekly cap in `scoring.ts` is therefore the only bound: keep it as is as
  long as `matchHistory` does not exist.
- **Reading the rules**: this Worker reads through a service account (Viewer
  role), hence independently of the rules; they neither protect nor hinder it.
- **Type checking (03/10/2026)**: `npx tsc --noEmit` reported `Property
  'weeklyPool' does not exist on type 'AccountNamespace<Idl>'` in
  `poolLifecycle.ts` (the `Program` is typed as generic `Idl`). No effect at
  runtime (Anchor creates `program.account.weeklyPool` from the IDL, and
  `wrangler` does not type-check); worked around with `(program.account as
  any).weeklyPool.fetchNullable(...)`.

---

<a id="version-francaise"></a>

# 🇫🇷 Version française

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
   (bloqué par rate-limit IP, erreur 403) vers un endpoint dédié QuickNode
   (remplacé depuis par Helius devnet : QuickNode n'est plus utilisé, 02/10/2026).
   Timeout de confirmation augmenté à 60s dans `solanaSubmit.ts` (le
   endpoint public confirmait sous 10s ; QuickNode a mis plus de 30s sur au
   moins un test, d'où l'ajustement).
5. **Pool hebdomadaire réelle** initialisée on-chain pour `weekId = 2026-W37`
   (mint LMS de test sur devnet, 6 décimales).
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

✅ Fait (suite) :
13. **Fix cron dimanche au lieu de lundi (22/09/2026)** — `"crons": ["1 0 * * 1"]`
    dans `wrangler.jsonc` tournait en réalité le **dimanche** 00:01 UTC, pas
    le lundi. Cloudflare interprète le jour-semaine différemment du cron Unix
    standard : chez eux `1 = dimanche` (`0`/`7 = dimanche`, `1 = lundi`
    ailleurs). Confirmé par le dashboard lui-même ("Runs At 12:01 AM on
    **Sunday**"). Conséquence réelle : le règlement tournait ~24h avant la
    vraie fin de semaine ISO côté client, sur un delta incomplet, et avançait
    le snapshot KV prématurément. Corrigé avec la forme à 3 lettres
    (`"1 0 * * MON"`), qui lève l'ambiguïté sans dépendre de la convention du
    fournisseur.
14. **Fix "timeout de confirmation ≠ échec"** sur les 4 appels `.rpc()`
    critiques (`submitScore`, `finalizePool` dans `solanaSubmit.ts` ;
    `initializeWeeklyPool`, `fundPool` dans `poolLifecycle.ts`). Cas réel
    constaté sur `2026-W38` : un timeout de 60s classait la soumission en
    "failed" alors que la transaction avait réellement été acceptée
    on-chain (vérifié sur Solana Explorer) — ce qui faisait sauter
    `finalizePool()` (jamais appelé si aucun succès détecté) et, une fois
    `finalizePool` lui-même touché par le même problème, plantait carrément
    la requête entière (exception non attrapée → 500 générique au lieu du
    JSON de résultat). `resolveTimeoutSignature()` (exporté depuis
    `solanaSubmit.ts`, réutilisé par `poolLifecycle.ts`) extrait la
    signature du message d'erreur de timeout et vérifie l'état réel via
    `getSignatureStatus` avant de conclure à un échec.
    - **Effet de bord découvert sur `2026-W38`** : le score réel (116,
      calculé correctement depuis le snapshot KV du 14/09) avait été
      écrasé à **36** par un run de test antérieur au fix, puis la pool a
      fini par se finaliser (via un des timeouts "faux positifs"
      ci-dessus) avant qu'on ait pu corriger la valeur.
      `submit_score` n'a aucune garde anti-régression on-chain (design
      voulu — voir `programs/lms_proof_of_play/README.md` si son
      `lib.rs` documente ce choix), donc rien n'a empêché l'écrasement,
      mais **une fois finalisée, plus aucune correction n'est possible**
      (`PoolAlreadyFinalized` sur toute nouvelle tentative). **Décision :
      on laisse `2026-W38` à 36 tel quel** — impact réel nul (uniquement
      les wallets de dev/test à ce stade), mais à garder en tête : une
      resoumission de score doit être vérifiée (`_lmsGetClaimContext` côté
      client, ou lecture directe du compte `PlayerScore`) **avant**
      `finalize_pool`, pas après.
15. **Découverte, CORRIGÉE le 03/10/2026 : fragmentation d'un wallet sur plusieurs
    `uid` Firebase.** `duelStats`/`ffaStats`/`wallets` sont indexés par
    `uid` d'auth anonyme, qui change à **chaque reinstall/cache clear**
    (constaté en prod de test : un seul wallet, `6pDn...ZoU2`, lié à
    **24 `uid` différents**). Comme `weekSnapshot.ts`/`index.ts` calculent
    le delta et l'éligibilité **par `uid`**, l'historique d'un joueur qui
    réinstalle se fragmente en plusieurs identités quasi-vierges, et
    surtout : si 2+ `uid` d'un même wallet ont un score>0 la même semaine,
    la boucle de soumission fait un `submit_score` par `uid` sur le
    **même** `PlayerScore` PDA — `submit_score` écrasant (pas cumulant),
    seul le dernier appel de la boucle survit, les autres sont perdus
    silencieusement.
    **Correctif (03/10/2026, déployé)** : `groupDeltasByWallet`
    (`weekSnapshot.ts`) additionne les deltas de tous les `uid` qui
    partagent la même adresse wallet **avant** `computeWeeklyScore`, et
    `index.ts` n'envoie plus qu'un `submit_score` par wallet. Le plafond
    hebdomadaire (21 duels / 14 FFA) s'applique donc au total du wallet.
    Un wallet à un seul `uid` donne exactement le même score qu'avant.
    La réponse JSON du règlement contient un champ `mergedWallets`
    (wallets dont plusieurs `uid` ont été additionnés ; vide dans le cas
    normal) — à regarder au premier cron suivant (`wrangler tail`).
    Testé hors Worker (fonction pure, 4 cas) ; `wrangler deploy --dry-run`
    et le déploiement passent. **Confirmé en conditions réelles le 05/10/2026**
    (premier règlement réel, `2026-W40` : `mergedWallets` a bien listé 2
    wallets, 3 et 14 `uid` additionnés — voir point 17).
    Ne couvre pas deux `uid` liés à deux wallets *différents*
    (comportement assumé, voir le README du programme).
16. **Nouvel endpoint `/debug-submit-score`** (`index.ts`) — soumet un
    score **fixe** (pas calculé depuis Firebase) pour un seul
    wallet/`weekId` donné, via le même `submitWeeklyScoresOnChain` que le
    vrai règlement (donc `finalizePool` suit aussi automatiquement en cas
    de succès). Sert à fabriquer des semaines réclamables de test sans
    toucher au snapshot KV ni au calcul de delta réel. Paramètres :
    `?weekId=...&wallet=...&score=...`, même garde `X-Trigger-Secret` que
    les autres endpoints manuels. **Toujours initialiser ET financer la
    pool (`/init-pool?...&amount=...`) AVANT d'appeler cet endpoint** :
    une fois la pool finalisée (ce qui arrive automatiquement dès le
    premier `submit_score` réussi), `fund_pool` devient définitivement
    impossible (`PoolAlreadyFinalized`) — cas réel sur `2026-W34`,
    laissée telle quelle comme test de non-régression du point 14
    (le client doit maintenant afficher un échec clair sur une
    réclamation à 0, au lieu d'un faux succès — fix côté jeu, voir le
    README/changelog du repo `last_man_skating`, pas celui-ci).


✅ Fait (suite) — premier règlement réel (`2026-W40`, lundi 05/10/2026, 00:01 UTC) :
17. **Découverte, CORRIGÉE le 05/10/2026 : les comptes créés pendant la semaine
    n'étaient pas payés au premier lundi.** Le run lui-même était propre (log :
    `submitted: 2`, `failed: 0`, `snapshotAdvanced: true` ; `mergedWallets` :
    `APrJ…` = 3 `uid`, score 90, et `6pDn…` = 14 `uid`, score 10, conformes à
    l'export de `wallets`). Mais `computeWeeklyDeltas` donnait un delta de **0**
    à tout `uid` absent du snapshot précédent (règle « prudente » pour ne pas
    payer des mois d'historique), puis le snapshot enregistrait les totaux de ce
    `uid` — ses victoires ne comptaient donc qu'à partir de la semaine
    *suivante* : premier gain deux lundis après le premier match. Les victoires
    W40 des comptes créés cette semaine-là (estimé ~59 victoires en duel + ~6 en
    FFA sur 9 wallets) sont perdues : pool finalisée et snapshot déjà avancé,
    aucun rattrapage automatique.
    **Correctif (05/10/2026, déployé)** : dès qu'une baseline existe, un `uid`
    absent du snapshot précédent est un nouveau joueur et son delta = ses
    **totaux actuels** (baseline 0/0). Pourquoi c'est sûr : `duelStats/{uid}` /
    `ffaStats/{uid}` n'existent qu'à partir du premier match en ligne enregistré,
    donc un `uid` absent n'avait joué aucun match en ligne avant le snapshot
    précédent. Le tout premier run (`previousSnapshot === null`) ne paie toujours
    personne (pas de baseline).
    **Limite connue** : un `uid` qui reçoit un historique *copié* (code de
    synchro / migration, `_lmsCopyProgressBetweenUids` côté jeu) est payé pour
    cet historique — borné par le plafond hebdomadaire par wallet de
    `scoring.ts` (21 duels / 14 FFA = 294 points), soit au plus une semaine
    pleine.
    Vérifié sur le Worker en ligne avec `/run-settlement?...&dryRun=1` : les
    comptes créés le jour même apparaissent dans `plan` avec leur score.
18. **Les `uid` non payés ne consomment plus leur delta (05/10/2026).** Jusque-là
    le snapshot avançait pour **tout le monde** dès qu'une soumission réussissait
    (le point 10 ne couvrait que le cas « tout a échoué ») : un wallet dont la
    soumission échouait, ou un joueur sans wallet lié (`skippedNoWallet`),
    perdait sa semaine sans bruit. Nouveau `holdBackTotals()`
    (`weekSnapshot.ts`) : ces `uid` gardent leurs anciennes valeurs dans le
    snapshot (un `uid` nouveau est enregistré à 0/0), leur delta est donc
    recalculé et payé au règlement suivant. Conséquence : un joueur qui n'a pas
    encore lié de wallet cumule ses victoires et est payé quand il en lie un
    (toujours plafonné par semaine par `scoring.ts`).
19. **Garde-fou + diagnostics (05/10/2026).**
    - **Garde-fou de pool** : avant de soumettre, `runWeeklySettlement` lit la
      pool on-chain. Si elle est absente, déjà finalisée ou **non financée**
      (`totalPot = 0`), il s'arrête (`aborted: true`, `abortReason`) sans
      soumettre, finaliser ni faire avancer le snapshot (sauf au tout premier
      run, pour poser la baseline). Raison : `finalize_pool` est irréversible et
      `fund_pool` refuse une pool finalisée, donc régler une pool non financée
      ferait échouer toutes les réclamations en `PayoutTooSmall`. Contournable
      avec `?force=1`.
    - **Journal des règlements dans le KV** : chaque rapport est conservé sous
      `settlement-log:<weekId>:<horodatage ISO>` (les logs Observability de
      Cloudflare expirent vite et masquent les tableaux vides comme
      `failedDetails`). Un crash du cron est aussi journalisé. Le rapport
      contient maintenant un `plan` par wallet (uid, victoires brutes, score) et
      `heldBackUids`.
    - La clé KV `previous-totals-snapshot` garde une copie du snapshot qui vient
      d'être remplacé, pour pouvoir recalculer un delta passé.
    - Nouveaux endpoints et options : voir « Endpoints de diagnostic » plus bas ;
      nouveau fichier `src/poolInspect.ts` (lecture on-chain seule, reproduit la
      formule de `claim_scratch`).

⏳ Reste à faire avant soumission finale :
- Décision mint LMS de test (devnet) vs mint LMS mainnet pour la démo
- Limitation anti-triche (collusion/self-play) toujours ouverte —
  documentée, correctif reporté après le hackathon
- ~~Regroupement par wallet (pas par `uid`) pour le calcul du score~~ :
  réglé le 03/10/2026 (voir point 15 ci-dessus) ; confirmé au premier
  règlement réel le 05/10/2026 (champ `mergedWallets`).
- ~~Limitation multi-semaines~~ : réglée côté client le 13/09/2026 — le
  bouton RÉCLAMER rattrape maintenant jusqu'à 8 semaines de gains non
  réclamés (voir README racine, section "Réclamation multi-semaines").
  Toujours pas de deadline on-chain au-delà de cet historique.
- ~~Automatisation de l'initialisation de pool~~ : réglée le 15/09/2026
  (voir point 11 ci-dessus). Le financement (`fund_pool`) supportait déjà
  l'auto-fund en option depuis cette date (secret `AUTO_FUND_AMOUNT`
  absent = manuel par choix) — **`AUTO_FUND_AMOUNT` est configuré et actif
  depuis le 22/09/2026** : le cycle complet (init + fund + submit +
  finalize) tourne désormais seul chaque semaine, sans intervention
  manuelle. L'endpoint `/init-pool?...&amount=...` reste disponible pour
  un financement ponctuel additionnel (événement, promo) sans toucher au
  secret ni désactiver l'auto-fund des semaines suivantes.
- ~~Bug montant décimal~~ : réglé le 19/09/2026 (voir point 12 ci-dessus).
- ~~Désync cron dimanche/lundi~~ : réglé le 22/09/2026 (voir point 13).
- ~~Timeout de confirmation classé comme échec~~ : réglé le 22/09/2026
  (voir point 14).


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

- `weekSnapshot.ts` (05/10/2026) : les nouveaux `uid` sont payés sur leurs totaux
  actuels (dès qu'une baseline existe), `holdBackTotals()` pour les `uid` non
  payés, copie du snapshot précédent dans le KV.
- `index.ts` (05/10/2026) : garde-fou de pool, journal des règlements dans le KV,
  options `dryRun`/`force`, endpoints `/last-settlement` et `/inspect-pool`.
- `poolInspect.ts` (nouveau, 05/10/2026) : inspection on-chain en lecture seule
  d'une pool et des scores des joueurs.

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

**État sur ce projet : configuré et actif depuis le 22/09/2026.** La valeur
exacte n'est pas consultable a posteriori — les secrets Cloudflare sont
écriture seule, `wrangler secret list` ne montre que les noms, jamais les
valeurs. Pour la retrouver : lire `fundAmountUi` dans les logs du prochain
passage du cron (`npx wrangler tail`), ou dans la réponse d'un
`/init-pool?weekId=<semaine pas encore financée>` (sans `amount`, pour
laisser `AUTO_FUND_AMOUNT` s'appliquer plutôt que de le remplacer — ça
finance réellement cette semaine, pas une simple lecture), ou directement
`totalPot` du compte `WeeklyPool` d'une semaine auto-financée sur Solana
Explorer. Pour la changer, reposer le secret l'écrase sans besoin de
connaître l'ancienne valeur.

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

# Fabriquer une semaine de test réclamable, score fixe indépendant du calcul
# Firebase réel (22/09/2026) — TOUJOURS après un /init-pool avec `amount`
# confirmé `funded: true`, sinon la pool se finalise à 0 sans retour possible :
curl -X POST "http://localhost:8787/debug-submit-score?weekId=2026-W33&wallet=<pubkey>&score=42" \
  -H "X-Trigger-Secret: <ta valeur de MANUAL_TRIGGER_SECRET>"
```

## Endpoints de diagnostic (05/10/2026)

Tous protégés par le même en-tête `X-Trigger-Secret`. Aucun n'écrit on-chain
(sauf `/run-settlement` sans `dryRun`, qui est le vrai règlement).

```bash
# Simuler un règlement : rien n'est soumis, snapshot et journal intacts.
# Montre par wallet les uid regroupés, les victoires brutes et le score (`plan`),
# `mergedWallets`, `skippedNoWallet`.
curl -H "X-Trigger-Secret: <valeur>" "https://<worker>.workers.dev/run-settlement?weekId=2026-W41&dryRun=1"

# État on-chain d'une pool : pot, solde du vault, finalisée, diagnostics ;
# ajouter &wallet=<pubkey> pour un joueur, ou &all=1 pour tous les scores de la
# semaine avec le montant que chaque wallet recevra.
curl -H "X-Trigger-Secret: <valeur>" "https://<worker>.workers.dev/inspect-pool?weekId=2026-W40&all=1"

# Rapports des règlements passés, conservés dans le KV (survivent aux logs Observability).
curl -H "X-Trigger-Secret: <valeur>" "https://<worker>.workers.dev/last-settlement?weekId=2026-W40"
```

`/run-settlement?...&force=1` contourne le garde-fou de pool (point 19).

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
  test Solana Playground, avec le mint LMS de test sur devnet
  (6 décimales).
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

Une fois la baseline posée, un `uid` absent du snapshot (nouveau joueur) est payé
sur ses totaux actuels — voir point 17. Seul le tout premier run ne paie personne.

## Points d'attention (audit du 02/10/2026)

Le code du Worker a été relu le 03/10/2026 (aucun défaut bloquant trouvé hors
le point 15, corrigé depuis) ; ces points viennent aussi des README, des rules
RTDB et du client.

- **Point 15 (regroupement par wallet)** : corrigé le 03/10/2026 (voir plus haut) ;
  confirmé au premier règlement réel (05/10/2026) via le champ `mergedWallets`.
- **Endpoint RPC** : QuickNode n'est plus utilisé ; le Worker doit pointer vers
  Helius devnet via le secret `SOLANA_RPC_URL`. Un `.dev.vars` ne vaut que pour
  `wrangler dev` : pour la production, `npx wrangler secret put SOLANA_RPC_URL`
  (les valeurs des secrets ne sont jamais affichées par `wrangler secret list`).
  Ne supprimer l'ancien endpoint chez QuickNode qu'après cette mise à jour.
- **Scores = compteurs déclarés par le client** : les rules RTDB autorisent
  chaque utilisateur à écrire ses propres `duelStats`/`ffaStats`
  (`wins`/`losses` ≤ 100000, total non décroissant). Le plafond hebdomadaire de
  `scoring.ts` est donc la seule borne : à conserver tel quel tant que
  `matchHistory` n'existe pas.
- **Lecture des rules** : ce Worker lit via un compte de service (rôle Viewer),
  donc indépendamment des rules ; elles ne le protègent ni ne le gênent.
- **Vérification de types (03/10/2026)** : `npx tsc --noEmit` signalait
  `Property 'weeklyPool' does not exist on type 'AccountNamespace<Idl>'` dans
  `poolLifecycle.ts` (le `Program` est typé `Idl` générique). Sans effet à
  l'exécution (Anchor crée `program.account.weeklyPool` depuis l'IDL, et
  `wrangler` ne vérifie pas les types) ; contourné par
  `(program.account as any).weeklyPool.fetchNullable(...)`.
