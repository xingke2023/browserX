package com.browserx.app

import android.graphics.Bitmap
import android.graphics.Canvas
import android.util.Base64
import android.webkit.WebView
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.coroutines.resume

/**
 * Claude 操作内置浏览器（WebView）的工具：打开网址、读页面、点、输入、滚动、执行脚本、截图。
 * 跟电脑版的 browser 工具组同一个思路，但安卓的 WebView 没有 Chrome 调试接口，
 * 点击 / 输入都用页面里的 JS 完成；元素用 page_info 给出的编号（页面上打了 data-bx 标记）来指。
 * WebView 只能在主线程操作，这里每个方法都切到主线程。
 */
class BrowserTools(private val web: WebView) {
    @Volatile var pageLoaded: CompletableDeferred<Unit>? = null

    /** MainActivity 的 WebViewClient.onPageFinished 调这个 */
    fun onPageFinished() { pageLoaded?.complete(Unit) }

    suspend fun navigate(url: String): String {
        val u = if (Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(url)) url else "https://$url"
        val done = CompletableDeferred<Unit>()
        pageLoaded = done
        withContext(Dispatchers.Main) { web.loadUrl(u) }
        val ok = withTimeoutOrNull(30_000) { done.await() } != null
        delay(500) // 很多页面加载完还会跑一会儿脚本
        return (if (ok) "已打开" else "30 秒内没加载完（可能还在加载）") + "：" + js("location.href")
    }

    suspend fun back(): String {
        withContext(Dispatchers.Main) { if (web.canGoBack()) web.goBack() }
        delay(1200)
        return "当前页面：" + js("location.href")
    }

    /** 当前网址、标题、可见文字（截断）和可操作元素（带编号） */
    suspend fun pageInfo(maxText: Int = 6000): String = js(
        """
        (() => {
          const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
          document.querySelectorAll('[data-bx]').forEach((e) => e.removeAttribute('data-bx'));
          const els = [...document.querySelectorAll('a,button,input,select,textarea,[role=button],[onclick],[contenteditable=true]')].filter(vis).slice(0, 150);
          const items = els.map((e, i) => {
            e.setAttribute('data-bx', String(i + 1));
            const t = (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || e.title || e.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
            const type = e.tagName.toLowerCase() + (e.type ? ':' + e.type : '');
            return '[' + (i + 1) + '] ' + type + ' ' + t + (e.tagName === 'A' && e.href ? ' → ' + e.href.slice(0, 80) : '');
          });
          const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, $maxText);
          return '网址：' + location.href + '\n标题：' + document.title + '\n\n可操作的元素（用编号点击 / 输入）：\n' + items.join('\n') + '\n\n页面文字：\n' + text;
        })()
        """.trimIndent()
    )

    /** 按编号（page_info 给的）、CSS 选择器或按钮文字点击 */
    suspend fun click(target: String): String {
        val r = js(
            """
            (() => {
              const t = ${JSONObject.quote(target)};
              let e = /^\d+$/.test(t) ? document.querySelector('[data-bx="' + t + '"]') : null;
              if (!e) { try { e = document.querySelector(t); } catch (x) {} }
              if (!e) e = [...document.querySelectorAll('a,button,[role=button],input[type=submit],input[type=button],label')]
                .find((x) => (x.innerText || x.value || '').trim() === t) || null;
              if (!e) return '没找到要点的元素：' + t + '（先用 page_info 看编号）';
              e.scrollIntoView({ block: 'center' });
              e.focus && e.focus();
              e.click();
              return '已点击：' + (e.innerText || e.value || e.tagName).trim().slice(0, 40);
            })()
            """.trimIndent()
        )
        delay(800)
        return r
    }

    /** 往输入框里填文字（React / Vue 等框架也能收到 input 事件）；submit=true 时再提交表单 */
    suspend fun type(target: String, text: String, submit: Boolean): String {
        val r = js(
            """
            (() => {
              const t = ${JSONObject.quote(target)};
              let e = /^\d+$/.test(t) ? document.querySelector('[data-bx="' + t + '"]') : null;
              if (!e) { try { e = document.querySelector(t); } catch (x) {} }
              if (!e) e = document.activeElement;
              if (!e || !('value' in e || e.isContentEditable)) return '没找到输入框：' + t;
              e.focus();
              const v = ${JSONObject.quote(text)};
              if (e.isContentEditable) { e.innerText = v; }
              else {
                const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                setter.call(e, v);
              }
              e.dispatchEvent(new Event('input', { bubbles: true }));
              e.dispatchEvent(new Event('change', { bubbles: true }));
              if (${submit}) {
                if (e.form) { e.form.requestSubmit ? e.form.requestSubmit() : e.form.submit(); }
                else { e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })); }
              }
              return '已输入' + (${submit} ? '并提交' : '');
            })()
            """.trimIndent()
        )
        delay(if (submit) 1500 else 300)
        return r
    }

    suspend fun scroll(dy: Int): String = js("window.scrollBy(0, $dy); 'scrollY=' + Math.round(scrollY) + ' / ' + document.documentElement.scrollHeight")

    /** 执行一段 JS，返回结果（字符串化） */
    suspend fun eval(code: String): String = js(
        "(() => { try { const r = (0, eval)(${JSONObject.quote(code)}); return typeof r === 'string' ? r : JSON.stringify(r); } catch (e) { return '出错：' + e.message; } })()"
    )

    /** 截当前可见区域，缩到长边不超过 1280，JPEG 的 base64 */
    suspend fun screenshot(): String = withContext(Dispatchers.Main) {
        val w = web.width.coerceAtLeast(1)
        val h = web.height.coerceAtLeast(1)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        web.draw(Canvas(bmp))
        val scale = minOf(1f, 1280f / maxOf(w, h))
        val out = if (scale < 1f) Bitmap.createScaledBitmap(bmp, (w * scale).toInt(), (h * scale).toInt(), true) else bmp
        val buf = ByteArrayOutputStream()
        out.compress(Bitmap.CompressFormat.JPEG, 80, buf)
        Base64.encodeToString(buf.toByteArray(), Base64.NO_WRAP)
    }

    /** evaluateJavascript 返回的是 JSON 字面量（字符串带引号）：解出来成普通文字 */
    suspend fun js(code: String): String = withContext(Dispatchers.Main) {
        suspendCancellableCoroutine { cont ->
            web.evaluateJavascript(code) { raw ->
                val v = runCatching { JSONArray("[$raw]").get(0) }.getOrNull()
                cont.resume(if (v == null || v == JSONObject.NULL) "" else v.toString())
            }
        }
    }
}
