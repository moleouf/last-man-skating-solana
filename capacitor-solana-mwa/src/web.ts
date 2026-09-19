import { WebPlugin } from '@capacitor/core';
import type {
  SolanaWalletPlugin,
  AuthorizeOptions,
  AuthorizeResult,
  ReauthorizeOptions,
  DeauthorizeOptions,
  SignAndSendTransactionsOptions,
  SignAndSendTransactionsResult,
  SignTransactionsOptions,
  SignTransactionsResult,
  SignMessagesOptions,
  SignMessagesResult,
} from './definitions';

/**
 * Mobile Wallet Adapter est un protocole Android natif (intent inter-app).
 * Il n'existe pas d'équivalent web : sur navigateur/desktop, ce plugin refuse
 * explicitement plutôt que de faire semblant de fonctionner.
 * Pour tester en dehors d'un device Android, mock ce plugin dans tes tests JS.
 */
export class SolanaWalletWeb extends WebPlugin implements SolanaWalletPlugin {
  async authorize(_options: AuthorizeOptions): Promise<AuthorizeResult> {
    throw this.unavailable('Mobile Wallet Adapter n\'est disponible que sur Android.');
  }

  async reauthorize(_options: ReauthorizeOptions): Promise<AuthorizeResult> {
    throw this.unavailable('Mobile Wallet Adapter n\'est disponible que sur Android.');
  }

  async deauthorize(_options: DeauthorizeOptions): Promise<void> {
    throw this.unavailable('Mobile Wallet Adapter n\'est disponible que sur Android.');
  }

  async signAndSendTransactions(
    _options: SignAndSendTransactionsOptions
  ): Promise<SignAndSendTransactionsResult> {
    throw this.unavailable('Mobile Wallet Adapter n\'est disponible que sur Android.');
  }

  async signTransactions(_options: SignTransactionsOptions): Promise<SignTransactionsResult> {
    throw this.unavailable('Mobile Wallet Adapter n\'est disponible que sur Android.');
  }

  async signMessages(_options: SignMessagesOptions): Promise<SignMessagesResult> {
    throw this.unavailable('Mobile Wallet Adapter n\'est disponible que sur Android.');
  }
}
