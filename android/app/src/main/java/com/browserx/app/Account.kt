package com.browserx.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * BrowserX 账号：跟电脑版（account.js）同一套登录。
 * 在本机 127.0.0.1 开一个随机端口等回调，用系统浏览器打开门户的授权页（带 PKCE challenge），
 * 用户授权后门户跳回 http://127.0.0.1:<端口>/callback?code&state，再用 code + verifier 换账号 token。
 * token 存在 App 私有的 SharedPreferences 里（只有本 App 能读）。
 */
class Account(private val context: Context) {
    private val prefs = context.getSharedPreferences("account", Context.MODE_PRIVATE)
    private val http = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()

    var token: String?
        get() = prefs.getString("token", null)
        private set(v) { prefs.edit().apply { if (v == null) remove("token") else putString("token", v) }.apply() }

    var userName: String? = null
        private set

    val loggedIn get() = token != null

    suspend fun login() {
        val verifier = b64url(randomBytes(32))
        val challenge = b64url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))
        val state = b64url(randomBytes(16))
        val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        try {
            val device = "Android ${Build.MANUFACTURER} ${Build.MODEL}".take(60)
            val url = Uri.parse("${BuildConfig.PORTAL}/desktop/authorize").buildUpon()
                .appendQueryParameter("port", server.localPort.toString())
                .appendQueryParameter("state", state)
                .appendQueryParameter("challenge", challenge)
                .appendQueryParameter("device", device)
                .build()
            context.startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val code = withTimeout(10 * 60 * 1000L) { waitCallback(server, state) }
            val body = JSONObject().put("code", code).put("verifier", verifier).toString()
            val r = request("/api/desktop/token", "POST", body, auth = false)
            token = r.getString("token")
            refresh()
        } finally {
            runCatching { server.close() }
        }
    }

    // 等浏览器回调：只认这次登录的 state，别的请求回 404
    private suspend fun waitCallback(server: ServerSocket, state: String): String = suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { runCatching { server.close() } }
        thread(name = "login-callback") {
            try {
                while (true) {
                    val sock = server.accept()
                    sock.use { s ->
                        val line = s.getInputStream().bufferedReader().readLine() ?: return@use
                        val path = line.split(" ").getOrNull(1) ?: ""
                        val q = path.substringAfter("?", "").split("&").mapNotNull {
                            val k = it.substringBefore("=", "")
                            if (k.isEmpty()) null else k to URLDecoder.decode(it.substringAfter("=", ""), "UTF-8")
                        }.toMap()
                        val ok = path.startsWith("/callback") && q["state"] == state && !q["code"].isNullOrEmpty()
                        val msg = if (ok) "已连接 BrowserX，可以回到 App 了" else if (q["error"] == "denied") "已取消授权" else "授权没有完成"
                        val html = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><body style='font:18px sans-serif;text-align:center;padding-top:30vh'>$msg</body>"
                        val bytes = html.toByteArray()
                        s.getOutputStream().write(("HTTP/1.1 ${if (path.startsWith("/callback")) 200 else 404} OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray() + bytes)
                        if (path.startsWith("/callback") && q["state"] == state) {
                            if (ok) cont.resume(q.getValue("code")) else cont.resumeWithException(IllegalStateException(msg))
                            return@thread
                        }
                    }
                }
            } catch (e: Exception) {
                if (cont.isActive) cont.resumeWithException(e)
            }
        }
    }

    suspend fun refresh(): JSONObject? {
        if (token == null) { userName = null; return null }
        val me = request("/api/desktop/me")
        userName = me.optJSONObject("user")?.optString("name")?.takeIf { it.isNotEmpty() } ?: me.optString("name").takeIf { it.isNotEmpty() } ?: "已登录"
        return me
    }

    suspend fun logout() {
        if (token != null) runCatching { request("/api/desktop/logout", "POST", "{}") }
        token = null
        userName = null
    }

    private suspend fun request(path: String, method: String = "GET", body: String? = null, auth: Boolean = true): JSONObject = withContext(Dispatchers.IO) {
        val b = Request.Builder().url(BuildConfig.PORTAL + path).header("Accept", "application/json")
        if (auth) token?.let { b.header("Authorization", "Bearer $it") }
        b.method(method, body?.toRequestBody("application/json".toMediaType()))
        http.newCall(b.build()).execute().use { res ->
            val text = res.body?.string() ?: ""
            if (res.code == 401 && auth) { token = null; throw IllegalStateException("登录已失效，请重新登录") }
            if (!res.isSuccessful) {
                val msg = runCatching { JSONObject(text).optString("message") }.getOrNull()
                throw IllegalStateException(msg?.takeIf { it.isNotEmpty() } ?: "请求失败（HTTP ${res.code}）")
            }
            if (text.isBlank()) JSONObject() else JSONObject(text)
        }
    }

    private fun randomBytes(n: Int) = ByteArray(n).also { SecureRandom().nextBytes(it) }
    private fun b64url(b: ByteArray) = Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}
