package fr.kristen.lastmanskating.solana

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PermissionState
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy

/**
 * Détection de proximité IRL (mode "RADAR") via Google Nearby Connections
 * (BLE + WiFi + ultrasons, Play Services — PAS le NFC, présence non confirmée sur
 * Seeker dans les specs officielles). Volontairement séparé de SolanaWalletPlugin :
 * ce plugin ne fait QUE la détection/connexion P2P + l'échange d'un petit payload
 * texte (uid + pseudo) une fois connecté. Côté JS, ce payload sert à déclencher
 * l'invite Duel existante (_lmsInviteSend) — aucun nouveau netcode de jeu ici.
 *
 * Stratégie P2P_CLUSTER : chaque device advertise ET discover en même temps. La
 * symétrie est voulue côté DÉTECTION, mais surtout pas côté requestConnection : le
 * tie-break (uid le plus petit initie) est fait côté JS (_lmsNearbyMaybeAutoConnect).
 *
 * v2193 — corrections après tests sur device :
 *  1. doStart() est idempotent : il coupe systématiquement advertising/discovery/
 *     endpoints avant de redémarrer, et traite 8001 STATUS_ALREADY_ADVERTISING /
 *     8002 STATUS_ALREADY_DISCOVERING comme un SUCCÈS (l'état voulu est atteint)
 *     au lieu d'afficher une erreur rouge au joueur.
 *  2. Permissions séparées en deux alias : NEARBY_WIFI_DEVICES n'existe qu'à partir
 *     d'Android 13 (API 33). Sur un device plus ancien, checkSelfPermission() sur une
 *     permission inconnue du système renvoie DENIED pour toujours → le dialogue ne
 *     s'affichait jamais et start() se rejetait en boucle (« rien ne se passe »). On
 *     ne demande cet alias que si SDK_INT >= 33.
 *  3. connectTo() tolère 8003 STATUS_ALREADY_CONNECTED_TO_ENDPOINT (collision quand les
 *     deux joueurs tapent CONNECT en même temps) : on résout, la connexion existe déjà.
 *     Un même endpointId ne peut pas partir deux fois en requestConnection (pendingOutgoing).
 *  4. Toutes les erreurs portent le statusCode numérique, et un événement "scanState"
 *     dit à l'UI si on advertise/discover RÉELLEMENT (le bouton ARRÊTER mentait quand
 *     startAdvertising avait échoué en silence).
 */
@CapacitorPlugin(
    name = "LmsNearby",
    permissions = [
        Permission(
            alias = "nearby",
            strings = [
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.ACCESS_FINE_LOCATION
            ]
        ),
        // Alias séparé : demandé UNIQUEMENT sur API 33+ (voir missingAliases()).
        Permission(
            alias = "nearbyWifi",
            strings = [Manifest.permission.NEARBY_WIFI_DEVICES]
        )
    ]
)
class NearbyProximityPlugin : Plugin() {

    // Doit matcher côté advertising ET discovery — sinon les deux devices ne se
    // "voient" jamais malgré un Bluetooth/WiFi fonctionnel des deux côtés.
    private val serviceId = "fr.kristen.lastmanskating.PROXIMITY"

    private val connectionsClient by lazy { Nearby.getConnectionsClient(context) }

    private var connectedEndpointId: String? = null
    private var localPayload: String? = null
    private var pendingStartMode: String = "both"

    // État réel côté natif (≠ état supposé côté JS).
    private var advertising = false
    private var discovering = false

    // endpointIds pour lesquels un requestConnection est déjà parti : évite le double
    // requestConnection (double tap sur CONNECT, ou tap manuel + auto-connect JS).
    private val pendingOutgoing = HashSet<String>()

    private fun statusCodeOf(e: Exception): Int = (e as? ApiException)?.statusCode ?: -1

    private fun errorEvent(phase: String, e: Exception) {
        notifyListeners(
            "nearbyError",
            JSObject()
                .put("phase", phase)
                .put("statusCode", statusCodeOf(e))
                .put("message", e.message ?: e.javaClass.simpleName)
        )
    }

    private fun emitScanState() {
        notifyListeners(
            "scanState",
            JSObject().put("advertising", advertising).put("discovering", discovering)
        )
    }

    @PluginMethod
    fun setLocalPayload(call: PluginCall) {
        localPayload = call.getString("value")
        call.resolve()
    }

    // Alias de permission réellement nécessaires sur CE device.
    private fun missingAliases(): Array<String> {
        val list = ArrayList<String>(2)
        if (getPermissionState("nearby") != PermissionState.GRANTED) list.add("nearby")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getPermissionState("nearbyWifi") != PermissionState.GRANTED
        ) list.add("nearbyWifi")
        return list.toTypedArray()
    }

    @PluginMethod
    fun start(call: PluginCall) {
        pendingStartMode = call.getString("mode") ?: "both"
        val missing = missingAliases()
        if (missing.isNotEmpty()) {
            requestPermissionForAliases(missing, call, "permissionCallback")
            return
        }
        doStart(call)
    }

    @PermissionCallback
    private fun permissionCallback(call: PluginCall) {
        val still = missingAliases()
        if (still.isNotEmpty()) {
            call.reject("PERMISSION_DENIED: alias refusés = ${still.joinToString(",")}")
            return
        }
        doStart(call)
    }

    /**
     * Remet Nearby à zéro. Ces méthodes sont idempotentes côté Play Services (aucune
     * exception si rien n'est en cours) : c'est le seul moyen fiable de ne pas retomber
     * sur 8001/8002 quand le joueur re-tape sur RADAR avant que l'arrêt précédent ait
     * été digéré côté natif.
     */
    private fun hardReset() {
        try { connectionsClient.stopAdvertising() } catch (_: Exception) {}
        try { connectionsClient.stopDiscovery() } catch (_: Exception) {}
        try { connectionsClient.stopAllEndpoints() } catch (_: Exception) {}
        advertising = false
        discovering = false
        connectedEndpointId = null
        pendingOutgoing.clear()
    }

    private fun doStart(call: PluginCall) {
        val displayName = call.getString("displayName") ?: "Joueur"
        hardReset()

        if (pendingStartMode == "both" || pendingStartMode == "advertise") {
            try {
                val advertisingOptions =
                    AdvertisingOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build()
                connectionsClient.startAdvertising(
                    displayName, serviceId, connectionLifecycleCallback, advertisingOptions
                ).addOnSuccessListener {
                    advertising = true
                    emitScanState()
                }.addOnFailureListener { e ->
                    if (statusCodeOf(e) == ConnectionsStatusCodes.STATUS_ALREADY_ADVERTISING) {
                        advertising = true
                        emitScanState()
                    } else {
                        errorEvent("advertise", e)
                    }
                }
            } catch (e: Exception) {
                errorEvent("advertise", e)
            }
        }

        if (pendingStartMode == "both" || pendingStartMode == "discover") {
            try {
                val discoveryOptions =
                    DiscoveryOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build()
                connectionsClient.startDiscovery(
                    serviceId, endpointDiscoveryCallback, discoveryOptions
                ).addOnSuccessListener {
                    discovering = true
                    emitScanState()
                }.addOnFailureListener { e ->
                    if (statusCodeOf(e) == ConnectionsStatusCodes.STATUS_ALREADY_DISCOVERING) {
                        discovering = true
                        emitScanState()
                    } else {
                        errorEvent("discover", e)
                    }
                }
            } catch (e: Exception) {
                errorEvent("discover", e)
            }
        }
        call.resolve()
    }

    @PluginMethod
    fun connectTo(call: PluginCall) {
        val endpointId = call.getString("endpointId")
        if (endpointId == null) {
            call.reject("MISSING_ENDPOINT_ID")
            return
        }
        if (endpointId == connectedEndpointId) {
            call.resolve() // déjà connecté à ce pair
            return
        }
        if (!pendingOutgoing.add(endpointId)) {
            call.resolve() // requête déjà en vol, ne pas spammer Nearby
            return
        }
        val displayName = call.getString("displayName") ?: "Joueur"
        // requestConnection() peut échouer en asynchrone (addOnFailureListener) OU lever une
        // SecurityException SYNCHRONE si BLUETOOTH_CONNECT n'est pas réellement accordé côté
        // OS — sans ce try/catch la Promise JS restait bloquée pour toujours, d'où
        // l'impression que « rien ne se passe » au clic.
        try {
            connectionsClient.requestConnection(displayName, endpointId, connectionLifecycleCallback)
                .addOnSuccessListener { call.resolve() }
                .addOnFailureListener { e ->
                    pendingOutgoing.remove(endpointId)
                    if (statusCodeOf(e) == ConnectionsStatusCodes.STATUS_ALREADY_CONNECTED_TO_ENDPOINT) {
                        call.resolve() // les deux côtés ont demandé en même temps : OK
                    } else {
                        call.reject("CONNECT_REQUEST_FAILED(${statusCodeOf(e)}): ${e.message}", e)
                    }
                }
        } catch (e: Exception) {
            pendingOutgoing.remove(endpointId)
            call.reject("CONNECT_REQUEST_THREW: ${e.javaClass.simpleName}: ${e.message}", e)
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        hardReset()
        emitScanState()
        call.resolve()
    }

    /**
     * Le mode RADAR a-t-il une chance de fonctionner sur CE device ?
     * Appelé par le JS à l'ouverture du hub pour afficher ou masquer l'onglet : mieux vaut
     * pas d'onglet du tout qu'un onglet qui échoue systématiquement.
     *  - Android TV / box leanback : pas de BLE utilisable, et le scénario « deux joueurs
     *    côte à côte avec leur téléphone » n'a aucun sens sur un téléviseur.
     *  - Pas de Bluetooth LE : Nearby Connections ne peut pas faire sa découverte.
     *  - Sous Android 12 (API 31) : le modèle de permissions Bluetooth runtime n'existe pas
     *    encore, il faut retomber sur BLUETOOTH/BLUETOOTH_ADMIN + localisation activée. Jamais
     *    testé ici, donc volontairement hors périmètre — change MIN_SDK ci-dessous si tu veux
     *    l'ouvrir plus largement après test.
     */
    @PluginMethod
    fun isSupported(call: PluginCall) {
        val pm = context.packageManager
        val isTv = pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
            pm.hasSystemFeature("android.hardware.type.television")
        val hasBle = pm.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)
        val sdkOk = Build.VERSION.SDK_INT >= MIN_SDK

        val reason = when {
            isTv -> "TV"
            !hasBle -> "NO_BLE"
            !sdkOk -> "SDK_TOO_OLD"
            else -> ""
        }

        call.resolve(
            JSObject()
                .put("supported", reason.isEmpty())
                .put("reason", reason)
                .put("sdkInt", Build.VERSION.SDK_INT)
                .put("isTv", isTv)
                .put("hasBle", hasBle)
        )
    }

    /** État réel côté natif — le JS s'en sert pour ne pas afficher « Recherche en cours » à tort. */
    @PluginMethod
    fun getState(call: PluginCall) {
        call.resolve(
            JSObject()
                .put("advertising", advertising)
                .put("discovering", discovering)
                .put("connectedEndpointId", connectedEndpointId)
        )
    }

    private val endpointDiscoveryCallback = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            if (info.serviceId != serviceId) return
            val ret = JSObject()
            ret.put("endpointId", endpointId)
            ret.put("displayName", info.endpointName)
            notifyListeners("endpointFound", ret)
        }

        override fun onEndpointLost(endpointId: String) {
            pendingOutgoing.remove(endpointId)
            notifyListeners("endpointLost", JSObject().put("endpointId", endpointId))
        }
    }

    private val connectionLifecycleCallback = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            // Auto-accept des deux côtés : pas d'étape « code à 4 chiffres à confirmer ».
            try {
                connectionsClient.acceptConnection(endpointId, payloadCallback)
            } catch (e: Exception) {
                errorEvent("accept", e)
                return
            }
            val ret = JSObject()
            ret.put("endpointId", endpointId)
            ret.put("displayName", info.endpointName)
            ret.put("incoming", !pendingOutgoing.contains(endpointId))
            notifyListeners("connectionInitiated", ret)
        }

        override fun onConnectionResult(endpointId: String, resolution: ConnectionResolution) {
            pendingOutgoing.remove(endpointId)
            val code = resolution.status.statusCode
            val ret = JSObject()
            ret.put("endpointId", endpointId)
            ret.put("statusCode", code)
            if (code == ConnectionsStatusCodes.STATUS_OK ||
                code == ConnectionsStatusCodes.STATUS_ALREADY_CONNECTED_TO_ENDPOINT
            ) {
                connectedEndpointId = endpointId
                // On coupe la recherche une fois la paire formée.
                try { connectionsClient.stopAdvertising() } catch (_: Exception) {}
                try { connectionsClient.stopDiscovery() } catch (_: Exception) {}
                advertising = false
                discovering = false
                emitScanState()
                ret.put("success", true)
                localPayload?.let { payload ->
                    try {
                        connectionsClient.sendPayload(
                            endpointId, Payload.fromBytes(payload.toByteArray(Charsets.UTF_8))
                        )
                    } catch (e: Exception) {
                        errorEvent("sendPayload", e)
                    }
                }
            } else {
                ret.put("success", false)
            }
            notifyListeners("connectionResult", ret)
        }

        override fun onDisconnected(endpointId: String) {
            pendingOutgoing.remove(endpointId)
            if (connectedEndpointId == endpointId) connectedEndpointId = null
            notifyListeners("disconnected", JSObject().put("endpointId", endpointId))
        }
    }

    private val payloadCallback = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            if (payload.type != Payload.Type.BYTES) return
            val bytes = payload.asBytes() ?: return
            val ret = JSObject()
            ret.put("endpointId", endpointId)
            ret.put("value", String(bytes, Charsets.UTF_8))
            notifyListeners("payloadReceived", ret)
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
            // Payload texte court (uid+pseudo) — pas de suivi de progression nécessaire.
        }
    }

    override fun handleOnDestroy() {
        hardReset()
    }

    companion object {
        // Android 12 (API 31) : première version avec BLUETOOTH_ADVERTISE/CONNECT/SCAN en
        // permissions runtime. En dessous, le mode RADAR est masqué côté UI.
        private const val MIN_SDK = Build.VERSION_CODES.S
    }
}
