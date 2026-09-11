# capacitor-solana-mwa

Plugin Capacitor natif pour brancher LMS sur Mobile Wallet Adapter (Android/Seeker).

## Statut

Squelette fonctionnel, PAS testé sur device — à valider avant tout usage en hackathon.
Points à vérifier en priorité :

1. **Version exacte du SDK MWA.** L'API de `MobileWalletAdapter().transact(sender) { }`
   (noms des méthodes `authorize`/`reauthorize`/`signAndSendTransactions`/`signMessages`,
   forme des objets retournés `TransactionResult.Success.authResult` /
   `.successPayload`) a changé entre versions majeures du SDK
   `com.solanamobile:mobile-wallet-adapter-clientlib-ktx`. Le code de
   `SolanaWalletPlugin.kt` correspond au pattern de la 2.0.x — compile-le contre
   la doc/CHANGELOG à jour sur
   https://github.com/solana-mobile/mobile-wallet-adapter avant de faire confiance
   au moindre appel.
2. **`activity` dans `ActivityResultSender`** doit être une `ComponentActivity`
   (c'est le cas de la `BridgeActivity` Capacitor par défaut) — sinon caster/adapter.
3. **Encodage.** MWA échange des `ByteArray` (clé publique, transactions, signatures) ;
   ce plugin les encode en base64 pour transiter en JSON vers le JS. Côté JS, décoder
   avec `atob`/`Buffer` puis reconstruire en `Uint8Array` avant de les passer à
   `@solana/web3.js`.

## Installation dans le projet LMS (Capacitor existant)

```bash
# depuis la racine du projet LMS
npm install ../capacitor-solana-mwa   # ou publie-le en package local/tarball
npx cap sync android
```

Ajoute la dépendance Gradle dans `android/app/build.gradle` si `cap sync` ne
la propage pas automatiquement, et vérifie que `minSdkVersion >= 23` (requis
par MWA).

## Utilisation côté JS (dans le HTML monolithique LMS)

```js
import { SolanaWallet } from 'capacitor-solana-mwa';

async function connectWallet() {
  try {
    const { publicKey, authToken } = await SolanaWallet.authorize({
      cluster: 'devnet', // passe en 'mainnet-beta' seulement quand tout est validé
      identityName: 'Last Man Skating',
      identityUri: 'https://lastmanskating.app',
      iconUri: 'https://lastmanskating.app/icon.png',
    });
    localStorage.setItem('_lmsAuthToken', authToken);
    localStorage.setItem('_lmsPubKey', publicKey);
    // -> mettre à jour l'UI (afficher l'adresse tronquée, débloquer le mode "cagnotte")
  } catch (e) {
    // e.message contiendra NO_WALLET_FOUND si aucun wallet compatible n'est installé
    console.error('Wallet connect failed', e);
  }
}
```

## Ce que ce plugin NE fait PAS

- Il ne construit pas les transactions (ça reste côté JS avec `@solana/web3.js`,
  en lisant le programme Anchor).
- Il ne gère pas la persistance long-terme du `authToken` au-delà de ce que tu
  stockes toi-même côté JS/localStorage.
- Il ne valide rien côté serveur — la vérification anti-triche du score qui
  détermine le montant de la cagnotte reste à faire côté Cloud Functions Firebase,
  séparément.
