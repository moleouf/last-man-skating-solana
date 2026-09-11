import { registerPlugin } from '@capacitor/core';
import type { SolanaWalletPlugin } from './definitions';

const SolanaWallet = registerPlugin<SolanaWalletPlugin>('SolanaWallet', {
  web: () => import('./web').then((m) => new m.SolanaWalletWeb()),
});

export * from './definitions';
export { SolanaWallet };
