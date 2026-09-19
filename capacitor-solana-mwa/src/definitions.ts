export type LmsCluster = 'mainnet-beta' | 'devnet' | 'testnet';

export interface AuthorizeOptions {
  cluster?: LmsCluster;
  identityName?: string;
  identityUri?: string;
  iconUri?: string;
}

export interface AuthorizeResult {
  publicKey: string; // base58
  authToken: string;
  accountLabel?: string;
}

export interface ReauthorizeOptions {
  authToken: string;
  cluster?: LmsCluster;
}

export interface DeauthorizeOptions {
  authToken: string;
}

export interface SignAndSendTransactionsOptions {
  authToken: string;
  /** transactions sérialisées en base64 (VersionedTransaction ou legacy Transaction non signée) */
  transactions: string[];
  cluster?: LmsCluster;
}

export interface SignAndSendTransactionsResult {
  /** signatures de transaction (base58), une par transaction envoyée */
  signatures: string[];
}

export interface SignTransactionsOptions {
  authToken: string;
  /** transactions sérialisées en base64 (déjà partiellement signées ou non) */
  transactions: string[];
  cluster?: LmsCluster;
}

export interface SignTransactionsResult {
  /** transactions signées, sérialisées en base64, dans le même ordre que l'entrée */
  signedTransactions: string[];
}

export interface SignMessagesOptions {
  authToken: string;
  /** adresse(s) publique(s) devant signer, base58 */
  addresses: string[];
  /** message(s) à signer, base64 */
  payloads: string[];
}

export interface SignMessagesResult {
  signedMessages: string[]; // base64
}

export interface SolanaWalletPlugin {
  /**
   * Ouvre le sélecteur de wallet natif (Seed Vault / Phantom / Solflare...) via Mobile Wallet Adapter.
   * Doit être appelé depuis un geste utilisateur (clic bouton), pas au chargement de la page.
   */
  authorize(options: AuthorizeOptions): Promise<AuthorizeResult>;

  /** Ré-autorise une session existante sans relancer le sélecteur, si le token est encore valide. */
  reauthorize(options: ReauthorizeOptions): Promise<AuthorizeResult>;

  /** Termine la session wallet. */
  deauthorize(options: DeauthorizeOptions): Promise<void>;

  /** Fait signer puis envoie une ou plusieurs transactions déjà construites côté JS (web3.js). */
  signAndSendTransactions(
    options: SignAndSendTransactionsOptions
  ): Promise<SignAndSendTransactionsResult>;

  /**
   * Fait signer une ou plusieurs transactions SANS les envoyer au réseau.
   * Nécessaire pour un scénario multi-signataires (ex: mint co-signé du mode Proximité) —
   * marqué "deprecated" côté spec MWA 2.0 au profit de signAndSendTransactions, mais c'est
   * la seule méthode qui permette de signer sans soumettre.
   */
  signTransactions(options: SignTransactionsOptions): Promise<SignTransactionsResult>;

  /** Fait signer un ou plusieurs messages arbitraires (ex: preuve de possession de la clé). */
  signMessages(options: SignMessagesOptions): Promise<SignMessagesResult>;
}
