import { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";

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
console.log("playerB:", playerB.publicKey.toBase58());

const transferTx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: pg.wallet.publicKey,
    toPubkey: playerA.publicKey,
    lamports: 0.05 * LAMPORTS_PER_SOL,
  })
);
const transferSig = await pg.program.provider.sendAndConfirm(transferTx);
console.log("playerA financé, solde:", await pg.connection.getBalance(playerA.publicKey));

const tx = await pg.program.methods
  .mintMeetingNft(
    false,
    "Sanctuaire Seeker (test A)",
    "https://kristen.fr/lms/sanctuaire-seeker-classic.json",
    "Sanctuaire Seeker (test B)",
    "https://kristen.fr/lms/sanctuaire-seeker-classic.json"
  )
  .accounts({
    playerA: playerA.publicKey,
    playerB: playerB.publicKey,
    payer: playerA.publicKey,
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