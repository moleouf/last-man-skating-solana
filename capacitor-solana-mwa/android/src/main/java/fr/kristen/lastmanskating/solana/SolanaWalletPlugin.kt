package fr.kristen.lastmanskating.solana

import android.net.Uri
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.solana.mobilewalletadapter.clientlib.ConnectionIdentity
import com.solana.mobilewalletadapter.clientlib.MobileWalletAdapter
import com.solana.mobilewalletadapter.clientlib.RpcCluster
import com.solana.mobilewalletadapter.clientlib.TransactionParams
import com.solana.mobilewalletadapter.clientlib.TransactionResult
import com.solana.mobilewalletadapter.clientlib.successPayload
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Wrapper Capacitor autour de com.solanamobile:mobile-wallet-adapter-clientlib-ktx.
 *
 * IMPORTANT : l'API exacte de MobileWalletAdapter.transact { } a changé plusieurs fois
 * entre les versions 1.x et 2.x du SDK. Le code ci-dessous correspond au pattern de la
 * 2.0.x (transact suspendu avec authorize/signAndSendTransactions/deauthorize appelés
 * DANS le lambda). Avant de builder : vérifie le CHANGELOG et les exemples à jour sur
 * https://github.com/solana-mobile/mobile-wallet-adapter/tree/main/android — pin une
 * version précise dans build.gradle et ajuste les noms de méthode si besoin.
 */
@CapacitorPlugin(name = "SolanaWallet")
class SolanaWalletPlugin : Plugin() {

    private var authToken: String? = null
    private val pluginScope = CoroutineScope(Dispatchers.Main)

    // IMPORTANT : ActivityResultSender s'appuie sur registerForActivityResult(),
    // qui DOIT être enregistré avant que l'Activity n'atteigne l'état STARTED.
    // Le créer à la demande (dans authorize()/etc., déclenché par un tap utilisateur
    // bien après le démarrage) provoque un crash IllegalStateException — c'est ce
    // qui causait le plantage au clic sur "Connecter mon wallet". On le crée une
    // seule fois ici, dans load(), appelé tôt par Capacitor pendant l'init de l'activité.
    private lateinit var sender: ActivityResultSender

    override fun load() {
        sender = ActivityResultSender(activity)
    }

    private fun clusterFromString(name: String?): RpcCluster = when (name) {
        "mainnet-beta" -> RpcCluster.MainnetBeta
        "testnet" -> RpcCluster.Testnet
        else -> RpcCluster.Devnet
    }

    private fun buildAdapter(call: PluginCall): MobileWalletAdapter {
        val identityName = call.getString("identityName") ?: "Last Man Skating"
        val identityUri = Uri.parse(call.getString("identityUri") ?: "https://lastmanskating.app")
        val iconUri = Uri.parse(call.getString("iconUri") ?: "favicon.ico")
        return MobileWalletAdapter(
            connectionIdentity = ConnectionIdentity(
                identityUri = identityUri,
                iconUri = iconUri,
                identityName = identityName
            )
        )
    }

    @PluginMethod
    fun authorize(call: PluginCall) {
        val adapter = buildAdapter(call)
        val cluster = clusterFromString(call.getString("cluster"))

        pluginScope.launch {
            val result = adapter.transact(sender) {
                authorize(
                    identityUri = Uri.parse(call.getString("identityUri") ?: "https://lastmanskating.app"),
                    iconUri = Uri.parse(call.getString("iconUri") ?: "favicon.ico"),
                    identityName = call.getString("identityName") ?: "Last Man Skating",
                    rpcCluster = cluster
                )
            }

            when (result) {
                is TransactionResult.Success -> {
                    val authResult = result.authResult
                    authToken = authResult.authToken
                    val ret = JSObject()
                    ret.put("publicKey", Base64.encodeToString(authResult.publicKey, Base64.NO_WRAP))
                    ret.put("authToken", authResult.authToken)
                    authResult.accountLabel?.let { ret.put("accountLabel", it) }
                    call.resolve(ret)
                }
                is TransactionResult.NoWalletFound -> {
                    call.reject("NO_WALLET_FOUND: aucune app wallet compatible MWA détectée sur ce device")
                }
                is TransactionResult.Failure -> {
                    call.reject("AUTHORIZE_FAILED: ${result.e.message}", result.e)
                }
            }
        }
    }

    @PluginMethod
    fun reauthorize(call: PluginCall) {
        val token = call.getString("authToken")
        if (token == null) {
            call.reject("MISSING_AUTH_TOKEN")
            return
        }
        val adapter = buildAdapter(call)
        val cluster = clusterFromString(call.getString("cluster"))

        pluginScope.launch {
            val result = adapter.transact(sender) {
                reauthorize(
                    identityUri = Uri.parse(call.getString("identityUri") ?: "https://lastmanskating.app"),
                    iconUri = Uri.parse(call.getString("iconUri") ?: "favicon.ico"),
                    identityName = call.getString("identityName") ?: "Last Man Skating",
                    authToken = token
                )
            }

            when (result) {
                is TransactionResult.Success -> {
                    val authResult = result.authResult
                    authToken = authResult.authToken
                    val ret = JSObject()
                    ret.put("publicKey", Base64.encodeToString(authResult.publicKey, Base64.NO_WRAP))
                    ret.put("authToken", authResult.authToken)
                    call.resolve(ret)
                }
                is TransactionResult.NoWalletFound -> call.reject("NO_WALLET_FOUND")
                is TransactionResult.Failure -> call.reject("REAUTHORIZE_FAILED: ${result.e.message}", result.e)
            }
        }
    }

    @PluginMethod
    fun deauthorize(call: PluginCall) {
        val token = call.getString("authToken") ?: authToken
        if (token == null) {
            call.resolve() // rien à faire
            return
        }
        val adapter = buildAdapter(call)

        pluginScope.launch {
            adapter.transact(sender) {
                deauthorize(authToken = token)
            }
            authToken = null
            call.resolve()
        }
    }

    @PluginMethod
    fun signAndSendTransactions(call: PluginCall) {
        val token = call.getString("authToken")
        val txArray: JSArray = call.getArray("transactions") ?: JSArray()
        if (token == null || txArray.length() == 0) {
            call.reject("MISSING_PARAMS: authToken et transactions sont requis")
            return
        }

        val transactionsBytes = Array(txArray.length()) { i ->
            Base64.decode(txArray.getString(i), Base64.DEFAULT)
        }

        val adapter = buildAdapter(call)

        pluginScope.launch {
            val result = adapter.transact(sender) {
                reauthorize(
                    identityUri = Uri.parse(call.getString("identityUri") ?: "https://lastmanskating.app"),
                    iconUri = Uri.parse(call.getString("iconUri") ?: "favicon.ico"),
                    identityName = call.getString("identityName") ?: "Last Man Skating",
                    authToken = token
                )
                signAndSendTransactions(
                    transactions = transactionsBytes,
                    params = TransactionParams(
                        minContextSlot = 0,
                        commitment = null,
                        skipPreflight = null,
                        maxRetries = null,
                        waitForCommitmentToSendNextTransaction = null
                    )
                )
            }

            when (result) {
                is TransactionResult.Success -> {
                    val sigs = result.successPayload
                    val jsArray = JSArray()
                    sigs?.signatures?.forEach { sig ->
                        jsArray.put(Base64.encodeToString(sig, Base64.NO_WRAP))
                    }
                    val ret = JSObject()
                    ret.put("signatures", jsArray)
                    call.resolve(ret)
                }
                is TransactionResult.NoWalletFound -> call.reject("NO_WALLET_FOUND")
                is TransactionResult.Failure -> call.reject("SIGN_AND_SEND_FAILED: ${result.e.message}", result.e)
            }
        }
    }

    @PluginMethod
    fun signMessages(call: PluginCall) {
        val token = call.getString("authToken")
        val addresses: JSArray = call.getArray("addresses") ?: JSArray()
        val payloads: JSArray = call.getArray("payloads") ?: JSArray()
        if (token == null || addresses.length() == 0 || payloads.length() == 0) {
            call.reject("MISSING_PARAMS")
            return
        }

        val addressBytes = Array(addresses.length()) { i -> Base64.decode(addresses.getString(i), Base64.DEFAULT) }
        val payloadBytes = Array(payloads.length()) { i -> Base64.decode(payloads.getString(i), Base64.DEFAULT) }

        val adapter = buildAdapter(call)

        pluginScope.launch {
            val result = adapter.transact(sender) {
                reauthorize(
                    identityUri = Uri.parse(call.getString("identityUri") ?: "https://lastmanskating.app"),
                    iconUri = Uri.parse(call.getString("iconUri") ?: "favicon.ico"),
                    identityName = call.getString("identityName") ?: "Last Man Skating",
                    authToken = token
                )
                signMessagesDetached(messages = payloadBytes, addresses = addressBytes)
            }

            when (result) {
                is TransactionResult.Success -> {
                    val signed = result.successPayload
                    val jsArray = JSArray()
                    signed?.messages?.forEach { signedMsg ->
                        signedMsg.signatures.forEach { sig ->
                            jsArray.put(Base64.encodeToString(sig, Base64.NO_WRAP))
                        }
                    }
                    val ret = JSObject()
                    ret.put("signedMessages", jsArray)
                    call.resolve(ret)
                }
                is TransactionResult.NoWalletFound -> call.reject("NO_WALLET_FOUND")
                is TransactionResult.Failure -> call.reject("SIGN_MESSAGES_FAILED: ${result.e.message}", result.e)
            }
        }
    }
}
