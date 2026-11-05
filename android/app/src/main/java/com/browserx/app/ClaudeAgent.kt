package com.browserx.app

import com.anthropic.client.AnthropicClient
import com.anthropic.client.okhttp.AnthropicOkHttpClient
import com.anthropic.core.JsonValue
import com.anthropic.errors.AnthropicServiceException
import com.anthropic.models.messages.Base64ImageSource
import com.anthropic.models.messages.ContentBlockParam
import com.anthropic.models.messages.MessageCreateParams
import com.anthropic.models.messages.MessageParam
import com.anthropic.models.messages.StopReason
import com.anthropic.models.messages.Tool
import com.anthropic.models.messages.ToolResultBlockParam
import com.anthropic.models.messages.ToolUnion
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlin.coroutines.coroutineContext

/**
 * 跟 Claude 对话、让它操作内置浏览器。用 Anthropic 官方 Java 开发包（anthropic-java）。
 * 跟电脑版一样走门户中转：baseUrl = <门户>/api/desktop/claude，用账号 token 认证（Authorization: Bearer），
 * 门户换成服务器上的真 key 转发并按账号计 Tokens，App 里没有任何 Claude key。
 * 工具调用循环自己写：模型要调工具（stop_reason = tool_use）就在 WebView 里执行，把结果发回去，直到它答完。
 */
class ClaudeAgent(private val browser: BrowserTools, private val ui: Ui) {
    interface Ui {
        fun assistantText(text: String)
        fun toolCall(label: String)
        fun error(text: String)
    }

    private var client: AnthropicClient? = null
    private var clientToken: String? = null
    private val history = mutableListOf<MessageParam>()

    fun reset() { history.clear() }

    private fun client(token: String): AnthropicClient {
        if (client == null || clientToken != token) {
            client = AnthropicOkHttpClient.builder()
                .baseUrl("${BuildConfig.PORTAL}/api/desktop/claude")
                .authToken(token)
                .build()
            clientToken = token
        }
        return client!!
    }

    /** 发一条用户消息，一直跑到模型答完（中间按需调浏览器工具） */
    suspend fun send(token: String, text: String) {
        history += MessageParam.ofUser(text)
        val c = client(token)
        for (round in 0 until MAX_ROUNDS) {
            coroutineContext.ensureActive()
            val params = MessageCreateParams.builder()
                .model(MODEL)
                .maxTokens(16000L)
                .system(SYSTEM_PROMPT)
                .tools(TOOLS.map { ToolUnion.ofTool(it) })
                .messages(history)
                .build()
            val msg = try {
                withContext(Dispatchers.IO) { c.messages().create(params) }
            } catch (e: AnthropicServiceException) {
                history.removeLastOrNull()
                ui.error(when (e.statusCode()) {
                    402 -> "今天的 Tokens 额度用完了，可以到网站充值，或用积分兑换"
                    401 -> "登录已失效，请重新登录"
                    403 -> "需要有效的会员授权才能使用，请在网站上开通会员"
                    else -> "请求出错（${e.statusCode()}）：${e.message}"
                })
                return
            }
            // 模型的回复原样放回对话（思考块、工具调用都要原样带回）
            history += msg.toParam()
            val results = mutableListOf<ContentBlockParam>()
            for (block in msg.content()) {
                block.text().orElse(null)?.let { t -> if (t.text().isNotBlank()) ui.assistantText(t.text()) }
                val use = block.toolUse().orElse(null) ?: continue
                @Suppress("UNCHECKED_CAST")
                val input = (use._input().convert(Map::class.java) as? Map<String, Any?>) ?: emptyMap()
                ui.toolCall(describe(use.name(), input))
                results += runTool(use.id(), use.name(), input)
            }
            if (msg.stopReason().orElse(null) != StopReason.TOOL_USE || results.isEmpty()) return
            history += MessageParam.ofUserOfContentBlockParams(results)
        }
        ui.error("操作步骤太多（超过 $MAX_ROUNDS 轮），先停下了。可以说一句「继续」让它接着做")
    }

    private suspend fun runTool(id: String, name: String, input: Map<String, Any?>): ContentBlockParam {
        fun str(k: String) = input[k]?.toString() ?: ""
        return try {
            if (name == "screenshot") {
                val b64 = browser.screenshot()
                val src = Base64ImageSource.builder().mediaType(Base64ImageSource.MediaType.IMAGE_JPEG).data(b64).build()
                ContentBlockParam.ofToolResult(
                    ToolResultBlockParam.builder().toolUseId(id).contentOfBlocks(
                        listOf(ToolResultBlockParam.Content.Block.ofImage(src))
                    ).build()
                )
            } else {
                val out = when (name) {
                    "navigate" -> browser.navigate(str("url"))
                    "page_info" -> browser.pageInfo()
                    "click" -> browser.click(str("target"))
                    "type" -> browser.type(str("target"), str("text"), input["submit"] == true)
                    "scroll" -> browser.scroll((input["dy"] as? Number)?.toInt() ?: 600)
                    "back" -> browser.back()
                    "eval" -> browser.eval(str("code"))
                    else -> "没有这个工具：$name"
                }
                ContentBlockParam.ofToolResult(ToolResultBlockParam.builder().toolUseId(id).content(out.take(20000)).build())
            }
        } catch (e: Exception) {
            ContentBlockParam.ofToolResult(ToolResultBlockParam.builder().toolUseId(id).content("出错：${e.message}").isError(true).build())
        }
    }

    private fun describe(name: String, input: Map<String, Any?>): String = when (name) {
        "navigate" -> "打开 ${input["url"]}"
        "page_info" -> "读取页面"
        "click" -> "点击 ${input["target"]}"
        "type" -> "输入到 ${input["target"]}"
        "scroll" -> "滚动页面"
        "back" -> "返回上一页"
        "eval" -> "执行页面脚本"
        "screenshot" -> "截图"
        else -> name
    }

    companion object {
        const val MODEL = "claude-opus-5-5"
        const val MAX_ROUNDS = 30

        val SYSTEM_PROMPT = """
            你是 BrowserX 安卓版里的助手。屏幕上方是一个真实的浏览器，你可以用工具替用户操作它：
            navigate 打开网址；page_info 读当前页面的文字和可操作元素（每个元素有编号）；click / type 用编号操作元素；
            scroll 滚动；back 返回；eval 执行一段页面 JS；screenshot 看页面截图（看验证码、图片、排版时用）。
            做法：先 page_info 了解页面，再按编号点击、输入；操作后再 page_info 确认结果，不要凭猜测说完成了。
            遇到要用户本人做的事（登录、输入验证码、付款确认）就停下来告诉用户，用户做完再继续。
            会提交、付款、删除、发布的操作，先问用户确认再做。
            用跟用户相同的语言回复，简洁，手机屏幕小。
        """.trimIndent()

        private fun tool(name: String, desc: String, props: Map<String, Map<String, Any>>, required: List<String>): Tool {
            val p = Tool.InputSchema.Properties.builder()
            props.forEach { (k, v) -> p.putAdditionalProperty(k, JsonValue.from(v)) }
            return Tool.builder().name(name).description(desc)
                .inputSchema(Tool.InputSchema.builder().properties(p.build()).required(required).build())
                .build()
        }

        val TOOLS = listOf(
            tool("navigate", "在浏览器里打开网址", mapOf("url" to mapOf("type" to "string", "description" to "网址")), listOf("url")),
            tool("page_info", "读取当前页面：网址、标题、可操作元素（带编号）和页面文字", emptyMap(), emptyList()),
            tool("click", "点击元素：page_info 给的编号、CSS 选择器或按钮上的文字", mapOf("target" to mapOf("type" to "string")), listOf("target")),
            tool("type", "往输入框填文字", mapOf(
                "target" to mapOf("type" to "string", "description" to "page_info 给的编号或 CSS 选择器"),
                "text" to mapOf("type" to "string"),
                "submit" to mapOf("type" to "boolean", "description" to "填完是否提交（回车）"),
            ), listOf("target", "text")),
            tool("scroll", "上下滚动页面，dy 为像素，正数向下", mapOf("dy" to mapOf("type" to "integer")), emptyList()),
            tool("back", "浏览器返回上一页", emptyMap(), emptyList()),
            tool("eval", "在页面里执行一段 JavaScript，返回结果", mapOf("code" to mapOf("type" to "string")), listOf("code")),
            tool("screenshot", "截取浏览器当前可见区域的图片", emptyMap(), emptyList()),
        )
    }
}
