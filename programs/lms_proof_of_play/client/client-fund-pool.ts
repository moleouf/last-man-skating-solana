// client.ts — Init + fund de la cagnotte hebdomadaire réelle (Solana Playground)
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getMint, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const WEEK_ID = "2026-W38"; // semaine réelle en cours (à changer chaque semaine)
const MINT = new PublicKey("64TQTAykeYQmRmeqMDKB2kWJGGSp8FuGLpEkcJfdwSY6"); // ton jeton de test "LMS"
const AMOUNT_UI = 10; // 10 tokens de test — montant symbolique pour la démo hackathon

const [weeklyPoolPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool"), Buffer.from(WEEK_ID)],
  pg.program.programId
);
const [vaultPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault"), Buffer.from(WEEK_ID)],
  pg.program.programId
);

console.log("weekId:", WEEK_ID);
console.log("weeklyPool PDA:", weeklyPoolPda.toBase58());
console.log("vault PDA:", vaultPda.toBase58());

// 1. Initialise la pool (si elle n'existe pas déjà — sinon cette étape échouera
//    avec "already in use", ce qui est normal si tu relances le script)
try {
  const sigInit = await pg.program.methods
    .initializeWeeklyPool(WEEK_ID)
    .accounts({
      authority: pg.wallet.publicKey,
      weeklyPool: weeklyPoolPda,
      mint: MINT,
      vault: vaultPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .rpc({ commitment: "confirmed" });
  console.log("✅ Pool initialisée:", sigInit);
} catch (err) {
  console.log("⚠️ initialize_weekly_pool a échoué (déjà initialisée ? voir message ci-dessous):");
  console.log(String(err));
}

// 2. Récupère (ou crée) ton compte de tokens LMS, et le décimal réel du mint
const funderTokenAccount = await getOrCreateAssociatedTokenAccount(
  pg.connection,
  pg.wallet.payer,
  MINT,
  pg.wallet.publicKey
);
const mintInfo = await getMint(pg.connection, MINT);
// Math.round : accepte les montants décimaux (ex. 0.5), contrairement à BigInt(AMOUNT_UI).
const amountRaw = BigInt(Math.round(AMOUNT_UI * 10 ** mintInfo.decimals));

console.log("decimales du mint:", mintInfo.decimals);
console.log("montant brut à transférer:", amountRaw.toString());

// 3. Finance la pool
const sigFund = await pg.program.methods
  .fundPool(new anchor.BN(amountRaw.toString()))
  .accounts({
    funder: pg.wallet.publicKey,
    funderTokenAccount: funderTokenAccount.address,
    weeklyPool: weeklyPoolPda,
    vault: vaultPda,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .rpc({ commitment: "confirmed" });
console.log("✅ Pool financée:", sigFund);

// 4. Relit l'état final pour confirmation visuelle
const pool = await pg.program.account.weeklyPool.fetch(weeklyPoolPda, "confirmed");
console.log("État final de la pool:", {
  weekId: pool.weekId,
  totalPot: pool.totalPot.toString(),
  finalized: pool.finalized,
});
