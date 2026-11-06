package com.browserx.app

import android.annotation.SuppressLint
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.inputmethod.EditorInfo
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity(), ClaudeAgent.Ui {
    private lateinit var account: Account
    private lateinit var browser: BrowserTools
    private lateinit var agent: ClaudeAgent
    private lateinit var web: WebView
    private lateinit var chat: LinearLayout
    private lateinit var chatScroll: ScrollView
    private lateinit var input: EditText
    private lateinit var sendBtn: Button
    private lateinit var accountBtn: Button
    private lateinit var urlBox: EditText
    private var running: Job? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        chat = findViewById(R.id.chat)
        chatScroll = findViewById(R.id.chatScroll)
        input = findViewById(R.id.input)
        sendBtn = findViewById(R.id.send)
        accountBtn = findViewById(R.id.account)
        urlBox = findViewById(R.id.url)

        account = Account(this)
        browser = BrowserTools(web)
        agent = ClaudeAgent(browser, this)

        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.loadWithOverviewMode = true
        web.settings.useWideViewPort = true
        web.settings.setSupportMultipleWindows(false) // target=_blank 在当前页打开
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                urlBox.setText(url)
                browser.onPageFinished()
            }
        }
        web.loadUrl(BuildConfig.PORTAL)

        urlBox.setOnEditorActionListener { _, id, _ ->
            if (id == EditorInfo.IME_ACTION_GO) { lifecycleScope.launch { browser.navigate(urlBox.text.toString().trim()) }; true } else false
        }
        sendBtn.setOnClickListener { if (running?.isActive == true) stop() else send() }
        accountBtn.setOnClickListener { onAccount() }
        findViewById<Button>(R.id.fullWeb).setOnClickListener { setMode(if (mode == Mode.WEB) Mode.SPLIT else Mode.WEB) }
        findViewById<Button>(R.id.fullChat).setOnClickListener { setMode(if (mode == Mode.CHAT) Mode.SPLIT else Mode.CHAT) }

        note("在上面的网页里，让助手替你查资料、填表、点按钮。先登录 BrowserX 账号才能使用。")
        lifecycleScope.launch { runCatching { account.refresh() }; renderAccount() }
    }

    // 上下分屏 / 浏览器全屏 / 助手全屏：地址栏和账号按钮一直在
    private enum class Mode { SPLIT, WEB, CHAT }
    private var mode = Mode.SPLIT

    private fun setMode(m: Mode) {
        mode = m
        val chatParts = listOf(R.id.divider, R.id.chatHeader, R.id.chatScroll, R.id.inputRow)
        web.visibility = if (m == Mode.CHAT) android.view.View.GONE else android.view.View.VISIBLE
        for (id in chatParts) findViewById<android.view.View>(id).visibility = if (m == Mode.WEB) android.view.View.GONE else android.view.View.VISIBLE
        findViewById<android.view.View>(R.id.divider).visibility = if (m == Mode.SPLIT) android.view.View.VISIBLE else android.view.View.GONE
        findViewById<Button>(R.id.fullWeb).text = if (m == Mode.WEB) "退出全屏" else "全屏"
        findViewById<Button>(R.id.fullChat).text = if (m == Mode.CHAT) "退出全屏" else "全屏"
        if (m != Mode.CHAT) scrollDown()
    }

    private fun renderAccount() {
        accountBtn.text = if (account.loggedIn) (account.userName ?: "已登录") else "登录"
    }

    private fun onAccount() {
        if (!account.loggedIn) {
            lifecycleScope.launch {
                note("正在系统浏览器里打开授权页，授权后回到这里…")
                try { account.login(); note("已登录：${account.userName}") } catch (e: Exception) { error("登录没有完成：${e.message}") }
                renderAccount()
            }
            return
        }
        AlertDialog.Builder(this)
            .setTitle(account.userName ?: "BrowserX 账号")
            .setItems(arrayOf("新对话", "退出登录")) { _, which ->
                if (which == 0) { agent.reset(); chat.removeAllViews(); note("— 新对话 —") }
                else lifecycleScope.launch { account.logout(); agent.reset(); renderAccount(); note("已退出登录") }
            }
            .show()
    }

    private fun send() {
        val text = input.text.toString().trim()
        if (text.isEmpty()) return
        val token = account.token
        if (token == null) { error("请先点右上角「登录」，登录 BrowserX 账号后就能使用"); return }
        input.setText("")
        bubble(text, user = true)
        sendBtn.text = "停止"
        running = lifecycleScope.launch {
            try { agent.send(token, text) }
            catch (e: kotlinx.coroutines.CancellationException) { note("■ 已停止") }
            catch (e: Exception) { error("出错：${e.message}") }
            finally { sendBtn.text = "发送"; renderAccount() }
        }
    }

    private fun stop() { running?.cancel() }

    // ---- 对话区 ----
    override fun assistantText(text: String) = runOnUiThread { bubble(text, user = false) }
    override fun toolCall(label: String) = runOnUiThread { line("• $label", Color.GRAY, 12f) }
    override fun error(text: String) = runOnUiThread { line("✗ $text", Color.parseColor("#D93025"), 13f) }
    private fun note(text: String) = line(text, Color.GRAY, 13f)

    private fun bubble(text: String, user: Boolean) {
        val tv = TextView(this).apply {
            this.text = text
            textSize = 15f
            setTextIsSelectable(true)
            setPadding(24, 14, 24, 14)
            if (user) setBackgroundColor(Color.parseColor("#22888888"))
        }
        val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            topMargin = 10
            gravity = if (user) Gravity.END else Gravity.START
        }
        chat.addView(tv, lp)
        scrollDown()
    }

    private fun line(text: String, color: Int, size: Float) {
        val tv = TextView(this).apply { this.text = text; setTextColor(color); textSize = size; typeface = Typeface.DEFAULT; setPadding(4, 6, 4, 6) }
        chat.addView(tv)
        scrollDown()
    }

    private fun scrollDown() = chatScroll.post { chatScroll.fullScroll(ScrollView.FOCUS_DOWN) }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (mode != Mode.SPLIT) setMode(Mode.SPLIT) // 全屏时返回键先退出全屏
        else if (web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }
}
