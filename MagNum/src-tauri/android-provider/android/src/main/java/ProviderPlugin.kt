package com.green.magnum.provider

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Dialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.browser.customtabs.CustomTabsIntent
import androidx.activity.result.ActivityResult
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updateLayoutParams
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

private const val origin = "https://chat.deepseek.com"
private const val signInPath = "/sign_in"
private val conversation = Regex("""/(?:a/)?chat/(?:s/)?[A-Za-z0-9_-]+""")

@TauriPlugin
class ProviderPlugin(private val activity: Activity) : Plugin(activity) {
    private val handler = Handler(Looper.getMainLooper())
    private val driver by lazy {
        activity.assets.open("magnum-deepseek.js").bufferedReader().use { it.readText() }
    }
    private var browser: WebView? = null
    private var background: FrameLayout? = null
    private var dialog: Dialog? = null
    private var notice: TextView? = null
    private var openBrowser: Button? = null
    private var pageError: String? = null
    private var loading = true

    override fun load(webView: WebView) {
        val topMargin = (webView.layoutParams as ViewGroup.MarginLayoutParams).topMargin
        val topInsets = WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout()
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            // Keep the app below the status bar even on WebViews without CSS safe-area support.
            val safeTopMargin = topMargin + insets.getInsets(topInsets).top
            if ((view.layoutParams as ViewGroup.MarginLayoutParams).topMargin != safeTopMargin) {
                view.updateLayoutParams<ViewGroup.MarginLayoutParams> {
                    this.topMargin = safeTopMargin
                }
            }
            ViewCompat.onApplyWindowInsets(view, insets)
        }
        ViewCompat.requestApplyInsets(webView)
    }

    private fun trusted(uri: Uri): Boolean =
        uri.scheme == "https" && uri.encodedAuthority == "chat.deepseek.com"

    private fun showExternalNavigation(uri: Uri) {
        val google = uri.scheme == "https" && uri.encodedAuthority == "accounts.google.com"
        notice?.text = if (google) {
            "Google sign-in runs in your browser and stays there. For MagNum chat, use DeepSeek’s email and password on this page."
        } else {
            "DeepSeek tried to open a page outside chat.deepseek.com."
        }
        openBrowser?.visibility = if (google) View.VISIBLE else View.GONE
    }

    private fun openDeepSeekInBrowser() {
        try {
            // Start at DeepSeek so OAuth starts and finishes in the same browser session.
            CustomTabsIntent.Builder().setShowTitle(true).build()
                .launchUrl(activity, Uri.parse(origin + signInPath))
        } catch (_: ActivityNotFoundException) {
            notice?.text = "Android could not open a browser. You can still sign in here with DeepSeek email and password."
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun view(): WebView {
        browser?.let { return it }
        val content = activity.findViewById<ViewGroup>(android.R.id.content)
        val holder = FrameLayout(activity).apply {
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        content.addView(holder, 0, ViewGroup.LayoutParams(-1, -1))
        background = holder
        return WebView(activity).apply {
            browser = this
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
            // WebView debugging is process-wide. Keep provider storage outside DevTools.
            WebView.setWebContentsDebuggingEnabled(false)
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (!request.isForMainFrame || trusted(request.url)) return false
                    showExternalNavigation(request.url)
                    return true
                }

                override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                    val uri = Uri.parse(url)
                    if (!trusted(uri)) {
                        view.stopLoading()
                        showExternalNavigation(uri)
                        loading = false
                        pageError = "DeepSeek tried to open a page outside chat.deepseek.com."
                        return
                    }
                    loading = true
                    pageError = null
                }

                override fun onPageFinished(view: WebView, url: String) {
                    if (view.url == url) loading = false
                    CookieManager.getInstance().flush()
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) pageError =
                        "Android WebView could not load DeepSeek (error ${error.errorCode})."
                }

                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, error: WebResourceResponse) {
                    if (request.isForMainFrame) pageError = "DeepSeek returned HTTP ${error.statusCode}."
                }

                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    releaseView()
                    return true
                }
            }
            holder.addView(this, FrameLayout.LayoutParams(-1, -1))
            navigate(this, "/")
        }
    }

    private fun navigate(view: WebView, path: String) {
        pageError = null
        loading = true
        view.loadUrl(origin + path)
    }

    private fun move(view: WebView, parent: ViewGroup, params: ViewGroup.LayoutParams) {
        (view.parent as? ViewGroup)?.removeView(view)
        parent.addView(view, params)
    }

    private fun show(view: WebView, signIn: Boolean) {
        if (dialog != null) return
        val window = Dialog(activity, android.R.style.Theme_Material_Light_NoActionBar)
        val content = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        content.addView(Button(activity).apply {
            text = "Return to MagNum"
            setOnClickListener { window.dismiss() }
        }, LinearLayout.LayoutParams(-1, -2))
        content.addView(TextView(activity).also {
            notice = it
            it.setPadding(20, 0, 20, 12)
            it.text = "chat.deepseek.com · Use DeepSeek email and password for MagNum chat"
            it.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }, LinearLayout.LayoutParams(-1, -2))
        content.addView(Button(activity).also {
            openBrowser = it
            it.text = "Open DeepSeek in browser"
            it.visibility = View.GONE
            it.setOnClickListener { openDeepSeekInBrowser() }
        }, LinearLayout.LayoutParams(-1, -2))
        move(view, content, LinearLayout.LayoutParams(-1, 0, 1f))
        window.setContentView(content)
        window.setOnDismissListener {
            dialog = null
            notice = null
            openBrowser = null
            if (browser === view) {
                background?.let { move(view, it, FrameLayout.LayoutParams(-1, -1)) }
                CookieManager.getInstance().flush()
            }
        }
        dialog = window
        window.show()
        window.window?.setLayout(-1, -1)
        window.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        if (pageError != null || (signIn && view.url?.let(Uri::parse)?.path != signInPath)) {
            navigate(view, signInPath)
        }
    }

    private fun releaseView() {
        val view = browser
        browser = null
        dialog?.dismiss()
        (view?.parent as? ViewGroup)?.removeView(view)
        view?.destroy()
        (background?.parent as? ViewGroup)?.removeView(background)
        background = null
    }

    override fun onDestroy() {
        releaseView()
    }

    private fun evaluate(view: WebView, operation: String, args: JSONObject, invoke: Invoke) {
        val url = view.url?.let(Uri::parse)
        if (pageError != null) {
            invoke.resolve(JSObject().put("state", "unavailable").put("detail", pageError))
            return
        }
        if (loading || url == null || !trusted(url)) {
            invoke.resolve(JSObject().put("state", "loading"))
            return
        }
        var timedOut = false
        val fallback = Runnable {
            timedOut = true
            invoke.resolve(JSObject().put("state", "unavailable").put("detail", "DeepSeek’s page did not respond."))
        }
        handler.postDelayed(fallback, 5000)
        view.evaluateJavascript("($driver)(${JSONObject.quote(operation)}, $args)") { value ->
            if (timedOut) return@evaluateJavascript
            handler.removeCallbacks(fallback)
            val result = runCatching { JSObject(value) }.getOrNull()
            if (result == null) {
                invoke.resolve(JSObject().put("state", "unavailable").put("detail", "DeepSeek’s page did not respond."))
                return@evaluateJavascript
            }
            if (operation == "status") result.put("presented", dialog != null)
            invoke.resolve(result)
        }
    }

    private var importing = false

    @Command
    fun browseWorkspaces(invoke: Invoke) {
        activity.runOnUiThread {
            for (action in listOf(Intent.ACTION_VIEW, "android.provider.action.BROWSE")) {
                try {
                    activity.startActivity(WorkspaceDocumentsProvider.browse(activity, action))
                    invoke.resolve()
                    return@runOnUiThread
                } catch (_: ActivityNotFoundException) {
                    // Some Android versions register only one of the two browse actions.
                } catch (_: SecurityException) {
                    // Some file browsers reserve their browse activity for system callers.
                }
            }
            invoke.reject("Open Android Files and look for MagNum Workspaces in its locations menu.")
        }
    }

    @Command
    fun importWorkspace(invoke: Invoke) {
        activity.runOnUiThread {
            if (importing) {
                invoke.reject("A folder import is already open.")
                return@runOnUiThread
            }
            importing = true
            try {
                startActivityForResult(invoke, WorkspaceImport.picker(), "workspacePicked")
            } catch (_: ActivityNotFoundException) {
                importing = false
                invoke.reject("Android folder selection is unavailable on this device.")
            }
        }
    }

    @ActivityCallback
    fun workspacePicked(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            importing = false
            invoke.resolve(JSObject())
            return
        }
        Thread {
            val copy = runCatching { WorkspaceImport(activity).copy(uri) }
            handler.post {
                importing = false
                copy.onSuccess { invoke.resolve(JSObject().put("path", it.absolutePath)) }
                    .onFailure { invoke.reject(it.message ?: "Android could not import this folder.") }
            }
        }.start()
    }

    @Command
    fun provider(invoke: Invoke) {
        val args = invoke.getArgs()
        val operation = args.optString("operation")
        activity.runOnUiThread {
            val view = view()
            when (operation) {
                "show" -> { show(view, args.optString("signIn") == "true"); invoke.resolve() }
                "hide" -> { dialog?.dismiss(); invoke.resolve() }
                "navigate" -> {
                    val path = args.optString("path")
                    if (path != "/" && !conversation.matches(path)) {
                        invoke.reject("Invalid DeepSeek conversation.")
                    } else {
                        navigate(view, path)
                        invoke.resolve()
                    }
                }
                "status", "fill", "submit", "poll", "stop" -> {
                    val input = JSONObject()
                    if (operation == "fill") {
                        input.put("prompt", args.optString("prompt"))
                        input.put("path", args.optString("path"))
                        if (args.has("deepThink")) input.put("deepThink", args.optBoolean("deepThink"))
                        input.put("confirmThinking", args.optBoolean("confirmThinking"))
                    }
                    evaluate(view, operation, input, invoke)
                }
                else -> invoke.reject("Unknown DeepSeek browser operation.")
            }
        }
    }
}
