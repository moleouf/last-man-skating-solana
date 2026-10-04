import { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes: Uint8Array): string {
  let intVal = BigInt(0);
  for (const b of bytes) intVal = intVal * BigInt(256) + BigInt(b);
  let result = "";
  while (intVal > BigInt(0)) {
    const rem = intVal % BigInt(58);
    result = BASE58_ALPHABET[Number(rem)] + result;
    intVal = intVal / BigInt(58);
  }
  for (const b of bytes) {
    if (b === 0) result = "1" + result;
    else break;
  }
  return result;
}

const [mintCounterPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("mint_counter")],
  pg.program.programId
);

const playerA = Keypair.generate();
const playerB = Keypair.generate();

const [playerMintRecordA] = PublicKey.findProgramAddressSync(
  [Buffer.from("player_mint"), playerA.publicKey.toBuffer()],
  pg.program.programId
);
const [playerMintRecordB] = PublicKey.findProgramAddressSync(
  [Buffer.from("player_mint"), playerB.publicKey.toBuffer()],
  pg.program.programId
);

const assetA = Keypair.generate();
const assetB = Keypair.generate();

const MPL_CORE_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

console.log("playerA:", playerA.publicKey.toBase58());
console.log("playerA secretKey (base58):", base58Encode(playerA.secretKey));
console.log("playerB:", playerB.publicKey.toBase58());
console.log("playerB secretKey (base58):", base58Encode(playerB.secretKey));

// Split 50/50 : chaque joueur finance sa propre part (son NFT + son propre
// PlayerMintRecord) — les DEUX ont besoin de SOL désormais.
const transferTx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: pg.wallet.publicKey,
    toPubkey: playerA.publicKey,
    lamports: 0.05 * LAMPORTS_PER_SOL,
  }),
  SystemProgram.transfer({
    fromPubkey: pg.wallet.publicKey,
    toPubkey: playerB.publicKey,
    lamports: 0.05 * LAMPORTS_PER_SOL,
  })
);
const transferSig = await pg.program.provider.sendAndConfirm(transferTx);
console.log("playerA financé, solde:", await pg.connection.getBalance(playerA.publicKey));
console.log("playerB financé, solde:", await pg.connection.getBalance(playerB.publicKey));

// Tiers indépendants (20/09/2026) : is_premium_a et is_premium_b séparés — ici
// playerA en premium, playerB en classic, pour tester justement le cas
// "un Seeker + un non-Seeker" qui donne un avantage direct au possesseur du Seeker.
const IS_PREMIUM_A = true;
const IS_PREMIUM_B = false;

// Plus de champ `payer` séparé dans .accounts() — chacun paie sa propre part
// automatiquement via les contraintes `payer = player_a`/`payer = player_b` de lib.rs.
const tx = await pg.program.methods
  .mintMeetingNft(
    IS_PREMIUM_A,
    IS_PREMIUM_B,
    IS_PREMIUM_A ? "Sanctuaire Seeker (Premium) - test A" : "Sanctuaire Seeker - test A",
    IS_PREMIUM_A
      ? "https://kristen.fr/KristenStudiosGames/nft/sanctuaire-seeker-premium.json"
      : "https://kristen.fr/KristenStudiosGames/nft/sanctuaire-seeker-classic.json",
    IS_PREMIUM_B ? "Sanctuaire Seeker (Premium) - test B" : "Sanctuaire Seeker - test B",
    IS_PREMIUM_B
      ? "https://kristen.fr/KristenStudiosGames/nft/sanctuaire-seeker-premium.json"
      : "https://kristen.fr/KristenStudiosGames/nft/sanctuaire-seeker-classic.json"
  )
  .accounts({
    playerA: playerA.publicKey,
    playerB: playerB.publicKey,
    assetA: assetA.publicKey,
    assetB: assetB.publicKey,
    mintCounter: mintCounterPda,
    playerMintRecordA,
    playerMintRecordB,
    systemProgram: SystemProgram.programId,
    mplCoreProgram: MPL_CORE_ID,
  })
  .signers([playerA, playerB, assetA, assetB])
  .rpc({ commitment: "confirmed" });

console.log("✅ mint_meeting_nft OK, tx:", tx);
console.log("→ playerA devrait avoir un NFT PREMIUM, playerB un NFT CLASSIC.");

// Test bonus (optionnel) : relance IMMÉDIATEMENT le même mint pour playerA avec un
// NOUVEAU playerB — doit échouer avec MintCooldownActive (24h pas écoulées).
// Décommente pour tester le cooldown :
//
// const playerC = Keypair.generate();
// ... (répéter le pattern ci-dessus avec playerA + playerC) ...
// → attendu : erreur "Ce wallet doit attendre avant de pouvoir minter..."
