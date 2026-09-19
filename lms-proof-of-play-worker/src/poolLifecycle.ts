import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getMint,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
// Même wallet minimal que solanaSubmit.ts — anchor.Wallet plante dans les
// Workers, donc on réutilise EXACTEMENT la même implémentation maison
// plutôt que d'en écrire une deuxième.
import { walletFromSecretKey } from "./solanaSubmit";
import idl from "./idl/lms_proof_of_play.json";
// "Env" n'est pas dans un fichier séparé chez toi : il est défini et
// exporté directement dans index.ts (voir `export interface Env`). On
// l'importe donc de là — c'est un import de TYPE uniquement (mot-clé
// "type"), il est effacé à la compilation, donc AUCUN risque de dépendance
// circulaire même si index.ts importe ce fichier de son côté.
import type { Env } from "./index";

interface PoolLifecycleResult {
  weekId: string;
  initialized: boolean; // true seulement si CE run vient de créer la pool
  alreadyExisted: boolean;
  funded: boolean;
  fundSkippedReason?: string;
  fundAmountUi?: number;
  initSig?: string;
  fundSig?: string;
  error?: string;
}

/**
 * Initialise (et finance optionnellement) la pool pour weekId.
 * Ne lève jamais d'exception vers l'appelant — toute erreur est capturée et
 * renvoyée dans `error`, pour que le cron continue même si cette étape rate.
 */
export async function ensureWeeklyPoolInitialized(
  env: Env,
  weekId: string
): Promise<PoolLifecycleResult> {
  const result: PoolLifecycleResult = {
    weekId,
    initialized: false,
    alreadyExisted: false,
    funded: false,
  };

  try {
    const connection = new Connection(env.SOLANA_RPC_URL, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 60000, // même valeur que solanaSubmit.ts
    });
    const wallet = walletFromSecretKey(env.SOLANA_AUTHORITY_SECRET_KEY);
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
    const program = new anchor.Program(idl as anchor.Idl, provider); // Anchor 0.30+ : pas de programId en 2e arg
    const programId = new PublicKey(env.SOLANA_PROGRAM_ID);
    const mint = new PublicKey(env.SOLANA_MINT_ADDRESS);

    const [weeklyPoolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), Buffer.from(weekId)],
      programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(weekId)],
      programId
    );

    // 1. Init — idempotent : "already in use" = pool déjà ouverte (par un
    // run précédent ou manuellement), on continue sans planter le cron.
    try {
      const initSig = await program.methods
        .initializeWeeklyPool(weekId)
        .accounts({
          authority: wallet.publicKey,
          weeklyPool: weeklyPoolPda,
          mint,
          vault: vaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc({ commitment: "confirmed" });
      result.initialized = true;
      result.initSig = initSig;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already in use")) {
        result.alreadyExisted = true;
      } else {
        result.error = `init failed: ${msg}`;
        return result; // init a vraiment échoué -> inutile de tenter fund_pool
      }
    }

    // 2. Fund optionnel — uniquement si AUTO_FUND_AMOUNT est défini et > 0.
    const autoFundRaw = (env.AUTO_FUND_AMOUNT ?? "").trim();
    if (!autoFundRaw) {
      result.fundSkippedReason = "AUTO_FUND_AMOUNT absent/vide -> fund manuel";
      return result;
    }

    const amountUi = Number(autoFundRaw);
    if (!Number.isFinite(amountUi) || amountUi <= 0) {
      result.error = (result.error ? result.error + " | " : "") +
        `AUTO_FUND_AMOUNT invalide: "${autoFundRaw}"`;
      return result;
    }

    // Garde-fou : fund_pool s'ADDITIONNE à chaque appel (il ne remplace
    // jamais le pot existant). Si la pool a déjà un totalPot > 0 (fund
    // manuel fait juste avant que le cron tourne, via /init-pool ou un
    // script Playground), on NE fund PAS une deuxième fois automatiquement
    // -> le pot ne serait sinon doublé sans que ce soit voulu.
    const existingPool = await program.account.weeklyPool.fetchNullable(weeklyPoolPda, "confirmed");
    if (existingPool?.totalPot && BigInt(existingPool.totalPot.toString()) > 0n) {
      result.fundSkippedReason = "pool déjà financée manuellement (totalPot > 0), auto-fund sauté";
      return result;
    }

    const funderTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet.payer,
      mint,
      wallet.publicKey
    );
    const mintInfo = await getMint(connection, mint);
    // Math.round : accepte les montants décimaux ("0.5"), contrairement à BigInt(amountUi).
    const amountRaw = BigInt(Math.round(amountUi * 10 ** mintInfo.decimals));

    const fundSig = await program.methods
      .fundPool(new anchor.BN(amountRaw.toString()))
      .accounts({
        funder: wallet.publicKey,
        funderTokenAccount: funderTokenAccount.address,
        weeklyPool: weeklyPoolPda,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    result.funded = true;
    result.fundAmountUi = amountUi;
    result.fundSig = fundSig;
    return result;
  } catch (err) {
    result.error = (result.error ? result.error + " | " : "") + (err instanceof Error ? err.message : String(err));
    return result;
  }
}
