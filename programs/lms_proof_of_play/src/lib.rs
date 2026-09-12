// programs/lms_proof_of_play/src/lib.rs
//
// Squelette Anchor pour la distribution "Proof of Play" de Last Man Skating.
// Pas de mise, pas de hasard côté chaîne : ce programme distribue une cagnotte
// hebdomadaire (SPL token SKR) proportionnellement à un score déjà validé
// off-chain (Cloud Functions) et soumis par une autorité backend de confiance.
//
// IMPORTANT (règle anti-IA hackathon) : ceci est un point de départ à retaper/
// adapter toi-même dans ton repo, pas un fichier à copier tel quel dans ta
// soumission finale.
//
// Flux :
//   1. initialize_weekly_pool  -> ouvre la cagnotte de la semaine (PDA), crée
//      le vault SPL qui la détient.
//   2. fund_pool               -> optionnel, permet d'alimenter la cagnotte
//      (tips, treasury du protocole, etc.) avant/à pendant la semaine.
//   3. submit_score            -> appelé UNIQUEMENT par l'autorité backend
//      (la clé de signature de ta Cloud Function), après qu'elle a validé la
//      cohérence d'un match côté Firebase. Incrémente/écrase le score du
//      joueur pour la semaine + le total de la pool.
//   4. finalize_pool           -> l'autorité backend clôture la semaine :
//      plus aucun submit_score possible, total_score figé.
//   5. claim_scratch           -> le joueur (signataire) réclame sa part :
//      payout = total_pot * son_score / total_score. Transfert SPL direct,
//      marque claimed = true (anti double-claim).
//
// Sécurité clé : le programme ne peut PAS juger de la légitimité d'un match
// lui-même — il fait confiance à `authority` (ta Cloud Function). C'est elle
// qui porte la responsabilité anti-spoof, pas le contrat on-chain.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("GQeKyxHQGFv46z8hM5KocYa5hrUSea1hYJrDXyH41caH");

// Doit correspondre au format `weekKey` déjà utilisé côté client
// (`YYYY-Www`, ex. "2026-W37"). Longueur fixe pour rester simple en seeds.
pub const WEEK_ID_LEN: usize = 8;

// Split de la cagnotte : 75% proportionnel au score, 25% partagé également
// entre tous les joueurs ayant atteint le seuil d'éligibilité minimal.
pub const PROPORTIONAL_SHARE_PCT: u128 = 75;
pub const EQUAL_SHARE_PCT: u128 = 25;

// Seuil minimal de score pour toucher une part de l'enveloppe "équitable"
// (ex. ~3 missions complétées ou une activité compétitive minimale dans la
// semaine). À ajuster une fois la formule de score finale calée côté
// Cloud Function.
pub const EQUAL_SHARE_MIN_SCORE: u64 = 9;

#[program]
pub mod lms_proof_of_play {
    use super::*;

    pub fn initialize_weekly_pool(
        ctx: Context<InitializeWeeklyPool>,
        week_id: String,
    ) -> Result<()> {
        require!(week_id.len() <= WEEK_ID_LEN, PoolError::WeekIdTooLong);

        let pool = &mut ctx.accounts.weekly_pool;
        pool.authority = ctx.accounts.authority.key();
        pool.mint = ctx.accounts.mint.key();
        pool.vault = ctx.accounts.vault.key();
        pool.week_id = week_id;
        pool.total_score = 0;
        pool.total_pot = 0;
        pool.eligible_count = 0;
        pool.finalized = false;
        pool.bump = ctx.bumps.weekly_pool;

        Ok(())
    }

    pub fn fund_pool(ctx: Context<FundPool>, amount: u64) -> Result<()> {
        let pool = &mut ctx.accounts.weekly_pool;
        require!(!pool.finalized, PoolError::PoolAlreadyFinalized);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.funder_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
        )?;

        pool.total_pot = pool
            .total_pot
            .checked_add(amount)
            .ok_or(PoolError::MathOverflow)?;

        Ok(())
    }

    // Appelé par l'autorité backend (Cloud Function) après validation d'un
    // match. `new_score` est le score CUMULÉ du joueur pour la semaine
    // (pas un delta) — plus simple à raisonner côté client Cloud Function :
    // elle recalcule le total et l'écrase.
    pub fn submit_score(
        ctx: Context<SubmitScore>,
        _week_id: String,
        new_score: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.weekly_pool;
        require!(!pool.finalized, PoolError::PoolAlreadyFinalized);
        require_keys_eq!(
            ctx.accounts.authority.key(),
            pool.authority,
            PoolError::UnauthorizedAuthority
        );

        let player_score = &mut ctx.accounts.player_score;
        let previous = player_score.score;

        // Ajuste le total de la pool par le delta (score écrasé, pas cumulé
        // en plus de l'ancien).
        if new_score >= previous {
            pool.total_score = pool
                .total_score
                .checked_add(new_score - previous)
                .ok_or(PoolError::MathOverflow)?;
        } else {
            pool.total_score = pool
                .total_score
                .checked_sub(previous - new_score)
                .ok_or(PoolError::MathOverflow)?;
        }

        // Bascule dans/hors de l'enveloppe "équitable" selon le seuil.
        let was_eligible = player_score.eligible;
        let is_eligible = new_score >= EQUAL_SHARE_MIN_SCORE;
        if is_eligible && !was_eligible {
            pool.eligible_count = pool
                .eligible_count
                .checked_add(1)
                .ok_or(PoolError::MathOverflow)?;
        } else if !is_eligible && was_eligible {
            pool.eligible_count = pool
                .eligible_count
                .checked_sub(1)
                .ok_or(PoolError::MathOverflow)?;
        }

        player_score.player = ctx.accounts.player.key();
        player_score.week_id = pool.week_id.clone();
        player_score.score = new_score;
        player_score.eligible = is_eligible;
        player_score.claimed = false;
        player_score.bump = ctx.bumps.player_score;

        Ok(())
    }

    pub fn finalize_pool(ctx: Context<FinalizePool>, _week_id: String) -> Result<()> {
        let pool = &mut ctx.accounts.weekly_pool;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            pool.authority,
            PoolError::UnauthorizedAuthority
        );
        require!(!pool.finalized, PoolError::PoolAlreadyFinalized);

        pool.finalized = true;
        Ok(())
    }

    pub fn claim_scratch(ctx: Context<ClaimScratch>, _week_id: String) -> Result<()> {
        let pool = &ctx.accounts.weekly_pool;
        let player_score = &mut ctx.accounts.player_score;

        require!(pool.finalized, PoolError::PoolNotFinalized);
        require!(!player_score.claimed, PoolError::AlreadyClaimed);
        require!(pool.total_score > 0, PoolError::EmptyPool);
        require_keys_eq!(
            player_score.player,
            ctx.accounts.player.key(),
            PoolError::UnauthorizedClaimant
        );

        // Split 75/25 : enveloppe proportionnelle au score + enveloppe
        // équitable partagée entre tous les joueurs éligibles. Le calcul se
        // fait en u128 pour éviter l'overflow sur les multiplications
        // intermédiaires ; le reliquat d'arrondi de la part équitable reste
        // dans le vault (pas de perte de fonds, juste de la poussière non
        // réclamée qui pourra être recyclée par l'autorité sur une future
        // semaine si besoin).
        let total_pot = pool.total_pot as u128;
        let proportional_pot = total_pot
            .checked_mul(PROPORTIONAL_SHARE_PCT)
            .ok_or(PoolError::MathOverflow)?
            .checked_div(100)
            .ok_or(PoolError::MathOverflow)?;
        let equal_pot = total_pot
            .checked_mul(EQUAL_SHARE_PCT)
            .ok_or(PoolError::MathOverflow)?
            .checked_div(100)
            .ok_or(PoolError::MathOverflow)?;

        let proportional_share = proportional_pot
            .checked_mul(player_score.score as u128)
            .ok_or(PoolError::MathOverflow)?
            .checked_div(pool.total_score as u128)
            .ok_or(PoolError::MathOverflow)?;

        let equal_share: u128 = if player_score.eligible {
            require!(pool.eligible_count > 0, PoolError::EmptyPool);
            equal_pot
                .checked_div(pool.eligible_count as u128)
                .ok_or(PoolError::MathOverflow)?
        } else {
            0
        };

        let payout: u64 = proportional_share
            .checked_add(equal_share)
            .ok_or(PoolError::MathOverflow)?
            .try_into()
            .map_err(|_| PoolError::MathOverflow)?;

        require!(payout > 0, PoolError::PayoutTooSmall);

        let week_id_bytes = pool.week_id.as_bytes();
        let seeds: &[&[u8]] = &[b"pool", week_id_bytes, &[pool.bump]];
        let signer_seeds = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.player_token_account.to_account_info(),
                    authority: ctx.accounts.weekly_pool.to_account_info(),
                },
                signer_seeds,
            ),
            payout,
        )?;

        player_score.claimed = true;
        Ok(())
    }
}

// ---------------------------------------------------------------------
// Comptes d'état
// ---------------------------------------------------------------------

#[account]
pub struct WeeklyPool {
    pub authority: Pubkey,   // clé publique de la Cloud Function backend
    pub mint: Pubkey,        // mint SPL du token SKR (ou équivalent)
    pub vault: Pubkey,       // token account PDA détenant la cagnotte
    pub week_id: String,     // "2026-W37", doit matcher le weekKey client
    pub total_score: u64,    // somme des scores de tous les joueurs soumis
    pub total_pot: u64,      // montant total déposé dans le vault
    pub eligible_count: u64, // nb de joueurs au-dessus du seuil équitable
    pub finalized: bool,     // true = plus de submit_score, claim ouvert
    pub bump: u8,
}

impl WeeklyPool {
    // discriminator(8) + pubkey*3(96) + string(4+8) + u64*3(24) + bool(1) + bump(1)
    pub const MAX_SIZE: usize = 8 + 32 * 3 + 4 + WEEK_ID_LEN + 8 * 3 + 1 + 1;
}

#[account]
pub struct PlayerScore {
    pub player: Pubkey,
    pub week_id: String,
    pub score: u64,
    pub eligible: bool,   // au-dessus du seuil EQUAL_SHARE_MIN_SCORE
    pub claimed: bool,
    pub bump: u8,
}

impl PlayerScore {
    pub const MAX_SIZE: usize = 8 + 32 + 4 + WEEK_ID_LEN + 8 + 1 + 1 + 1;
}

// ---------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(week_id: String)]
pub struct InitializeWeeklyPool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = WeeklyPool::MAX_SIZE,
        seeds = [b"pool", week_id.as_bytes()],
        bump
    )]
    pub weekly_pool: Account<'info, WeeklyPool>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = mint,
        token::authority = weekly_pool,
        seeds = [b"vault", week_id.as_bytes()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundPool<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(mut)]
    pub funder_token_account: Account<'info, TokenAccount>,

    #[account(mut, seeds = [b"pool", weekly_pool.week_id.as_bytes()], bump = weekly_pool.bump)]
    pub weekly_pool: Account<'info, WeeklyPool>,

    #[account(mut, address = weekly_pool.vault)]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(week_id: String)]
pub struct SubmitScore<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: pubkey du joueur, pas besoin de signature — c'est le backend
    /// qui soumet en son nom après validation off-chain du match.
    pub player: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"pool", week_id.as_bytes()], bump = weekly_pool.bump)]
    pub weekly_pool: Account<'info, WeeklyPool>,

    #[account(
        init_if_needed,
        payer = authority,
        space = PlayerScore::MAX_SIZE,
        seeds = [b"player_score", week_id.as_bytes(), player.key().as_ref()],
        bump
    )]
    pub player_score: Account<'info, PlayerScore>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(week_id: String)]
pub struct FinalizePool<'info> {
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"pool", week_id.as_bytes()], bump = weekly_pool.bump)]
    pub weekly_pool: Account<'info, WeeklyPool>,
}

#[derive(Accounts)]
#[instruction(week_id: String)]
pub struct ClaimScratch<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(seeds = [b"pool", week_id.as_bytes()], bump = weekly_pool.bump)]
    pub weekly_pool: Account<'info, WeeklyPool>,

    #[account(
        mut,
        seeds = [b"player_score", week_id.as_bytes(), player.key().as_ref()],
        bump = player_score.bump
    )]
    pub player_score: Account<'info, PlayerScore>,

    #[account(mut, address = weekly_pool.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub player_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------

#[error_code]
pub enum PoolError {
    #[msg("week_id dépasse la longueur max prévue pour les seeds")]
    WeekIdTooLong,
    #[msg("Cette pool hebdomadaire est déjà finalisée")]
    PoolAlreadyFinalized,
    #[msg("Cette pool hebdomadaire n'est pas encore finalisée")]
    PoolNotFinalized,
    #[msg("Seule l'autorité backend peut effectuer cette action")]
    UnauthorizedAuthority,
    #[msg("Ce compte de score n'appartient pas au joueur signataire")]
    UnauthorizedClaimant,
    #[msg("Ce score a déjà été réclamé")]
    AlreadyClaimed,
    #[msg("Aucun score enregistré dans cette pool")]
    EmptyPool,
    #[msg("Le montant à réclamer est nul après calcul")]
    PayoutTooSmall,
    #[msg("Overflow arithmétique")]
    MathOverflow,
}
