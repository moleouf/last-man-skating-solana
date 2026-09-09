package fr.kristen.lastmanskating;

import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.appcompat.app.AppCompatActivity;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/**
 * WebViewClient personnalisé, greffé SUR celui de Capacitor (on hérite de BridgeWebViewClient,
 * on ne le remplace pas) pour ne pas casser l'interception des requêtes locales ni le pont
 * JS <-> natif — tout le comportement standard de Capacitor est conservé tel quel.
 *
 * Ne surcharge qu'une seule méthode : onRenderProcessGone().
 *
 * Contexte : le jeu est un unique gros canvas HTML5 (nombreux sprites, caches OffscreenCanvas
 * par monde) donc gourmand en mémoire côté processus renderer Chromium de la WebView. Quand
 * l'appli passe en arrière-plan (ex : sélecteur de partage natif "Défier un ami" ouvert le
 * temps que l'utilisateur choisisse une appli), Android peut réclamer cette mémoire en tuant
 * ce processus renderer.
 *
 * Comportement PAR DÉFAUT d'Android si onRenderProcessGone n'est PAS surchargé (documenté
 * officiellement dans WebViewClient) : planter l'appli purement et simplement si ce WebView
 * était au premier plan. C'est très probablement la source du crash intermittent observé au
 * retour d'un partage de salle (et, dans les cas moins graves, du symptôme "retour à l'accueil"
 * quand seule la WebView est recréée sans faire tomber tout le process).
 *
 * Ici, on gère l'incident nous-mêmes : on détruit proprement l'ancienne WebView irrécupérable
 * puis on relance l'Activity (qui recrée tout, y compris une WebView saine), au lieu de laisser
 * Android appliquer son comportement par défaut.
 */
public class LmsWebViewClient extends BridgeWebViewClient {

    private static final String TAG = "LMSWebViewClient";

    // On garde notre propre référence au Bridge : celle du parent (BridgeWebViewClient) est
    // privée, pas accessible depuis une sous-classe.
    private final Bridge lmsBridge;

    public LmsWebViewClient(Bridge bridge) {
        super(bridge);
        this.lmsBridge = bridge;
    }

    @Override
    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        final boolean crashed = detail != null && detail.didCrash();
        Log.w(TAG, "Renderer WebView disparu (crashed=" + crashed
                + ") — relance de l'activité au lieu de laisser Android planter l'appli.");

        if (view != null) {
            // La WebView existante est irrécupérable une fois son renderer parti : il faut la
            // détruire explicitement avant qu'Activity#recreate() n'en recrée une nouvelle propre.
            view.destroy();
        }

        AppCompatActivity activity = (lmsBridge != null) ? lmsBridge.getActivity() : null;
        if (activity != null) {
            // onRenderProcessGone est documenté comme appelé sur le thread UI, mais on repasse
            // explicitement par runOnUiThread pour rester robuste si une surcouche constructeur
            // dévie de la doc.
            activity.runOnUiThread(activity::recreate);
        }

        // true = on indique à Android qu'ON a géré l'incident nous-mêmes : il ne doit PAS
        // appliquer son comportement par défaut (planter l'appli au premier plan).
        return true;
    }
}
