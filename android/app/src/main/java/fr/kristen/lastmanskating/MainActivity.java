package fr.kristen.lastmanskating;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import androidx.activity.EdgeToEdge;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Installation standard requise par l'API Android 12+ SplashScreen (thème
        // Theme.SplashScreen dans styles.xml). On NE prolonge PAS son affichage
        // manuellement : on le laisse se refermer dès que le système le juge prêt,
        // pour laisser la place au vrai splash plein écran géré par le plugin
        // @capacitor/splash-screen (voir capacitor.config.json → plugins.SplashScreen).
        SplashScreen.installSplashScreen(this);

        // Bascule vers le vrai thème NoActionBar une fois le splash pris en charge.
        setTheme(R.style.AppTheme_NoActionBar);

        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);

        // Filet de sécurité : force la fermeture de l'ActionBar explicitement,
        // au cas où le thème seul ne suffirait pas à l'empêcher d'apparaître
        // (getSupportActionBar() peut retourner un objet non-null même sous un thème
        // NoActionBar si l'ActionBar a été instanciée avant notre setTheme()).
        if (getSupportActionBar() != null) {
            getSupportActionBar().hide();
        }

        WebView webView = this.bridge.getWebView();

        // ── Filet anti-crash "renderer WebView tué en arrière-plan" ──
        // Greffe un WebViewClient custom (LmsWebViewClient) SUR celui de Capacitor plutôt que
        // de le remplacer — même bridge, mêmes plugins, mêmes interceptions, une seule méthode
        // en plus : onRenderProcessGone(). Voir LmsWebViewClient.java pour le détail du
        // problème (crash Android par défaut si le renderer Chromium meurt en arrière-plan,
        // ex. pendant que le sélecteur de partage natif "Défier un ami" est ouvert).
        this.bridge.setWebViewClient(new LmsWebViewClient(this.bridge));

        // Désactive l'effet natif d'overscroll (glow/bounce) du WebView.
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        // ── Compatibilité Android TV / télécommande D-pad ──
        // Sans ces 3 lignes, la WebView ne reçoit jamais le focus clavier système
        // sur Android TV : les KeyEvent (DPAD_UP/DOWN/LEFT/RIGHT/CENTER, ENTER)
        // n'atteignent alors jamais le JS (keydown côté web), même si toute la
        // navigation D-pad est déjà correctement gérée dans le code du jeu.
        // C'est la cause la plus fréquente de rejet Google Play "does not support
        // D-pad navigation" pour une app WebView pourtant déjà compatible côté JS.
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.requestFocus(View.FOCUS_DOWN);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Redonne le focus à la WebView chaque fois que la fenêtre le regagne
        // (retour d'un dialogue système, changement d'app au premier plan, etc.).
        // Sur TV, sans ce filet, le focus clavier peut se perdre après une pause/
        // reprise de l'activité et ne jamais revenir tout seul à la page — les
        // touches D-pad cesseraient alors de fonctionner silencieusement.
        if (hasFocus && this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().requestFocus(View.FOCUS_DOWN);
        }
    }
}
