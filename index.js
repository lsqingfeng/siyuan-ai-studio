"use strict";
const siyuan = require("siyuan");

// 安全获取 child_process
let child_process = null;
try {
    child_process = require("child_process");
} catch (e) {
    if (typeof window !== "undefined" && window.require) {
        try { child_process = window.require("child_process"); } catch (err) {}
    }
}
const exec = child_process ? child_process.exec : null;

// ==========================================
// 1. 预设提示词模板模块
// ==========================================
const PRESET_PROMPTS = [
    {
        id: "search_rag",
        name: "🔍 搜笔记并汇总",
        prompt: "搜一下我之前记录的关于分布式架构的笔记，并总结其核心设计与踩坑经验"
    },
    {
        id: "replace_polish",
        name: "⚡ 润色选区并替换",
        prompt: "把选中的这段话进行深度人话润色，去掉AI味与教材腔，并直接原地替换"
    },
    {
        id: "create_doc",
        name: "📄 撰写长文并存为笔记",
        prompt: "写一篇关于高并发系统设计的实战指南，包含架构拓扑与关键机制，并保存为思源新笔记"
    },
    {
        id: "humanize",
        name: "✨ 人话润色 (去AI味)",
        prompt: "请对以下内容进行深度润色：说人话、去教材腔、去八股套话，严禁出现'算力平民化'、'神话破产'、'技术债塌陷'等同质化词汇，保持行文口吻自然犀利：\n"
    },
    {
        id: "feishu_doc",
        name: "🚀 整理方案并同步飞书",
        prompt: "请将以下内容整理为一份排版规范的工程方案文档，并同步发送到飞书：\n"
    }
];

// ==========================================
// 2. AI SSE 流式客户端模块
// ==========================================
class AIClient {
    constructor(config = {}) {
        this.apiKey = config.apiKey || "";
        this.baseUrl = (config.baseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");
        this.model = config.model || "deepseek-chat";
        this.temperature = typeof config.temperature === "number" ? config.temperature : 0.7;
    }

    updateConfig(config) {
        if (config.apiKey !== undefined) this.apiKey = config.apiKey;
        if (config.baseUrl !== undefined) this.baseUrl = config.baseUrl.replace(/\/+$/, "");
        if (config.model !== undefined) this.model = config.model;
        if (config.temperature !== undefined) this.temperature = config.temperature;
    }

    async chatStream(messages, onChunk, onDone, onError) {
        if (!this.apiKey && !this.baseUrl.includes("localhost") && !this.baseUrl.includes("127.0.0.1")) {
            throw new Error("请先在插件设置中填入 API Key！");
        }

        const url = `${this.baseUrl}/chat/completions`;
        const headers = {
            "Content-Type": "application/json"
        };
        if (this.apiKey) {
            headers["Authorization"] = `Bearer ${this.apiKey}`;
        }

        const payload = {
            model: this.model,
            messages: messages,
            temperature: this.temperature,
            stream: true
        };

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: headers,
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`API 错误 (${response.status}): ${errText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let accumulated = "";
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop(); // 保留未完整的尾部

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith(":") || trimmed === "data: [DONE]") continue;
                    if (trimmed.startsWith("data: ")) {
                        try {
                            const json = JSON.parse(trimmed.slice(6));
                            const delta = json.choices?.[0]?.delta?.content || "";
                            if (delta) {
                                accumulated += delta;
                                if (onChunk) onChunk(delta, accumulated);
                            }
                        } catch (e) {
                            // 忽略部分格式异常的流数据行
                        }
                    }
                }
            }

            if (onDone) onDone(accumulated);
            return accumulated;
        } catch (err) {
            if (onError) onError(err);
            throw err;
        }
    }
}

// ==========================================
// 3. 思源笔记内核桥接模块
// ==========================================
class SiYuanBridge {
    static async getNotebooks() {
        const resp = await siyuan.fetchSyncPost("/api/notebook/lsNotebooks", {});
        if (resp.code === 0 && resp.data?.notebooks) {
            return resp.data.notebooks;
        }
        return [];
    }

    static async getDefaultNotebookId() {
        const notebooks = await this.getNotebooks();
        const opened = notebooks.find(n => !n.closed);
        return opened ? opened.id : (notebooks[0]?.id || "");
    }

    /**
     * 1. 创作能力：一键创建 Markdown 新文档 (支持自然语义纯净路径与指定目录)
     */
    static async createDocWithMd(title, markdown, notebookId, pathPrefix = "/AI创作") {
        const cleanTitle = (title || "未命名创作").replace(/[\/:*?"<>|]/g, "").trim().slice(0, 60);
        const targetNotebook = notebookId || await this.getDefaultNotebookId();
        if (!targetNotebook) {
            throw new Error("未检测到可用的思源笔记本，请在设置中配置或打开一个笔记本");
        }

        // 格式化纯净语义路径：去除多余斜杠，避免首尾异常，严格遵循无日期前缀规范
        let baseDir = (pathPrefix || "/AI创作").trim();
        if (!baseDir.startsWith("/")) baseDir = "/" + baseDir;
        baseDir = baseDir.replace(/\/+$/, "");

        const docPath = `${baseDir}/${cleanTitle}`;

        // 确保首行有唯一一级大标题
        let finalMd = markdown.trim();
        if (!finalMd.startsWith("# ")) {
            finalMd = `# ${cleanTitle}\n\n${finalMd}`;
        }

        const payload = {
            notebook: targetNotebook,
            path: docPath,
            markdown: finalMd
        };

        const resp = await siyuan.fetchSyncPost("/api/filetree/createDocWithMd", payload);
        if (resp.code !== 0) {
            throw new Error(`思源创建文档失败: ${resp.msg || JSON.stringify(resp)}`);
        }

        const docId = resp.data;

        // 自动注入属性标签 (tags: AI创作)
        try {
            await siyuan.fetchSyncPost("/api/attr/setBlockAttrs", {
                id: docId,
                attrs: {
                    "custom-ai-created": "true",
                    "tags": "AI创作"
                }
            });
        } catch (e) {
            console.warn("[SiYuanBridge] 自动设置属性标签忽略:", e);
        }

        return {
            docId,
            path: docPath,
            title: cleanTitle,
            notebook: targetNotebook
        };
    }

    /**
     * 2. 编辑能力 A：向文档末尾追加内容
     */
    static async appendToDoc(docId, markdown) {
        if (!docId) {
            throw new Error("未指定目标文档 ID");
        }

        const payload = {
            data: markdown.trim(),
            dataType: "markdown",
            parentID: docId
        };

        const resp = await siyuan.fetchSyncPost("/api/block/appendBlock", payload);
        if (resp.code !== 0) {
            throw new Error(`追加内容到文档失败: ${resp.msg || JSON.stringify(resp)}`);
        }
        return resp.data;
    }

    /**
     * 3. 编辑能力 B：原地精准替换选中的块内容
     */
    static async updateBlock(blockId, markdown) {
        if (!blockId) {
            throw new Error("未指定要替换的目标块 ID");
        }

        const payload = {
            id: blockId,
            dataType: "markdown",
            data: markdown.trim()
        };

        const resp = await siyuan.fetchSyncPost("/api/block/updateBlock", payload);
        if (resp.code !== 0) {
            throw new Error(`原地替换块失败: ${resp.msg || JSON.stringify(resp)}`);
        }
        return resp.data;
    }

    /**
     * 闭环能力：一键回填/覆盖更新整篇文档内容
     */
    static async updateDocContent(docId, markdown) {
        if (!docId || !markdown) {
            throw new Error("未指定要回填的目标文档 ID 或内容为空");
        }
        const cleanMd = markdown.replace(/^```(?:markdown)?\s*\n([\s\S]*?)\n```$/i, "$1").replace(/^---[\s\S]*?---\s*/, "").trim();
        const payload = {
            id: docId,
            dataType: "markdown",
            data: cleanMd
        };
        const resp = await siyuan.fetchSyncPost("/api/block/updateBlock", payload);
        if (resp.code !== 0) {
            throw new Error(`回填更新文档失败: ${resp.msg || JSON.stringify(resp)}`);
        }
        return resp.data;
    }

    /**
     * 智能分词与实体抽取（自动提取 IP、端口、中英文关键词与核心短语）
     */
    static extractSearchTokens(rawText) {
        if (!rawText || !rawText.trim()) return [];
        let text = rawText.replace(/^(?:帮我|请帮我|请问|我想|给我)?(?:查找|搜索|检索|搜一下|查一下|找一下|看一下|看下|搜下|查下|找下|翻一下|搜|查|找|看)?(?:一下|下|看)?(?:关于|有关)?\s*/i, "").trim();
        text = text.replace(/(?:相关信息|相关内容|相关的笔记|相关文档|相关记录|相关资料|的信息|的内容|的资料|笔记|文档)$/i, "").trim();

        const tokens = new Set();

        // 1. 优先提取 IP 及 IP:Port 实体 (如 10.252.216.13:30006)
        const ipMatches = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g);
        if (ipMatches) {
            ipMatches.forEach(ip => {
                tokens.add(ip);
                if (ip.includes(":")) tokens.add(ip.split(":")[0]);
            });
        }

        // 2. 提取连续英文/数字/代码标识符 (如 redis, token, k8s)
        const codeMatches = text.match(/[a-zA-Z0-9_\-\.]{3,}/g);
        if (codeMatches) {
            codeMatches.forEach(w => tokens.add(w));
        }

        // 3. 去除常用提问虚词后的核心短语
        const cleanPhrase = text.replace(/^(一下|下|看|点|些|关于|有关)/, "")
                                .replace(/(吗|吧|呢|呀|\?|？|是什么|是多少|在哪|怎么弄|怎么用|有哪些)$/, "")
                                .trim();
        if (cleanPhrase && cleanPhrase.length >= 2) tokens.add(cleanPhrase);

        // 4. 按“的”、“与”、“和”、空格断词，提取实体关键词
        const parts = text.split(/[的与和\s,，、:：/]+/).map(p => p.trim()).filter(p => p.length >= 2);
        parts.forEach(p => {
            if (!/^(密码|账号|地址|信息|配置|数据|怎么|什么)$/.test(p)) {
                tokens.add(p);
            }
        });

        // 5. 将完整文本作为候选
        if (text.length >= 2) tokens.add(text);

        return Array.from(tokens).filter(Boolean);
    }

    /**
     * 4. 搜索能力：多级智能分词 + 优先思源全文检索内核 + SQLite 综合保底 (按文档级 rootId 聚合去重)
     */
    static async searchNotes(keyword, limit = 8) {
        if (!keyword || !keyword.trim()) return [];

        const tokens = this.extractSearchTokens(keyword);
        const results = [];
        const seenDocIds = new Set();

        // 遍历提取的候选实体/关键词进行多轮匹配
        for (const token of tokens) {
            const cleanToken = token.trim().replace(/['"\\]/g, "");
            if (!cleanToken) continue;

            // 策略 1：调用思源官方全文检索引擎 (/api/search/fullTextSearchBlock)
            try {
                const ftResp = await siyuan.fetchSyncPost("/api/search/fullTextSearchBlock", { query: cleanToken });
                if (ftResp.code === 0 && Array.isArray(ftResp.data?.blocks)) {
                    for (const b of ftResp.data.blocks) {
                        const rootId = b.rootID || b.id;
                        // 按文档级别 (rootId) 进行排重，确保返回的每一篇都是不同的独立文档
                        if (seenDocIds.has(rootId)) continue;
                        seenDocIds.add(rootId);

                        const docTitle = b.ial?.title || (b.hPath ? b.hPath.split("/").filter(Boolean).pop() : "未命名文档");
                        const cleanContent = b.fcontent || (b.content ? b.content.replace(/<[^>]+>/g, "") : "") || b.markdown || "";

                        results.push({
                            id: b.id,
                            rootId: rootId,
                            content: cleanContent.trim(),
                            docTitle: docTitle,
                            hPath: b.hPath || "",
                            updated: b.updated || ""
                        });

                        if (results.length >= limit) break;
                    }
                }
            } catch (e) {
                console.warn("[SiYuanBridge] fullTextSearchBlock 检索异常:", e);
            }

            // 策略 2：SQLite SQL 模糊检索保底
            if (results.length < limit) {
                const sql = `
                    SELECT b.id, b.root_id, b.content, b.type, b.updated,
                           CASE WHEN b.type = 'd' THEN b.content ELSE COALESCE(r.content, '未命名文档') END as doc_title
                    FROM blocks b
                    LEFT JOIN blocks r ON b.root_id = r.id
                    WHERE b.content LIKE '%${cleanToken}%'
                    ORDER BY b.updated DESC
                    LIMIT 20
                `;

                try {
                    const resp = await siyuan.fetchSyncPost("/api/query/sql", { stmt: sql });
                    if (resp.code === 0 && Array.isArray(resp.data)) {
                        for (const item of resp.data) {
                            const rootId = item.root_id || item.id;
                            if (seenDocIds.has(rootId)) continue;
                            seenDocIds.add(rootId);

                            results.push({
                                id: item.id,
                                rootId: rootId,
                                content: (item.content || "").trim(),
                                docTitle: item.doc_title || "未命名文档",
                                hPath: "",
                                updated: item.updated || ""
                            });
                            if (results.length >= limit) break;
                        }
                    }
                } catch (e) {
                    console.error("[SiYuanBridge] SQL 搜索笔记保底失败:", e);
                }
            }

            // 只要匹配到了高精度的文档集就停止后续次级 token
            if (results.length >= 3) break;
        }

        // 补充所属章节与面包屑信息 (支持精准定位到章节)
        await Promise.all(results.map(async (item) => {
            if (item.id && item.rootId && item.id !== item.rootId) {
                try {
                    const bcResp = await siyuan.fetchSyncPost("/api/block/getBlockBreadcrumb", { id: item.id });
                    if (bcResp && bcResp.code === 0 && Array.isArray(bcResp.data)) {
                        const headings = bcResp.data.filter(b => b.type === "NodeHeading");
                        if (headings.length > 0) {
                            const validNames = headings.map(h => h.name || (h.id === item.id ? item.content : "")).filter(Boolean);
                            if (validNames.length > 0) {
                                item.section = validNames[validNames.length - 1];
                                item.sectionId = headings[headings.length - 1].id;
                                item.headingBreadcrumb = validNames.join(" > ");
                            }
                        }
                    }
                } catch (e) {
                    // 忽略面包屑获取异常
                }

                if (!item.section && item.type === "NodeHeading" && item.content) {
                    item.section = item.content;
                    item.sectionId = item.id;
                    item.headingBreadcrumb = item.content;
                }
            }
        }));

        // 若命中结果中正文为空或与标题重复，补充导出 Markdown 摘要
        for (const item of results) {
            if ((!item.content || item.content === item.docTitle) && item.rootId) {
                try {
                    const md = await this.getDocMarkdown(item.rootId);
                    if (md) {
                        const cleanMd = md.replace(/^---[\s\S]*?---\s*/, "").trim();
                        item.content = cleanMd.slice(0, 300);
                    }
                } catch (err) {}
            }
        }

        return results;
    }

    /**
     * 5. 上下文能力：读取文档 Markdown 正文
     */
    static async getDocMarkdown(docId) {
        if (!docId) return "";
        try {
            const resp = await siyuan.fetchSyncPost("/api/export/exportMdContent", { id: docId });
            if (resp.code === 0 && resp.data?.content) {
                return resp.data.content;
            }
        } catch (e) {
            console.error("[SiYuanBridge] 导出 Markdown 失败:", e);
        }
        return "";
    }

    /**
     * 6. 感知能力：获取当前活跃编辑器文档
     */
    static getActiveDocId() {
        if (typeof document === "undefined") return { docId: null, title: "" };
        const protyles = Array.from(document.querySelectorAll(".layout__center .protyle, .protyle"));
        for (const p of protyles) {
            if (p.closest(".fn__none") || p.classList.contains(".fn__none")) continue;
            const titleEl = p.querySelector(".protyle-title");
            const wysiwygEl = p.querySelector(".protyle-wysiwyg");
            const docId = titleEl?.getAttribute("data-node-id") || wysiwygEl?.getAttribute("data-node-id");
            if (docId && /^\d{14}-[a-z0-9]{7}$/.test(docId)) {
                const title = titleEl ? titleEl.innerText.trim() : "当前文档";
                return { docId, title };
            }
        }
        return { docId: null, title: "" };
    }

    /**
     * 感知能力：获取当前活跃文档所在的父级目录路径 (HPath)
     */
    static async getActiveDocDir() {
        const active = this.getActiveDocId();
        if (!active || !active.docId) return null;
        try {
            const resp = await siyuan.fetchSyncPost("/api/filetree/getHPathByID", { id: active.docId });
            if (resp.code === 0 && resp.data) {
                const parts = resp.data.split("/").filter(Boolean);
                if (parts.length > 1) {
                    return "/" + parts.slice(0, -1).join("/");
                }
                return "/";
            }
        } catch (e) {
            console.warn("[SiYuanBridge] 获取当前文档目录失败:", e);
        }
        return null;
    }

    /**
     * 感知能力：根据标题查找文档并获取完整 Markdown 内容
     */
    static async getDocByTitle(title) {
        if (!title) return null;
        const cleanTitle = title.replace(/[《》"']/g, "").trim();
        if (!cleanTitle) return null;

        try {
            const sql = `
                SELECT id, content 
                FROM blocks 
                WHERE type = 'd' AND content LIKE '%${cleanTitle}%' 
                ORDER BY CASE WHEN content = '${cleanTitle}' THEN 0 ELSE 1 END, updated DESC 
                LIMIT 1;
            `;
            const resp = await siyuan.fetchSyncPost("/api/query/sql", { stmt: sql });
            if (resp.code === 0 && Array.isArray(resp.data) && resp.data.length > 0) {
                const doc = resp.data[0];
                const md = await this.getDocMarkdown(doc.id);
                if (md) {
                    const cleanMd = md.replace(/^---[\s\S]*?---\s*/, "").trim();
                    return {
                        docId: doc.id,
                        title: doc.content || cleanTitle,
                        markdown: cleanMd,
                        charCount: cleanMd.length
                    };
                }
            }
        } catch (e) {
            console.warn("[SiYuanBridge] 根据标题获取文档失败:", e);
        }
        return null;
    }

    /**
     * 感知能力：获取当前正在编辑的文档及其完整 Markdown 内容
     */
    static async getActiveDoc() {
        // 1. 尝试从 DOM 编辑器感知
        const active = this.getActiveDocId();
        let docId = active.docId;
        let title = active.title;

        // 2. 若 DOM 未能获取（焦点在侧边栏），通过最近编辑块兜底
        if (!docId) {
            try {
                const sql = `
                    SELECT b.root_id, r.content as doc_title
                    FROM blocks b
                    LEFT JOIN blocks r ON b.root_id = r.id
                    WHERE b.type != 'd'
                    ORDER BY b.updated DESC
                    LIMIT 1;
                `;
                const resp = await siyuan.fetchSyncPost("/api/query/sql", { stmt: sql });
                if (resp.code === 0 && Array.isArray(resp.data) && resp.data.length > 0) {
                    docId = resp.data[0].root_id;
                    title = resp.data[0].doc_title || "当前文档";
                }
            } catch (err) {}
        }

        if (docId) {
            const md = await this.getDocMarkdown(docId);
            if (md) {
                const cleanMd = md.replace(/^---[\s\S]*?---\s*/, "").trim();
                return {
                    docId,
                    title: title || "当前文档",
                    markdown: cleanMd,
                    charCount: cleanMd.length
                };
            }
        }
        return null;
    }

    /**
     * 7. 感知能力：获取当前划选文本与对应的 Block ID (支持原地替换)
     */
    static getSelectedBlock() {
        if (typeof window === "undefined" || typeof document === "undefined") return null;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;
        const text = selection.toString().trim();
        if (!text) return null;

        const range = selection.getRangeAt(0);
        let node = range.commonAncestorContainer;
        if (node.nodeType === 3) node = node.parentElement;

        const blockEl = node.closest("[data-node-id]");
        const blockId = blockEl ? blockEl.getAttribute("data-node-id") : null;

        return {
            text,
            blockId
        };
    }

    static getSelectedText() {
        const b = this.getSelectedBlock();
        return b ? b.text : "";
    }

    /**
     * 8. 导航能力：一键在思源主编辑器中打开并跳转到指定文档或块 (支持精准定位到章节/段落并高亮)
     */
    static openDocument(targetId, app, action) {
        if (!targetId) return;
        const defaultActions = action || ["cb-get-hl", "cb-get-focus", "cb-get-context"];
        try {
            if (typeof siyuan !== "undefined" && typeof siyuan.openTab === "function") {
                siyuan.openTab({
                    app: app || (typeof window !== "undefined" ? window.siyuan : null),
                    doc: {
                        id: targetId,
                        action: defaultActions
                    }
                });
                return;
            }
        } catch (e) {
            console.warn("[SiYuanBridge] openTab 异常，降级尝试 URL scheme:", e);
        }

        try {
            if (typeof window !== "undefined") {
                window.location.href = `siyuan://blocks/${targetId}`;
            }
        } catch (err) {
            console.error("[SiYuanBridge] 打开文档失败:", err);
        }
    }
}

// ==========================================
// 4. 飞书卡片与 CLI 桥接模块
// ==========================================
class FeishuBridge {
    /**
     * 模式一：通过飞书自定义机器人 Webhook 一键将内容推送到飞书群聊
     */
    static async sendToWebhook(webhookUrl, title, markdownContent) {
        if (!webhookUrl) {
            throw new Error("请先在设置中配置飞书机器人 Webhook 地址！");
        }

        // 构造飞书支持的富文本卡片消息
        const payload = {
            msg_type: "interactive",
            card: {
                header: {
                    title: {
                        tag: "plain_text",
                        content: `📄 ${title || "AI 创作成果分享"}`
                    },
                    template: "blue"
                },
                elements: [
                    {
                        tag: "markdown",
                        content: markdownContent.slice(0, 3000) // 截断防超限
                    },
                    {
                        tag: "note",
                        elements: [
                            {
                                tag: "plain_text",
                                content: `💡 来自思源笔记 · AI 创作工坊 (${new Date().toLocaleString()})`
                            }
                        ]
                    }
                ]
            }
        };

        const resp = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const res = await resp.json();
        if (res.code !== 0 && res.StatusCode !== 0) {
            throw new Error(`飞书推送失败: ${res.msg || JSON.stringify(res)}`);
        }
        return res;
    }

    /**
     * 模式二：通过本地飞书 CLI 工具或自定义 Shell 命令进行深度扩展
     * 支持在配置中定义命令模板，如: feishu doc create --title "{title}" --file "{tmp_file}"
     */
    static async executeCliCommand(cliTemplate, title, markdownContent) {
        if (!cliTemplate) {
            throw new Error("请在设置中配置飞书 CLI 执行命令模板");
        }

        return new Promise((resolve, reject) => {
            // 将双引号与特殊字符转义
            const escapedTitle = (title || "创作文档").replace(/"/g, '\\"');
            const cleanContent = markdownContent.replace(/"/g, '\\"').replace(/\$/g, '\\$');

            const command = cliTemplate
                .replace(/{title}/g, escapedTitle)
                .replace(/{content}/g, cleanContent);

            console.log("[FeishuBridge] 执行 CLI 命令:", command);

            exec(command, { timeout: 15000 }, (error, stdout, stderr) => {
                if (error) {
                    console.error("[FeishuBridge] CLI 执行出错:", error, stderr);
                    reject(new Error(`CLI 执行失败: ${stderr || error.message}`));
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }
}

// ==========================================
// 5. 意图识别与自动执行引擎
// ==========================================
/**
 * ==============================================================================
 * IntentEngine (意图识别与自动执行引擎)
 * 纯自然语言驱动 · 无需用户手动点击按钮 · 全自动识别意图并调用思源内核能力
 * ==============================================================================
 */
class IntentEngine {
    /**
     * 第一阶段：发送前分析与前置动作 (Pre-flight Analysis)
     */
    static async preProcess(userText, siyuanBridge, options = {}) {
        const text = (userText || "").trim();
        const preResult = {
            originalText: text,
            augmentedText: text,
            intents: [],
            capturedBlock: null,
            searchResults: [],
            badges: [],
            isDirectAction: false,
            directResponse: ""
        };

        const lastAssistantMsg = (options.lastAssistantMessage || "").trim();

        // 0. 特殊高频意图：多轮对话中的纯操作指令（如用户在上一轮生成后说“更新到笔记中”、“存入笔记”、“保存为新文档”）
        const isFollowUpSave = /^(?:请?帮我)?(?:把(?:上面|刚才|这个|这些|此前)?(?:的内容|方案|文章|总结|结果)?)?(?:更新|保存|存|写入?|追加|记|同步)(?:到|进|入|成)?(?:思源)?(?:我的)?(?:当前)?(?:笔记|文档)(?:中|里|末尾)?$/i.test(text);

        if (isFollowUpSave && lastAssistantMsg) {
            const cleanLastMd = this.extractPureMarkdown(lastAssistantMsg);
            const active = siyuanBridge.getActiveDocId ? siyuanBridge.getActiveDocId() : { docId: null };

            // 若用户指定“当前”或当前有打开的文档且命令含“更新/追加”，则追加写入当前文档
            const prefersAppend = /(?:当前|追加|写入当前)/i.test(text) || (active.docId && /(?:更新到|加到)/i.test(text));

            if (prefersAppend && active.docId) {
                try {
                    await siyuanBridge.appendToDoc(active.docId, cleanLastMd);
                    preResult.isDirectAction = true;
                    preResult.badges.push(`📝 已自动追加到当前文档《${active.title}》末尾`);
                    preResult.directResponse = `🎉 **已自动更新到当前文档！**\n\n已将上方生成的内容无缝追加到正在编辑的思源文档《${active.title}》末尾。`;
                    return preResult;
                } catch (err) {
                    console.warn("[IntentEngine] 追加失败，降级为新建笔记:", err);
                }
            }

            // 否则默认将上一轮生成的内容创建为思源新文档
            try {
                const title = this.extractTitle(cleanLastMd, "AI创作记录");
                let targetDir = this.extractTargetDir(text);
                if (targetDir === "__CURRENT__") {
                    targetDir = await siyuanBridge.getActiveDocDir();
                }
                const finalPathPrefix = targetDir || options.notePathPrefix || "/AI创作";
                const res = await siyuanBridge.createDocWithMd(
                    title,
                    cleanLastMd,
                    options.defaultNotebook,
                    finalPathPrefix
                );
                preResult.isDirectAction = true;
                preResult.badges.push(`📄 已自动创建并存入思源新笔记: 《${res.title}》`);
                preResult.directResponse = `🎉 **已自动存入思源笔记！**\n\n已成功将上方内容保存为思源新文档：\n- 📄 **文档标题**：《${res.title}》\n- 📁 **存储路径**：\`${res.path}\`\n\n你可以在思源左侧笔记本列表中即刻查看与继续编辑。`;
                return preResult;
            } catch (err) {
                console.error("[IntentEngine] 自动保存笔记失败:", err);
            }
        }

        // 0.1 目录创建功能询问（如用户问“是否支持指定目录下创建”、“怎么指定目录创建”）
        const isDirMetaQuery = /(?:是否|能不?能|怎么|如何|可以)?(?:支持)?(?:指定|存到|保存在|新建在)?(?:哪个|什么|哪里|具体)?(?:目录|文件夹|路径)(?:下|里)?(?:创建|新建|写|保存|存)/i.test(text);
        if (isDirMetaQuery && !/(?:写一篇|新建|帮我写)/i.test(text)) {
            preResult.isDirectAction = true;
            preResult.badges.push(`📁 支持自由指定目录创建笔记`);
            preResult.directResponse = `🎉 **完全支持！你可以通过以下 3 种方式自由指定创建目录：**

1. **对话中自然语言直接指定（推荐）**：
   - *“写一篇关于 Docker 核心概念的文章，**保存到 /技术文档/容器 目录下**”*
   - *“在 **\`/CESTC工作空间/本体\` 下** 新建一篇笔记《环境配置手册》”*
   - *“写一篇本周总结，**存到 工作记录/周报 目录**”*

2. **相对当前编辑文档创建（上下文感知）**：
   - 如果你在思源中正打开某篇文档，直接说：
   - *“写一篇架构方案，**存到当前目录下**”*
   - 系统会自动感知你当前文档所在的父级目录并对齐存放。

3. **插件设置面板全局配置**：
   - 在思源插件设置面板中，可以配置默认存放路径（默认为 \`/AI创作\`）；
   - 如果你在对话中未明确指定目录，系统将自动存入此默认目录。

💡 **格式优势**：系统严格遵循自然语义纯净路径规范，**坚决不插入乱码与冗余日期前缀**，如果父级目录不存在会自动无感创建！`;
            return preResult;
        }

        // 0.1 搜索功能询问（如用户问“无法搜索吗”、“怎么搜笔记”、“能搜索吗”）
        const isSearchMetaQuery = /^(?:无法|不能|怎么|如何|为什么不?能?|是否支持|可以)(?:进行|去)?(?:搜索|检索|查笔记|查文档)/i.test(text) ||
                                  /^(?:无法|不能)搜索吗/i.test(text);

        if (isSearchMetaQuery) {
            preResult.isDirectAction = true;
            preResult.badges.push(`💡 全库检索功能完全就绪`);
            preResult.directResponse = `🔍 **思源 AI 副驾驶已完全支持全库检索与知识库 RAG！**\n\n你可以随时直接用自然语言搜索，例如：\n• **『搜一下 我的自我介绍』**\n• **『查一下 分布式架构 笔记』**\n• **『知识库里有没有关于 Docker 的记录』**\n\n系统会自动调度思源全文检索内核与本地数据库，秒级提取匹配的文档与正文段落！`;
            return preResult;
        }

        // 1. 默认感知当前正在打开的文档与选区 (Active Doc as Default Context)
        const activeDoc = siyuanBridge.getActiveDoc ? await siyuanBridge.getActiveDoc() : null;
        if (activeDoc) {
            preResult.activeDoc = activeDoc;
        }

        const selected = siyuanBridge.getSelectedBlock ? siyuanBridge.getSelectedBlock() : null;
        const isDocProcessIntent = /(?:润色|优化|总结|概括|改写|重写|重构|翻译|缩短|扩写|精简|提炼|审查|检查错别字|分析|拆解)/i.test(text) ||
                                   /(?:这篇|这篇文档|这篇笔记|这篇文章|当前文档|当前笔记|文稿|原文|此篇)/i.test(text);

        if (selected && selected.text && selected.text.length > 3) {
            preResult.capturedBlock = selected;
            preResult.intents.push("replace_block");
            preResult.badges.push(`✂️ 已感知划选段落: "${selected.text.slice(0, 18)}..." (${selected.text.length}字)`);
            preResult.augmentedText = `【当前思源编辑器中划选的原文段落】：\n\`\`\`text\n${selected.text}\n\`\`\`\n\n【用户修改指令】：\n${text}\n\n（请务必直接基于上述划选原文进行修改与润色，直接输出最终正文成稿）`;
        } else {
            // 检查是否提到了特定文档标题（如《书名号》）
            let targetDoc = null;
            const mentionedTitle = this.extractMentionedTitle(text);
            if (mentionedTitle && siyuanBridge.getDocByTitle) {
                targetDoc = await siyuanBridge.getDocByTitle(mentionedTitle);
            }

            // 默认回退到当前打开的文档
            if (!targetDoc && activeDoc) {
                targetDoc = activeDoc;
            }

            if (targetDoc && targetDoc.markdown) {
                preResult.contextDoc = targetDoc;
                if (isDocProcessIntent) {
                    preResult.intents.push("process_doc");
                    preResult.badges.push(`📄 已载入当前文档《${targetDoc.title}》（共 ${targetDoc.charCount} 字）`);
                    preResult.augmentedText = `【当前思源主编辑区正在打开的文档《${targetDoc.title}》全文内容】：\n\`\`\`markdown\n${targetDoc.markdown}\n\`\`\`\n\n【用户指令】：\n${text}\n\n（请务必直接基于上述文档的完整原文进行处理，直接给出润色/修改/分析后的高质量完整结果，不要回复未收到文章或要求用户粘贴）`;
                } else if (!/(?:搜|查|找|检索|写一篇|新建|生成一篇)/i.test(text)) {
                    // 若是针对当前打开文档的提问或探讨，默认注入当前文档为背景上下文
                    preResult.badges.push(`📌 已连通当前文档: 《${targetDoc.title}》`);
                    preResult.augmentedText = `【参考背景：思源当前打开文档《${targetDoc.title}》】：\n\`\`\`markdown\n${targetDoc.markdown.slice(0, 15000)}\n\`\`\`\n\n【用户问题】：\n${text}\n\n（若问题与当前打开的文档相关，请直接根据上述文档内容精准作答）`;
                }
            }
        }

        // 2. 搜索/检索意图分析 (RAG 知识库检索)
        const isSearchIntent = /(?:搜|查|找|检索|看下|查查|搜索|翻一下)(?:一下|下|看)?(?:关于|有关)?\s*(.+?)(?:的)?(?:笔记|文档|记录|内容|知识)?$/i.test(text) ||
                               /(?:我之前|库里|知识库(?:里)?)(?:有没有|记录的|写的)\s*(.+)/i.test(text) ||
                               /^(?:帮我)?(?:搜|查|找|检索|搜索)\s*(.+)/i.test(text);

        if (isSearchIntent) {
            let kw = "";
            const m1 = text.match(/(?:搜|查|找|检索|看下|查查|搜索|翻一下)(?:一下|下|看)?(?:关于|有关)?\s*(.+?)(?:的)?(?:笔记|文档|记录|内容|知识)?$/i);
            const m2 = text.match(/(?:我之前|库里|知识库(?:里)?)(?:有没有|记录的|写的)\s*(.+)/i);
            const m3 = text.match(/^(?:帮我)?(?:搜|查|找|检索|搜索)\s*(.+)/i);
            if (m1 && m1[1]) kw = m1[1].trim();
            else if (m2 && m2[1]) kw = m2[1].trim();
            else if (m3 && m3[1]) kw = m3[1].trim();

            kw = kw.replace(/^(一下|下|看|点|些|下关于|关于)/, "").replace(/(吗|吧|呢|呀|\?|？)$/, "").trim();

            if (kw && kw.length >= 1) {
                preResult.intents.push("search_notes");
                try {
                    // 使用智能分词与实体抽取全库检索
                    const notes = await siyuanBridge.searchNotes(text, 6);
                    
                    // 判断是否是具体问答类请求（如问密码、账号、配置、如何做等）
                    const isQuestion = /(?:密码|账号|用户名|地址|端口|配置|怎么|如何|是什么|是多少|在哪|谁|为什么|为啥|总结|概括|分析)/i.test(text);

                    if (notes && notes.length > 0) {
                        preResult.searchResults = notes;
                        const docTitles = Array.from(new Set(notes.map(n => `《${n.docTitle}》`))).slice(0, 3).join("、");
                        preResult.badges.push(`🔍 已检索到知识库笔记: ${docTitles}`);

                        if (isQuestion) {
                            // 问答类 RAG：将检索出的真实笔记精准注入上下文，由大模型为用户直接提取并回答答案（如直接告知数据库密码）
                            const knowledgeSnippet = notes.map((n, idx) => `[参考笔记 ${idx + 1}] 来源文档《${n.docTitle}》${n.hPath ? `(路径: ${n.hPath})` : ''}${n.section ? `(所属章节: ${n.section})` : ''}:\n${n.content}`).join("\n\n");
                            preResult.augmentedText = `【思源知识库自动检索结果】：\n${knowledgeSnippet}\n\n【用户问题】：\n${text}\n\n（请务必直接根据上述思源笔记检索到的真实内容，准确回答用户的问题，直接给出对应的密码、账号或信息，并标明出自哪篇文档与章节）`;
                        } else {
                            // 纯文档查找类：极简轻量卡片，标题独占单行，下划线超链接定位，消除拥挤感
                            preResult.isDirectAction = true;
                            let cardsHtml = notes.map((n, i) => {
                                const docId = n.rootId || n.id;
                                const isSubBlock = n.id && n.rootId && n.id !== n.rootId;
                                const pathStr = n.hPath ? `<div class="ai-search-doc-path">📁 路径：${n.hPath}</div>` : '';
                                
                                let sectionHtml = "";
                                if (n.headingBreadcrumb || n.section) {
                                    const secText = n.headingBreadcrumb || n.section;
                                    sectionHtml = `
                                        <div class="ai-search-doc-section">
                                            📌 定位章节：<span class="ai-text-link" data-block-id="${n.id}" title="点击直接定位到此章节并高亮">${secText}</span>
                                            <span class="ai-text-divider">·</span>
                                            <span class="ai-text-link ai-link-muted" data-doc-id="${docId}" title="在主编辑区打开全文">打开全文</span>
                                        </div>
                                    `;
                                } else {
                                    sectionHtml = `
                                        <div class="ai-search-doc-section">
                                            👉 <span class="ai-text-link" data-doc-id="${docId}" title="在主编辑区打开该文档">打开此文档全文</span>
                                        </div>
                                    `;
                                }

                                const snippetStr = n.content ? `<div class="ai-search-doc-snippet">${n.content.slice(0, 150)}...</div>` : '';

                                return `
                                <div class="ai-search-card">
                                    <div class="ai-search-card-title">
                                        <span class="ai-doc-jump-link" data-doc-id="${docId}" title="点击在主编辑区打开文档全文"><b>${i + 1}. 📄 《${n.docTitle}》</b></span>
                                    </div>
                                    ${pathStr}
                                    ${sectionHtml}
                                    ${snippetStr}
                                </div>
                                `.trim();
                            }).join("");

                            preResult.directResponse = `🔍 <b>已在你的思源知识库中检索到相关文档：</b><div class="ai-search-cards-box">${cardsHtml}</div><div style="font-size: 11px; opacity: 0.75; margin-top: 10px;">💡 提示：点击下划线章节名称可直接跳转并高亮定位；点击文档标题或“打开全文”可查看整篇笔记。</div>`;
                            return preResult;
                        }
                    } else {
                        // 未检索到文档时：注入提示词让大模型温和如实作答，绝不中断交互或硬编码报错
                        preResult.augmentedText = `【思源知识库检索状态】：已全库检索“${text}”，但知识库中暂未找到完全匹配的段落或文档。\n\n【用户问题】：\n${text}\n\n（请温和告知用户当前思源笔记中未检索到该关键词的直接记录，并建议用户检查搜索关键词或提供通用指导）`;
                    }
                } catch (e) {
                    console.warn("[IntentEngine] 自动检索笔记失败:", e);
                }
            }
        }

        // 3. 记录新建笔记或追加意图 (待生成完成后执行 PostAction)
        const specifiedDir = this.extractTargetDir(text);
        const isCreateIntent = !!specifiedDir ||
                               /(?:保存|存|新建|生成|更新|写入?|记录)(?:为|成|到|进|入|一篇)?(?:思源)?(?:新)?(?:笔记|文档|文章)/i.test(text) ||
                               /存入?(?:笔记|文档|思源|库)|更新到(?:思源)?(?:笔记|文档)/i.test(text) ||
                               /(?:帮我)?(?:写|创作|总结|生成).*?(?:并)?(?:保存|存起来|存入|存到|保存在|更新)/i.test(text);
        if (isCreateIntent) {
            preResult.intents.push("create_note");
            if (specifiedDir) {
                preResult.badges.push(`📁 目标目录: ${specifiedDir === "__CURRENT__" ? "当前文档同级" : specifiedDir}`);
            }
        }

        const isAppendIntent = /(?:追加|插入|加到|写入|更新到)(?:到)?(?:当前|这篇)?(?:文档|笔记)(?:末尾|后面|中)?/i.test(text);
        if (isAppendIntent) {
            preResult.intents.push("append_doc");
        }

        const isFeishuIntent = /(?:发送|分享|推送|同步)(?:到)?飞书/i.test(text);
        if (isFeishuIntent) {
            preResult.intents.push("share_feishu");
        }

        return preResult;
    }

    /**
     * 第二阶段：生成完成后的后置动作 (Post-Action Execution)
     */
    static async postProcess(aiResponse, preResult, siyuanBridge, feishuBridge, settings = {}) {
        const executedActions = [];
        const content = aiResponse.trim();
        if (!content) return executedActions;

        const cleanMd = this.extractPureMarkdown(content);
        const { intents, capturedBlock, originalText } = preResult;

        // 1. 自动执行：原地替换选中块 (最高优先级)
        if (intents.includes("replace_block") && capturedBlock && capturedBlock.blockId) {
            try {
                await siyuanBridge.updateBlock(capturedBlock.blockId, cleanMd);
                executedActions.push({
                    type: "replace_block",
                    success: true,
                    message: "⚡ 已自动原地替换当前选中的笔记段落"
                });
            } catch (e) {
                executedActions.push({
                    type: "replace_block",
                    success: false,
                    message: `原地替换失败: ${e.message}`
                });
            }
        }

        // 2. 自动执行：追加到当前文档末尾
        if (intents.includes("append_doc")) {
            try {
                const active = siyuanBridge.getActiveDocId ? siyuanBridge.getActiveDocId() : { docId: null };
                if (active.docId) {
                    await siyuanBridge.appendToDoc(active.docId, cleanMd);
                    executedActions.push({
                        type: "append_doc",
                        success: true,
                        message: `📝 已自动追加到当前文档《${active.title}》末尾`
                    });
                }
            } catch (e) {
                console.warn("[IntentEngine] 追加到当前文档失败:", e);
            }
        }

        // 3. 自动执行：创建思源新文档 (支持自然语言指定目录与无日期纯净路径)
        if (intents.includes("create_note") && !intents.includes("append_doc")) {
            try {
                const title = this.extractTitle(cleanMd, originalText);
                let targetDir = this.extractTargetDir(originalText);
                if (targetDir === "__CURRENT__") {
                    targetDir = await siyuanBridge.getActiveDocDir();
                }
                const finalPathPrefix = targetDir || settings.notePathPrefix || "/AI创作";
                const res = await siyuanBridge.createDocWithMd(
                    title,
                    cleanMd,
                    settings.defaultNotebook,
                    finalPathPrefix
                );
                executedActions.push({
                    type: "create_note",
                    success: true,
                    docPath: res.path,
                    message: `📄 已自动存入思源笔记: 《${res.title}》 (路径: \`${res.path}\`)`
                });
            } catch (e) {
                executedActions.push({
                    type: "create_note",
                    success: false,
                    message: `自动创建笔记失败: ${e.message}`
                });
            }
        }

        // 4. 自动执行：飞书群聊推送
        if (intents.includes("share_feishu")) {
            try {
                const title = this.extractTitle(cleanMd, originalText);
                if (settings.feishuWebhook) {
                    await feishuBridge.sendToWebhook(settings.feishuWebhook, title, cleanMd);
                    executedActions.push({
                        type: "share_feishu",
                        success: true,
                        message: `🚀 已自动同步推送至飞书群聊`
                    });
                } else if (settings.feishuCliTemplate) {
                    await feishuBridge.executeCliCommand(settings.feishuCliTemplate, title, cleanMd);
                    executedActions.push({
                        type: "share_feishu",
                        success: true,
                        message: `🚀 飞书 CLI 命令已自动执行`
                    });
                }
            } catch (e) {
                executedActions.push({
                    type: "share_feishu",
                    success: false,
                    message: `飞书同步失败: ${e.message}`
                });
            }
        }

        return executedActions;
    }

    /**
     * 智能提取用户指令中指定的目标目录或路径
     */
    static extractTargetDir(text) {
        if (!text) return null;

        // 0. 特殊指代：当前目录 / 当前文档同级
        if (/(?:当前|这篇)(?:文档|笔记)?(?:所在)?(?:目录|路径|文件夹|同级)/i.test(text)) {
            return "__CURRENT__";
        }

        // 1. 明确匹配：存到/保存在/放在/写到 /xxx/yyy 目录下/文件夹下/路径/下/里
        const m1 = text.match(/(?:保存|存|放|建|写入?|写一篇.*并存)(?:到|在|入|进)?\s*([/a-zA-Z0-9_\u4e00-\u9fa5]+(?:\/[a-zA-Z0-9_\u4e00-\u9fa5]+)*)\s*(?:目录|文件夹|路径|下|里)/i);
        if (m1 && m1[1]) {
            let p = m1[1].trim();
            const ignoreList = ["笔记", "文档", "思源", "知识库", "库", "新笔记", "新文档", "文章"];
            if (!ignoreList.includes(p)) {
                if (!p.startsWith("/")) p = "/" + p;
                return p.replace(/\/+$/, "");
            }
        }

        // 2. 明确匹配：在 /xxx/yyy 目录下/下 新建/写/创建
        const m2 = text.match(/(?:在|于)\s*([/a-zA-Z0-9_\u4e00-\u9fa5]+(?:\/[a-zA-Z0-9_\u4e00-\u9fa5]+)*)\s*(?:目录|文件夹|路径|下|里)?\s*(?:新建|创建|写|保存|生成)/i);
        if (m2 && m2[1]) {
            let p = m2[1].trim();
            const ignoreList = ["笔记", "文档", "思源", "知识库", "库", "新笔记", "新文档", "文章"];
            if (!ignoreList.includes(p)) {
                if (!p.startsWith("/")) p = "/" + p;
                return p.replace(/\/+$/, "");
            }
        }

        // 3. 显式路径格式：/xxx/yyy
        const m3 = text.match(/\s(\/[a-zA-Z0-9_\u4e00-\u9fa5]+(?:\/[a-zA-Z0-9_\u4e00-\u9fa5]+)+)\s*/);
        if (m3 && m3[1]) {
            return m3[1].trim().replace(/\/+$/, "");
        }

        return null;
    }

    /**
     * 提取用户文本中提到的文档标题（支持《书名号》或自然提及）
     */
    static extractMentionedTitle(text) {
        if (!text) return null;
        const m1 = text.match(/《([^》]+)》/);
        if (m1 && m1[1]) return m1[1].trim();

        const m2 = text.match(/(?:润色|总结|优化|翻译|重写|分析|提炼|修改|看看)\s*(?:关于|针对|一下|下)?\s*([a-zA-Z0-9_\u4e00-\u9fa5\s-]+?)(?:这篇|这本|文档|笔记|文章|$)/i);
        if (m2 && m2[1]) {
            const candidate = m2[1].trim();
            const ignoreList = ["这篇", "这篇文章", "这篇文档", "当前", "当前文档", "当前笔记", "内容", "文本", "段落", "这个", "那篇", "一下", "选区", "笔记", "文档", "文章"];
            if (!ignoreList.includes(candidate) && candidate.length >= 2) {
                return candidate;
            }
        }
        return null;
    }

    /**
     * 提取纯净的 Markdown 正文，移除可能的对话前导寒暄
     */
    static extractPureMarkdown(rawText) {
        let text = rawText.trim();
        const fenceMatch = text.match(/^```(?:markdown)?\s*\n([\s\S]*?)\n```$/i);
        if (fenceMatch && fenceMatch[1]) {
            return fenceMatch[1].trim();
        }
        return text;
    }

    /**
     * 智能提取文档标题
     */
    static extractTitle(markdown, userText) {
        const h1Match = markdown.match(/^#\s+(.+)$/m);
        if (h1Match && h1Match[1]) {
            return h1Match[1].replace(/[\/:*?"<>|]/g, "").trim().slice(0, 40);
        }

        const promptMatch = userText.match(/(?:写|创作|总结|生成)(?:一篇)?(?:关于)?\s*(.+?)(?:的)?(?:文章|笔记|指南|方案|总结)/i);
        if (promptMatch && promptMatch[1]) {
            return promptMatch[1].replace(/[\/:*?"<>|]/g, "").trim().slice(0, 30);
        }

        const firstLine = markdown.split("\n").map(l => l.trim()).find(l => l.length > 0) || "AI创作记录";
        return firstLine.replace(/^[#\s*`>]+/, "").replace(/[\/:*?"<>|]/g, "").trim().slice(0, 30);
    }
}

// ==========================================
// 6. SVG 矢量图标定义
// ==========================================
const SVG_ICONS = `
<symbol id="iconAIStudio" viewBox="0 0 24 24">
    <path fill="currentColor" d="M12 2L9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2z"/>
</symbol>
<symbol id="iconSparkles" viewBox="0 0 24 24">
    <path fill="currentColor" d="M12 2L9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2z"/>
</symbol>
`;

// ==========================================
// 7. 内联自愈样式表 (防思源内核样式加载延迟)
// ==========================================
const INLINE_CSS = `/* ==============================================================================
   SiYuan AI Studio (AI 创作工坊) 原生样式表
   极简现代设计 · 输入框下方主流模型配置排版
   ============================================================================== */

.ai-studio-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
    color: var(--b3-theme-on-surface);
    background-color: var(--b3-theme-background);
    overflow: hidden;
    font-size: 13px;
    flex: 1;
}

/* 顶部精简导航条 */
.ai-studio-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--b3-theme-surface-lighter);
    background-color: var(--b3-theme-surface);
    flex-shrink: 0;
}

.ai-studio-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--b3-theme-on-surface);
    display: flex;
    align-items: center;
    gap: 6px;
    opacity: 0.9;
}

.ai-studio-btn-icon {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    color: var(--b3-theme-on-surface-light);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
}

.ai-studio-btn-icon:hover {
    background-color: var(--b3-theme-surface-lighter);
    color: var(--b3-theme-on-surface);
}

/* 上下文感知常驻状态条 */
.ai-context-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background-color: var(--b3-theme-surface, rgba(0, 0, 0, 0.02));
    border-bottom: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.06));
    font-size: 11.5px;
    color: var(--b3-theme-on-surface);
    transition: all 0.2s ease;
    flex-shrink: 0;
    gap: 8px;
}

.ai-context-left {
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
}

.ai-context-indicator {
    width: 6.5px;
    height: 6.5px;
    border-radius: 50%;
    background-color: #94a3b8;
    flex-shrink: 0;
    transition: background-color 0.2s ease, box-shadow 0.2s ease;
}

.ai-context-bar.active .ai-context-indicator {
    background-color: #10b981;
    box-shadow: 0 0 6px rgba(16, 185, 129, 0.4);
}

.ai-context-name {
    font-weight: 500;
    color: var(--b3-theme-on-surface);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
}

.ai-context-name:hover {
    color: var(--b3-theme-primary);
    text-decoration: underline;
}

.ai-context-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}

.ai-context-stat {
    font-size: 11px;
    opacity: 0.65;
}

.ai-context-btn {
    background: transparent;
    border: none;
    color: var(--b3-theme-on-surface);
    opacity: 0.7;
    cursor: pointer;
    font-size: 11px;
    padding: 1px 4px;
    border-radius: 3px;
    transition: all 0.15s ease;
}

.ai-context-btn:hover {
    opacity: 1;
    background: rgba(0, 0, 0, 0.05);
}

/* 消息流滚动区域 */
.ai-studio-chat-box {
    flex: 1;
    overflow-y: auto;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 14px;
}

/* 消息气泡 */
.ai-msg {
    display: flex;
    flex-direction: column;
    max-width: 95%;
    animation: fadeIn 0.15s ease-in-out;
}

@keyframes fadeIn {
    from { opacity: 0; transform: translateY(3px); }
    to { opacity: 1; transform: translateY(0); }
}

.ai-msg.user {
    align-self: flex-end;
}

.ai-msg.assistant {
    align-self: flex-start;
    width: 100%;
}

.ai-msg-bubble {
    padding: 9px 13px;
    border-radius: 9px;
    line-height: 1.6;
    word-break: break-word;
    font-size: 13px;
}

.ai-msg.user .ai-msg-bubble {
    background-color: var(--b3-theme-primary);
    color: #ffffff;
    border-bottom-right-radius: 2px;
}

.ai-msg.assistant .ai-msg-bubble {
    background-color: var(--b3-theme-surface);
    border: 1px solid var(--b3-theme-surface-lighter);
    color: var(--b3-theme-on-surface);
    border-bottom-left-radius: 2px;
}

.ai-msg.assistant .ai-msg-bubble pre {
    background-color: rgba(0, 0, 0, 0.22);
    padding: 8px 12px;
    border-radius: 6px;
    overflow-x: auto;
    font-family: Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
    margin: 8px 0;
}

.ai-msg.assistant .ai-msg-bubble code {
    font-family: Menlo, monospace;
    font-size: 12px;
    background: rgba(125, 125, 125, 0.12);
    padding: 2px 4px;
    border-radius: 4px;
}

/* AI 底部功能动作条与自动意图徽标 */
.ai-msg-footer {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    flex-wrap: wrap;
}

.ai-auto-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    padding: 3px 9px;
    border-radius: 6px;
    background-color: var(--b3-theme-surface-lighter);
    color: var(--b3-theme-on-surface);
    border: 1px solid var(--b3-theme-surface-lighter);
    line-height: 1.4;
    user-select: none;
    animation: fadeIn 0.2s ease-out;
}

.ai-auto-badge.success {
    background-color: rgba(16, 185, 129, 0.12);
    color: #10b981;
    border-color: rgba(16, 185, 129, 0.25);
    font-weight: 500;
}

.ai-auto-badge.info {
    background-color: rgba(59, 130, 246, 0.1);
    color: #3b82f6;
    border-color: rgba(59, 130, 246, 0.2);
}

.ai-auto-badge.warn {
    background-color: rgba(245, 158, 11, 0.1);
    color: #f59e0b;
    border-color: rgba(245, 158, 11, 0.2);
}

/* 知识库检索结果卡片与一键跳转打开 */
.ai-search-cards-box {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 10px 0;
}

.ai-search-card {
    background-color: var(--b3-theme-surface, rgba(0, 0, 0, 0.02));
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.08));
    border-radius: 8px;
    padding: 10px 13px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    transition: all 0.15s ease;
}

.ai-search-card:hover {
    border-color: var(--b3-theme-primary);
    background-color: var(--b3-theme-surface-lighter, rgba(0, 0, 0, 0.03));
}

.ai-search-card-title {
    width: 100%;
    line-height: 1.4;
    margin-bottom: 1px;
}

.ai-doc-jump-link {
    color: var(--b3-theme-primary);
    font-weight: 600;
    cursor: pointer;
    font-size: 13.5px;
    text-decoration: none;
    transition: opacity 0.15s ease;
    word-break: break-word;
}

.ai-doc-jump-link:hover {
    text-decoration: underline;
    opacity: 0.85;
}

.ai-search-doc-path {
    font-size: 11.5px;
    color: var(--b3-theme-on-surface);
    opacity: 0.65;
    word-break: break-all;
}

.ai-search-doc-section {
    font-size: 12px;
    color: var(--b3-theme-on-surface);
    line-height: 1.45;
    margin: 1px 0;
}

.ai-text-link {
    color: var(--b3-theme-primary);
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
    font-weight: 500;
    transition: opacity 0.15s ease;
}

.ai-text-link:hover {
    opacity: 0.75;
}

.ai-link-muted {
    color: var(--b3-theme-on-surface);
    opacity: 0.7;
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
}

.ai-link-muted:hover {
    color: var(--b3-theme-primary);
    opacity: 1;
}

.ai-text-divider {
    color: var(--b3-theme-on-surface);
    opacity: 0.35;
    margin: 0 4px;
}

.ai-search-doc-snippet {
    font-size: 11.5px;
    color: var(--b3-theme-on-surface);
    opacity: 0.85;
    background: rgba(0, 0, 0, 0.03);
    border-left: 2px solid var(--b3-theme-primary);
    padding: 5px 8px;
    border-radius: 3px;
    line-height: 1.45;
    word-break: break-all;
    margin-top: 2px;
}

.ai-action-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 5px;
    border: 1px solid var(--b3-theme-surface-lighter);
    background-color: var(--b3-theme-surface);
    color: var(--b3-theme-on-surface-light);
    cursor: pointer;
    transition: all 0.15s ease;
    user-select: none;
}

.ai-action-chip:hover {
    background-color: var(--b3-theme-surface-lighter);
    color: var(--b3-theme-primary);
    border-color: var(--b3-theme-primary-light);
}

.ai-action-chip.primary {
    background-color: var(--b3-theme-primary);
    color: #ffffff;
    border-color: var(--b3-theme-primary);
    font-weight: 500;
}

.ai-action-chip.primary:hover {
    background-color: var(--b3-theme-primary);
    opacity: 0.9;
    color: #ffffff;
}

.ai-action-chip.feishu:hover {
    color: #0070f3;
    border-color: #38bdf8;
}

.ai-action-chip.siyuan:hover {
    color: #10b981;
    border-color: #34d399;
}

/* 提示词快捷选项条 */
.ai-studio-prompts-bar {
    display: flex;
    gap: 6px;
    padding: 6px 12px;
    overflow-x: auto;
    border-top: 1px solid var(--b3-theme-surface-lighter);
    background-color: var(--b3-theme-surface);
    white-space: nowrap;
    flex-shrink: 0;
    scrollbar-width: none;
}

.ai-studio-prompts-bar::-webkit-scrollbar {
    display: none;
}

.ai-prompt-pill {
    font-size: 11px;
    padding: 3px 9px;
    border-radius: 12px;
    background-color: var(--b3-theme-surface-lighter);
    color: var(--b3-theme-on-surface-light);
    cursor: pointer;
    transition: all 0.15s ease;
    user-select: none;
}

.ai-prompt-pill:hover {
    background-color: var(--b3-theme-primary);
    color: white;
}

/* 底部输入区 */
.ai-studio-input-area {
    padding: 8px 12px 10px 12px;
    background-color: var(--b3-theme-surface);
    border-top: 1px solid var(--b3-theme-surface-lighter);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.ai-studio-textarea-box {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--b3-theme-surface-lighter);
    border-radius: 8px;
    background-color: var(--b3-theme-background);
    padding: 6px 10px;
    transition: border-color 0.15s;
}

.ai-studio-textarea-box:focus-within {
    border-color: var(--b3-theme-primary);
}

.ai-studio-textarea {
    width: 100%;
    border: none;
    background: transparent;
    color: var(--b3-theme-on-surface);
    font-size: 13px;
    line-height: 1.5;
    resize: none;
    outline: none;
    height: 54px;
    font-family: inherit;
    box-sizing: border-box;
}

/* 输入框下方主工具条 (对齐主流大模型排版) */
.ai-studio-input-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 6px;
    border-top: 1px solid var(--b3-theme-surface-lighter);
    margin-top: 2px;
    gap: 6px;
}

.ai-toolbar-left {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    min-width: 0;
}

.ai-toolbar-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}

/* 胶囊模型选择下拉框 */
.ai-model-pill-select {
    background-color: var(--b3-theme-surface);
    color: var(--b3-theme-on-surface);
    border: 1px solid var(--b3-theme-surface-lighter);
    border-radius: 14px;
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 500;
    outline: none;
    cursor: pointer;
    transition: all 0.15s ease;
    max-width: 150px;
}

.ai-model-pill-select:hover {
    border-color: var(--b3-theme-primary);
    color: var(--b3-theme-primary);
}

/* 工具栏轻量胶囊按钮 */
.ai-pill-btn {
    background-color: var(--b3-theme-surface);
    border: 1px solid var(--b3-theme-surface-lighter);
    color: var(--b3-theme-on-surface-light);
    border-radius: 14px;
    padding: 2px 7px;
    font-size: 11px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    cursor: pointer;
    user-select: none;
    transition: all 0.15s ease;
}

.ai-pill-btn:hover {
    border-color: var(--b3-theme-primary);
    color: var(--b3-theme-primary);
}

.ai-pill-btn.active {
    background-color: var(--b3-theme-primary);
    color: #ffffff;
    border-color: var(--b3-theme-primary);
}

.ai-send-btn {
    background-color: var(--b3-theme-primary);
    color: white;
    border: none;
    padding: 3px 12px;
    border-radius: 14px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.15s;
    display: inline-flex;
    align-items: center;
    gap: 4px;
}

.ai-send-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

/* 紧随输入框下方的快捷配置卡片 */
.ai-config-drawer {
    display: none;
    flex-direction: column;
    padding: 10px 12px;
    background-color: var(--b3-theme-background);
    border: 1px solid var(--b3-theme-surface-lighter);
    border-radius: 8px;
    gap: 8px;
    animation: slideUp 0.18s ease-out;
}

.ai-config-drawer.show {
    display: flex;
}

@keyframes slideUp {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
}

.ai-config-row {
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.ai-config-label {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light);
    font-weight: 500;
}

.ai-config-input {
    width: 100%;
    padding: 4px 7px;
    border-radius: 5px;
    border: 1px solid var(--b3-theme-surface-lighter);
    background-color: var(--b3-theme-surface);
    color: var(--b3-theme-on-surface);
    font-size: 11px;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.15s ease;
}

.ai-config-input:focus {
    border-color: var(--b3-theme-primary);
}

.ai-config-footer {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 2px;
}

.ai-config-save-btn {
    background-color: var(--b3-theme-primary);
    color: #ffffff;
    border: none;
    padding: 3px 10px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.15s ease;
}

.ai-config-save-btn:hover {
    opacity: 0.9;
}

/* 搜索抽屉与知识检索卡片 */
.ai-search-drawer {
    display: none;
    flex-direction: column;
    padding: 10px 12px;
    background-color: var(--b3-theme-background);
    border: 1px solid var(--b3-theme-surface-lighter);
    border-radius: 8px;
    gap: 8px;
    animation: slideUp 0.18s ease-out;
}

.ai-search-drawer.show {
    display: flex;
}

.ai-search-header {
    display: flex;
    align-items: center;
    gap: 6px;
}

.ai-search-input {
    flex: 1;
    padding: 4px 8px;
    border-radius: 5px;
    border: 1px solid var(--b3-theme-surface-lighter);
    background-color: var(--b3-theme-surface);
    color: var(--b3-theme-on-surface);
    font-size: 11px;
    outline: none;
    box-sizing: border-box;
}

.ai-search-input:focus {
    border-color: var(--b3-theme-primary);
}

.ai-search-results {
    max-height: 180px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.ai-search-item {
    padding: 6px 8px;
    background-color: var(--b3-theme-surface);
    border: 1px solid var(--b3-theme-surface-lighter);
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 11px;
}

.ai-search-item-title {
    font-weight: 600;
    color: var(--b3-theme-primary);
    display: flex;
    align-items: center;
    justify-content: space-between;
}

.ai-search-item-body {
    color: var(--b3-theme-on-surface-light);
    line-height: 1.4;
    word-break: break-all;
}

.ai-search-item-btn {
    align-self: flex-end;
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    background-color: var(--b3-theme-background);
    border: 1px solid var(--b3-theme-surface-lighter);
    color: var(--b3-theme-on-surface);
    cursor: pointer;
    transition: all 0.15s;
}

.ai-search-item-btn:hover {
    border-color: var(--b3-theme-primary);
    color: var(--b3-theme-primary);
}`;

// ==========================================
// 8. 思源插件主入口类
// ==========================================
class AIStudioPlugin extends siyuan.Plugin {
    constructor(options) {
        super(options);
        this.settings = {
            apiKey: "",
            baseUrl: "https://api.deepseek.com/v1",
            model: "deepseek-chat",
            temperature: 0.7,
            defaultNotebook: "",
            notePathPrefix: "/AI创作",
            feishuWebhook: "",
            feishuCliTemplate: "echo \"{title}\" >> /tmp/feishu_share.txt"
        };
        this.aiClient = null;
        this.messages = [];
        this.isGenerating = false;
        this.lastSelectedBlock = null; // 暂存划选的目标块信息，用于精准原地替换
    }

    async onload() {
        console.log("[AIStudio] Plugin loading...");

        // 0. 注册 SVG 图标符号（解决右侧 Dock 栏及顶栏缺失原生 SVG Symbol 导致空白问题）
        this.addIcons(SVG_ICONS);

        // 注入内联自愈样式表（确保界面结构无论何时均渲染正确，杜绝样式塌陷）
        if (typeof document !== "undefined" && !document.getElementById("ai-studio-style")) {
            const style = document.createElement("style");
            style.id = "ai-studio-style";
            style.textContent = INLINE_CSS;
            document.head.appendChild(style);
        }

        // 清理可能缓存的旧 Dock 错误位置偏好（确保生效 RightTop 停靠）
        if (typeof window !== "undefined" && window.siyuan?.storage?.["local-plugin-docks"]) {
            delete window.siyuan.storage["local-plugin-docks"][this.name];
        }

        // 1. 加载持久化配置
        const loaded = await this.loadData("settings.json");
        if (loaded) {
            this.settings = Object.assign(this.settings, loaded);
        }

        // 初始化 AI Client
        this.aiClient = new AIClient(this.settings);

        // 注册思源原生智能体能力 (让思源原生 Agent 也能使用搜索与创作能力)
        if (typeof this.addAgentCapability === "function") {
            try {
                this.addAgentCapability({
                    name: "searchNotes",
                    title: "搜索思源笔记",
                    description: "基于关键词全库检索相关的思源笔记内容与文档标题",
                    inputSchema: {
                        type: "object",
                        properties: {
                            keyword: { type: "string", description: "要搜索的关键词" }
                        },
                        required: ["keyword"]
                    },
                    handler: async (args) => {
                        return await SiYuanBridge.searchNotes(args.keyword, 5);
                    }
                });

                this.addAgentCapability({
                    name: "createNote",
                    title: "创建思源新笔记",
                    description: "根据标题和 Markdown 内容在思源中创建一篇新文档",
                    inputSchema: {
                        type: "object",
                        properties: {
                            title: { type: "string", description: "文档标题" },
                            content: { type: "string", description: "Markdown 格式的正文" }
                        },
                        required: ["title", "content"]
                    },
                    handler: async (args) => {
                        return await SiYuanBridge.createDocWithMd(args.title, args.content);
                    }
                });

                this.addAgentCapability({
                    name: "updateNoteBlock",
                    title: "原地修改或替换笔记块",
                    description: "根据指定的 Block ID 原地更新或替换思源笔记中的段落或块内容",
                    inputSchema: {
                        type: "object",
                        properties: {
                            blockId: { type: "string", description: "要修改的思源块 ID (如 20261003...)" },
                            content: { type: "string", description: "更新后的 Markdown 内容" }
                        },
                        required: ["blockId", "content"]
                    },
                    handler: async (args) => {
                        return await SiYuanBridge.updateBlock(args.blockId, args.content);
                    }
                });
            } catch (err) {
                console.warn("[AIStudio] 注册 AgentCapability 忽略:", err);
            }
        }

        // 2. 注册顶部工具栏图标 (使用标准内联 SVG 确保 100% 直染可见)
        this.addTopBar({
            icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2L9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2z"/></svg>`,
            title: "AI 创作工坊 (⌥A)",
            position: "right",
            callback: () => {
                this.openStudioDialog();
            }
        });

        // 3. 注册快捷键 ⌥A (打开弹窗对话) 与 ⌥D (切换右侧 Dock)
        this.addCommand({
            langKey: "openAIStudio",
            langText: "打开 AI 创作工坊",
            hotkey: "⌥A",
            callback: () => {
                this.openStudioDialog();
            }
        });

        this.addCommand({
            langKey: "toggleAIDock",
            langText: "切换 AI 创作侧边栏",
            hotkey: "⌥D",
            callback: () => {
                const dockType = this.name + "ai_studio_dock";
                if (typeof window !== "undefined" && window.siyuan?.layout?.rightDock) {
                    window.siyuan.layout.rightDock.toggleModel(dockType);
                }
            }
        });

        // 4. 注册右侧 Dock 侧边栏面板 (常驻 RightTop，和文档大纲/反向链接同级并列)
        this.addDock({
            config: {
                position: "RightTop",
                size: { width: 380, height: 0 },
                icon: "iconAIStudio",
                title: "AI 创作工坊",
                hotkey: "⌥D"
            },
            data: {},
            type: "ai_studio_dock",
            init: (dock) => {
                const el = (dock && dock.element) ? dock.element : (this.element || dock);
                this.renderStudioView(el);
            }
        });

        // 5. 注册设置面板
        this.registerSettingsTab();
    }

    openStudioDialog() {
        const dialog = new siyuan.Dialog({
            title: "✨ AI 创作工坊 (AI Studio)",
            content: `<div id="ai-studio-dialog-root" style="height: 600px; max-height: 80vh; display: flex; flex-direction: column; width: 100%; box-sizing: border-box;"></div>`,
            width: "720px"
        });
        const root = dialog.element.querySelector("#ai-studio-dialog-root");
        this.renderStudioView(root);
    }

    renderStudioView(container) {
        if (!container) return;
        container.style.height = "100%";
        container.style.display = "flex";
        container.style.flexDirection = "column";
        container.style.overflow = "hidden";
        container.style.boxSizing = "border-box";

        const currentModel = this.settings.model || "deepseek-v4-pro";
        const isPreset = ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner", "gpt-4o", "gpt-4o-mini", "moonshot-v1-8k", "claude-3-5-sonnet-20241022"].includes(currentModel);

        container.innerHTML = `
        <div class="ai-studio-container">
            <!-- 顶栏：极简通透导航 -->
            <div class="ai-studio-header">
                <div class="ai-studio-title">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2L9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2z"/></svg>
                    <span>AI 创作副驾驶</span>
                </div>
                <div class="ai-studio-actions">
                    <button class="ai-studio-btn-icon" id="btn-clear-chat" title="清空对话">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    </button>
                </div>
            </div>

            <!-- 常驻上下文感知条 (实时感知当前打开的文档) -->
            <div class="ai-context-bar" id="ai-context-bar">
                <div class="ai-context-left">
                    <span class="ai-context-indicator" title="文档已连通"></span>
                    <span class="ai-context-name" id="ai-context-name">正在感知当前文档...</span>
                </div>
                <div class="ai-context-right">
                    <span class="ai-context-stat" id="ai-context-stat">0 字</span>
                    <button class="ai-context-btn" id="btn-refresh-context" title="刷新文档感知">🔄 刷新</button>
                </div>
            </div>

            <!-- 消息流容器 -->
            <div class="ai-studio-chat-box" id="ai-chat-box">
                <div class="ai-msg assistant">
                    <div class="ai-msg-bubble">
                        👋 你好！我是你的 AI 创作副驾驶，已深度接入思源笔记内核。<br><br>
                        💡 <b>无需手动点击复杂按钮，直接用自然语言交流即可自动执行</b>：<br>
                        • <b>🔍 知识库检索</b>：如 <i>“搜一下分布式架构相关笔记”</i>，自动全库检索并注入上下文<br>
                        • <b>📄 自动创建新笔记</b>：如 <i>“写一篇 Docker 指南并存为笔记”</i>，生成后自动创建新文档<br>
                        • <b>⚡ 选区润色与替换</b>：在正文中划选某段文字，输入 <i>“把选中的这段话润色并替换”</i>，自动原地覆盖<br>
                        • <b>📝 追加到文档</b>：如 <i>“把总结内容追加到当前文档末尾”</i>，自动无缝写入
                    </div>
                </div>
            </div>

            <!-- 快捷创作模板横幅 -->
            <div class="ai-studio-prompts-bar" id="ai-prompts-bar"></div>

            <!-- 底部输入区 (对齐主流大模型极简排版：模型与设置紧随输入框下方) -->
            <div class="ai-studio-input-area">
                <div class="ai-studio-textarea-box">
                    <textarea class="ai-studio-textarea" id="ai-textarea" placeholder="输入需求或与 AI 交流... (如：'搜一下架构笔记'、'写一篇方案存为笔记'、'润色选中文本并替换')"></textarea>
                    
                    <!-- 输入框内部底部工具栏 -->
                    <div class="ai-studio-input-toolbar">
                        <div class="ai-toolbar-left">
                            <!-- 胶囊模型切换器 -->
                            <select class="ai-model-pill-select" id="ai-model-select" title="点击切换当前模型">
                                <option value="deepseek-v4-pro" ${currentModel === 'deepseek-v4-pro' ? 'selected' : ''}>⚡ DeepSeek-V4 Pro</option>
                                <option value="deepseek-v4-flash" ${currentModel === 'deepseek-v4-flash' ? 'selected' : ''}>🚀 DeepSeek-V4 Flash</option>
                                <option value="deepseek-chat" ${currentModel === 'deepseek-chat' ? 'selected' : ''}>⚡ DeepSeek-V3</option>
                                <option value="deepseek-reasoner" ${currentModel === 'deepseek-reasoner' ? 'selected' : ''}>🧠 DeepSeek-R1</option>
                                <option value="gpt-4o" ${currentModel === 'gpt-4o' ? 'selected' : ''}>🤖 GPT-4o</option>
                                <option value="gpt-4o-mini" ${currentModel === 'gpt-4o-mini' ? 'selected' : ''}>⚡ GPT-4o-mini</option>
                                <option value="moonshot-v1-8k" ${currentModel === 'moonshot-v1-8k' ? 'selected' : ''}>🌙 Kimi</option>
                                <option value="claude-3-5-sonnet-20241022" ${currentModel === 'claude-3-5-sonnet-20241022' ? 'selected' : ''}>✨ Claude 3.5</option>
                                <option value="custom" ${!isPreset ? 'selected' : ''}>🛠️ 自定义: ${!isPreset ? currentModel : '模型...'}</option>
                            </select>

                            <!-- 模型配置入口 -->
                            <button class="ai-pill-btn" id="btn-toggle-config" title="配置 API Key 与模型地址">⚙️ 设置</button>
                        </div>
                        <div class="ai-toolbar-right">
                            <button class="ai-send-btn" id="btn-send">发送</button>
                        </div>
                    </div>
                </div>

                <!-- 紧随输入框下方的快捷配置卡片 -->
                <div class="ai-config-drawer" id="ai-config-drawer">
                    <div class="ai-config-row">
                        <label class="ai-config-label">API Key</label>
                        <input type="password" class="ai-config-input" id="cfg-api-key" placeholder="sk-xxxxxxxxxxxxxxxx" value="${this.settings.apiKey || ''}">
                    </div>
                    <div class="ai-config-row">
                        <label class="ai-config-label">API 基础地址 (Base URL)</label>
                        <input type="text" class="ai-config-input" id="cfg-base-url" placeholder="https://api.deepseek.com/v1" value="${this.settings.baseUrl || 'https://api.deepseek.com/v1'}">
                    </div>
                    <div class="ai-config-row">
                        <label class="ai-config-label">模型名称 (Model)</label>
                        <input type="text" class="ai-config-input" id="cfg-model-name" placeholder="deepseek-v4-pro" value="${this.settings.model || 'deepseek-v4-pro'}">
                    </div>
                    <div class="ai-config-footer">
                        <button class="ai-config-save-btn" id="btn-save-inline-config">💾 保存配置并应用</button>
                    </div>
                </div>
            </div>
        </div>
        `;

        this.bindStudioEvents(container);
    }

    bindStudioEvents(container) {
        const chatBox = container.querySelector("#ai-chat-box");
        const textarea = container.querySelector("#ai-textarea");
        const sendBtn = container.querySelector("#btn-send");
        const clearBtn = container.querySelector("#btn-clear-chat");
        const promptsBar = container.querySelector("#ai-prompts-bar");

        // 顶栏模型切换与抽屉控制
        const modelSelect = container.querySelector("#ai-model-select");
        const toggleConfigBtn = container.querySelector("#btn-toggle-config");
        const configDrawer = container.querySelector("#ai-config-drawer");
        const cfgApiKey = container.querySelector("#cfg-api-key");
        const cfgBaseUrl = container.querySelector("#cfg-base-url");
        const cfgModelName = container.querySelector("#cfg-model-name");
        const saveConfigBtn = container.querySelector("#btn-save-inline-config");

        // 模型切换事件
        modelSelect.onchange = async () => {
            const selected = modelSelect.value;
            if (selected === "deepseek-v4-pro") {
                this.settings.model = "deepseek-v4-pro";
                if (!this.settings.baseUrl || this.settings.baseUrl.includes("openai.com")) {
                    this.settings.baseUrl = "https://api.deepseek.com/v1";
                }
            } else if (selected === "deepseek-v4-flash") {
                this.settings.model = "deepseek-v4-flash";
                if (!this.settings.baseUrl || this.settings.baseUrl.includes("openai.com")) {
                    this.settings.baseUrl = "https://api.deepseek.com/v1";
                }
            } else if (selected === "deepseek-chat") {
                this.settings.model = "deepseek-chat";
                if (!this.settings.baseUrl || this.settings.baseUrl.includes("openai.com")) {
                    this.settings.baseUrl = "https://api.deepseek.com/v1";
                }
            } else if (selected === "deepseek-reasoner") {
                this.settings.model = "deepseek-reasoner";
                if (!this.settings.baseUrl || this.settings.baseUrl.includes("openai.com")) {
                    this.settings.baseUrl = "https://api.deepseek.com/v1";
                }
            } else if (selected === "gpt-4o") {
                this.settings.model = "gpt-4o";
                if (!this.settings.baseUrl || this.settings.baseUrl.includes("deepseek.com")) {
                    this.settings.baseUrl = "https://api.openai.com/v1";
                }
            } else if (selected === "gpt-4o-mini") {
                this.settings.model = "gpt-4o-mini";
                if (!this.settings.baseUrl || this.settings.baseUrl.includes("deepseek.com")) {
                    this.settings.baseUrl = "https://api.openai.com/v1";
                }
            } else if (selected === "moonshot-v1-8k") {
                this.settings.model = "moonshot-v1-8k";
                this.settings.baseUrl = "https://api.moonshot.cn/v1";
            } else if (selected === "claude-3-5-sonnet-20241022") {
                this.settings.model = "claude-3-5-sonnet-20241022";
            } else if (selected === "custom") {
                configDrawer.classList.add("show");
                toggleConfigBtn.classList.add("active");
                cfgModelName.focus();
                return;
            }

            cfgModelName.value = this.settings.model;
            cfgBaseUrl.value = this.settings.baseUrl;

            await this.saveData("settings.json", this.settings);
            this.aiClient.updateConfig(this.settings);
            siyuan.showMessage(`已快速切换至模型: ${this.settings.model}`, 2000, "info");
        };

        // 抽屉展开/折叠
        toggleConfigBtn.onclick = () => {
            const isShown = configDrawer.classList.toggle("show");
            toggleConfigBtn.classList.toggle("active", isShown);
        };

        // 保存内联配置
        saveConfigBtn.onclick = async () => {
            this.settings.apiKey = cfgApiKey.value.trim();
            this.settings.baseUrl = cfgBaseUrl.value.trim() || "https://api.deepseek.com/v1";
            this.settings.model = cfgModelName.value.trim() || "deepseek-chat";

            await this.saveData("settings.json", this.settings);
            this.aiClient.updateConfig(this.settings);
            configDrawer.classList.remove("show");
            toggleConfigBtn.classList.remove("active");

            // 同步下拉框状态
            const matchedOption = Array.from(modelSelect.options).find(opt => opt.value === this.settings.model);
            if (matchedOption) {
                modelSelect.value = this.settings.model;
            } else {
                modelSelect.value = "custom";
                const customOpt = modelSelect.querySelector("option[value='custom']");
                if (customOpt) customOpt.text = `⚙️ 自定义: ${this.settings.model}`;
            }

            siyuan.showMessage("模型与 API 配置已成功保存！", 2500, "info");
        };

        // 渲染模板 Pill
        PRESET_PROMPTS.forEach(item => {
            const pill = document.createElement("div");
            pill.className = "ai-prompt-pill";
            pill.innerText = item.name;
            pill.onclick = () => {
                textarea.value = item.prompt;
                textarea.focus();
            };
            promptsBar.appendChild(pill);
        });

        // 清空对话
        clearBtn.onclick = () => {
            this.messages = [];
            chatBox.innerHTML = `
                <div class="ai-msg assistant">
                    <div class="ai-msg-bubble">已清空上下文历史，我们可以开启全新的创作探讨！</div>
                </div>
            `;
        };

        // 常驻上下文状态条与当前文档实时感知
        const contextBar = container.querySelector("#ai-context-bar");
        const contextName = container.querySelector("#ai-context-name");
        const contextStat = container.querySelector("#ai-context-stat");
        const refreshContextBtn = container.querySelector("#btn-refresh-context");

        const syncActiveDoc = async () => {
            try {
                const active = await SiYuanBridge.getActiveDoc();
                if (active && active.docId && contextName) {
                    contextName.innerText = `《${active.title}》`;
                    contextName.title = `点击在主编辑区定位《${active.title}》`;
                    contextName.setAttribute("data-doc-id", active.docId);
                    contextStat.innerText = `${active.charCount >= 1000 ? (active.charCount / 1000).toFixed(1) + 'k' : active.charCount} 字`;
                    contextBar.classList.add("active");
                } else if (contextName) {
                    contextName.innerText = "全库就绪 (未打开特定文档)";
                    contextName.title = "";
                    contextName.removeAttribute("data-doc-id");
                    contextStat.innerText = "全库待命";
                    contextBar.classList.remove("active");
                }
            } catch (e) {
                console.warn("[AIStudio] 同步当前文档异常:", e);
            }
        };

        if (refreshContextBtn) {
            refreshContextBtn.onclick = async () => {
                refreshContextBtn.innerText = "⏳";
                await syncActiveDoc();
                setTimeout(() => { refreshContextBtn.innerText = "🔄 刷新"; }, 400);
            };
        }

        if (contextName) {
            contextName.onclick = () => {
                const docId = contextName.getAttribute("data-doc-id");
                if (docId) SiYuanBridge.openDocument(docId, this.app);
            };
        }

        textarea.addEventListener("focus", syncActiveDoc);
        setTimeout(syncActiveDoc, 300);

        if (this.eventBus) {
            this.eventBus.on("switch-protyle", syncActiveDoc);
            this.eventBus.on("loaded-protyle-static", syncActiveDoc);
        }

        // 监听全局点击事件，支持在检索卡片与对话气泡中一键跳转打开思源文档，并精准定位到章节/块
        chatBox.addEventListener("click", (e) => {
            const btn = e.target.closest(".ai-doc-open-btn, .ai-doc-jump-link, [data-doc-id], [data-block-id]");
            if (btn) {
                const blockId = btn.getAttribute("data-block-id");
                const docId = btn.getAttribute("data-doc-id");
                const targetId = blockId || docId;
                if (targetId) {
                    const isBlock = !!blockId && blockId !== docId;
                    SiYuanBridge.openDocument(targetId, this.app);
                    siyuan.showMessage(
                        isBlock ? "正在主编辑区精准定位到对应章节并高亮..." : "正在思源主编辑区打开文档...",
                        2000,
                        "info"
                    );
                }
            }
        });

        // 发送逻辑 (结合意图识别自动前置与后置处理)
        const doSend = async () => {
            const text = textarea.value.trim();
            if (!text || this.isGenerating) return;

            textarea.value = "";
            this.isGenerating = true;
            sendBtn.disabled = true;

            // 1. 添加用户消息气泡
            this.appendMessage(chatBox, "user", text);
            this.messages.push({ role: "user", content: text });

            // 2. 准备 Assistant 消息气泡
            const assistantBubble = this.createAssistantBubble(chatBox);
            chatBox.scrollTop = chatBox.scrollHeight;

            try {
                // 3. 意图识别与前置处理 (Pre-flight Analysis)
                assistantBubble.contentEl.innerText = "🔍 正在意图识别与调取知识库...";
                
                // 提取上一条 Assistant 消息内容（用于支持多轮对话中的“更新到笔记中”操作）
                const lastAssistantMsg = this.messages.filter(m => m.role === "assistant").pop()?.content || "";
                const preResult = await IntentEngine.preProcess(text, SiYuanBridge, {
                    ...this.settings,
                    lastAssistantMessage: lastAssistantMsg
                });

                // 渲染前置徽标 (如：自动检索到哪些笔记，或感知到了当前选区/直接执行)
                if (preResult.badges && preResult.badges.length > 0) {
                    preResult.badges.forEach(bText => {
                        const bEl = document.createElement("div");
                        bEl.className = "ai-auto-badge info";
                        bEl.innerText = bText;
                        assistantBubble.preBadgesEl.appendChild(bEl);
                    });
                }

                // 3.1 若识别为对上一轮内容的直接保存/更新操作（Direct Action），则无需重复调用大模型，直接落盘响应
                if (preResult.isDirectAction) {
                    assistantBubble.contentEl.innerHTML = preResult.directResponse.replace(/\n/g, "<br>");
                    this.messages.push({ role: "assistant", content: preResult.directResponse });
                    this.attachActionsToMessage(assistantBubble.footerEl, preResult.directResponse, preResult);
                    this.isGenerating = false;
                    sendBtn.disabled = false;
                    chatBox.scrollTop = chatBox.scrollHeight;
                    return;
                }

                assistantBubble.contentEl.innerText = "⏳ 思考生成中...";

                // 4. 将增强上下文的消息列表传给 AI（注入思源专属宿主系统提示词，严禁大模型反问笔记平台）
                const SYSTEM_PROMPT = `你是运行在思源笔记（SiYuan Note）客户端内的智能创作副驾驶。
你通过底层 API 与思源笔记内核深度集成，具备以下权限与能力：
1. 全库知识检索（RAG）：自动检索用户已有笔记库；
2. 自动创建新笔记：用户要求保存、记录或创建笔记时，宿主环境会自动将你输出的 Markdown 内容保存为思源新文档；
3. 原地替换：用户要求润色或修改选区时，宿主环境会自动将你输出的内容原地替换回思源编辑器；
4. 文档追加：用户要求更新到当前文档末尾时，宿主环境会自动追加写入。

【核心铁律】：
- 你就在用户的思源笔记软件内部运行，严禁向用户询问“你在用什么笔记软件（Obsidian/Notion/语雀等）”，严禁声称“我没法直接把内容写进去”；
- 你具备全库检索思源笔记的能力，宿主系统会在后台实时调取检索结果给你，严禁对用户声称“我无法主动发起检索”或“我没法去翻文档树”；
- 当用户要求“更新到笔记中”、“保存为笔记”、“写一篇...存起来”时，请直接给出排版规范的 Markdown 正文（包含唯一的一级大标题 # ），以便宿主系统全自动同步落盘；
- 保持专业、干练、自然的行文风格。`;

                const messagesPayload = [
                    { role: "system", content: SYSTEM_PROMPT },
                    ...this.messages.slice(0, -1),
                    { role: "user", content: preResult.augmentedText }
                ];

                let fullResponse = "";
                await this.aiClient.chatStream(
                    messagesPayload,
                    (chunk, accumulated) => {
                        fullResponse = accumulated;
                        assistantBubble.contentEl.innerText = accumulated;
                        chatBox.scrollTop = chatBox.scrollHeight;
                    },
                    async (finalText) => {
                        this.messages.push({ role: "assistant", content: finalText });

                        // 5. 意图识别后置自动执行 (Post-Action Execution)
                        try {
                            const postActions = await IntentEngine.postProcess(
                                finalText,
                                preResult,
                                SiYuanBridge,
                                FeishuBridge,
                                this.settings
                            );

                            if (postActions && postActions.length > 0) {
                                postActions.forEach(act => {
                                    const actEl = document.createElement("div");
                                    actEl.className = `ai-auto-badge ${act.success ? 'success' : 'warn'}`;
                                    actEl.innerText = act.message;
                                    assistantBubble.postBadgesEl.appendChild(actEl);
                                });
                            }
                        } catch (postErr) {
                            console.error("[IntentEngine] 后置动作执行异常:", postErr);
                        }

                        // 6. 附加轻量纯净的动作区 (支持一键回填、原地替换与复制)
                        this.attachActionsToMessage(assistantBubble.footerEl, finalText, preResult);
                        this.isGenerating = false;
                        sendBtn.disabled = false;
                        chatBox.scrollTop = chatBox.scrollHeight;
                    },
                    (err) => {
                        assistantBubble.contentEl.innerHTML = `<span style="color: #ef4444;">生成出错: ${err.message}</span>`;
                        this.isGenerating = false;
                        sendBtn.disabled = false;
                    }
                );
            } catch (err) {
                siyuan.showMessage(`AI 对话异常: ${err.message}`, 5000, "error");
                assistantBubble.contentEl.innerHTML = `<span style="color: #ef4444;">发生异常: ${err.message}</span>`;
                this.isGenerating = false;
                sendBtn.disabled = false;
            }
        };

        sendBtn.onclick = doSend;
        textarea.onkeydown = (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                doSend();
            }
        };
    }

    appendMessage(chatBox, role, content) {
        const msgDiv = document.createElement("div");
        msgDiv.className = `ai-msg ${role}`;
        msgDiv.innerHTML = `<div class="ai-msg-bubble">${content.replace(/\n/g, "<br>")}</div>`;
        chatBox.appendChild(msgDiv);
        chatBox.scrollTop = chatBox.scrollHeight;
    }

    createAssistantBubble(chatBox) {
        const msgDiv = document.createElement("div");
        msgDiv.className = "ai-msg assistant";

        // 前置徽标容器（显示如：🔍 检索知识库、✂️ 感知选区）
        const preBadges = document.createElement("div");
        preBadges.className = "ai-pre-badges";

        const bubble = document.createElement("div");
        bubble.className = "ai-msg-bubble";
        bubble.innerText = "⏳ 思考中...";

        // 后置动作徽标容器（显示如：⚡ 已自动原地替换选区、📄 已自动创建新笔记）
        const postBadges = document.createElement("div");
        postBadges.className = "ai-post-badges";

        const footer = document.createElement("div");
        footer.className = "ai-msg-footer";

        msgDiv.appendChild(preBadges);
        msgDiv.appendChild(bubble);
        msgDiv.appendChild(postBadges);
        msgDiv.appendChild(footer);
        chatBox.appendChild(msgDiv);

        return { 
            msgDiv, 
            preBadgesEl: preBadges, 
            contentEl: bubble, 
            postBadgesEl: postBadges, 
            footerEl: footer 
        };
    }

    attachActionsToMessage(footerEl, contentText, preResult = {}) {
        footerEl.innerHTML = "";

        // 1. 复制按钮
        const btnCopy = document.createElement("button");
        btnCopy.className = "ai-action-chip";
        btnCopy.innerHTML = `📋 复制`;
        btnCopy.onclick = async () => {
            await navigator.clipboard.writeText(contentText);
            siyuan.showMessage("Markdown 已复制到剪贴板！", 2000, "info");
            btnCopy.innerText = "✔ 已复制";
            setTimeout(() => { btnCopy.innerText = "📋 复制"; }, 2000);
        };
        footerEl.appendChild(btnCopy);

        // 2. 原地替换选区按钮（当捕获到划选块时）
        if (preResult && preResult.capturedBlock && preResult.capturedBlock.blockId) {
            const btnReplace = document.createElement("button");
            btnReplace.className = "ai-action-chip primary";
            btnReplace.innerHTML = `⚡ 原地替换划选段落`;
            btnReplace.onclick = async () => {
                try {
                    await SiYuanBridge.updateBlock(preResult.capturedBlock.blockId, contentText);
                    siyuan.showMessage("✔ 已成功原地替换选中的段落！", 2500, "info");
                    btnReplace.innerText = "✔ 已替换";
                } catch (err) {
                    siyuan.showMessage(`替换失败: ${err.message}`, 4000, "error");
                }
            };
            footerEl.appendChild(btnReplace);
        }

        // 3. 一键回填覆盖至当前文档（当处理/润色了某篇文档时）
        const targetDoc = preResult?.contextDoc || preResult?.activeDoc;
        if (targetDoc && targetDoc.docId && targetDoc.title) {
            const btnWriteback = document.createElement("button");
            btnWriteback.className = "ai-action-chip primary";
            btnWriteback.innerHTML = `📝 回填至《${targetDoc.title}》`;
            btnWriteback.onclick = async () => {
                try {
                    await SiYuanBridge.updateDocContent(targetDoc.docId, contentText);
                    siyuan.showMessage(`✔ 已成功覆盖回填至文档《${targetDoc.title}》！`, 3000, "info");
                    btnWriteback.innerText = "✔ 已回填";
                } catch (err) {
                    siyuan.showMessage(`回填失败: ${err.message}`, 4000, "error");
                }
            };
            footerEl.appendChild(btnWriteback);
        }

        // 4. 另存为新文档按钮
        const btnSaveNew = document.createElement("button");
        btnSaveNew.className = "ai-action-chip";
        btnSaveNew.innerHTML = `📄 另存为新文档`;
        btnSaveNew.onclick = async () => {
            try {
                const title = IntentEngine.extractTitle(contentText, "AI创作记录");
                const res = await SiYuanBridge.createDocWithMd(title, contentText, this.settings.defaultNotebook, this.settings.notePathPrefix);
                siyuan.showMessage(`✔ 已成功另存为新文档《${res.title}》！`, 3000, "info");
                btnSaveNew.innerText = "✔ 已存为新笔记";
            } catch (err) {
                siyuan.showMessage(`保存失败: ${err.message}`, 4000, "error");
            }
        };
        footerEl.appendChild(btnSaveNew);
    }

    registerSettingsTab() {
        this.setting = new siyuan.Setting({
            confirmCallback: async () => {
                await this.saveData("settings.json", this.settings);
                this.aiClient.updateConfig(this.settings);
                siyuan.showMessage("AI 创作工坊设置已保存！", 3000, "info");
            }
        });

        // 1. 大模型 API Key
        this.setting.addItem({
            title: "大模型 API Key",
            description: "支持 DeepSeek / OpenAI / Kimi / 月之暗面 / 本地 Ollama",
            createActionElement: () => {
                const input = document.createElement("input");
                input.className = "b3-text-field fn__flex-1";
                input.type = "password";
                input.placeholder = "sk-xxxxxxxxxxxxxxxx";
                input.value = this.settings.apiKey || "";
                input.oninput = (e) => { this.settings.apiKey = e.target.value.trim(); };
                return input;
            }
        });

        // 2. Base URL
        this.setting.addItem({
            title: "API 基础地址 (Base URL)",
            description: "默认 https://api.deepseek.com/v1 或中转接口",
            createActionElement: () => {
                const input = document.createElement("input");
                input.className = "b3-text-field fn__flex-1";
                input.value = this.settings.baseUrl || "https://api.deepseek.com/v1";
                input.oninput = (e) => { this.settings.baseUrl = e.target.value.trim(); };
                return input;
            }
        });

        // 3. 模型名称
        this.setting.addItem({
            title: "模型名称 (Model)",
            description: "例如 deepseek-chat, deepseek-reasoner, gpt-4o, moonshot-v1-8k",
            createActionElement: () => {
                const input = document.createElement("input");
                input.className = "b3-text-field fn__flex-1";
                input.value = this.settings.model || "deepseek-chat";
                input.oninput = (e) => { this.settings.model = e.target.value.trim(); };
                return input;
            }
        });

        // 4. 飞书 Webhook 机器人地址
        this.setting.addItem({
            title: "飞书群机器人 Webhook 地址 (一键分享)",
            description: "在飞书群中添加自定义机器人获取，一键将 AI 创作卡片推至飞书群",
            createActionElement: () => {
                const input = document.createElement("input");
                input.className = "b3-text-field fn__flex-1";
                input.placeholder = "https://open.feishu.cn/open-apis/bot/v2/hook/xxxx";
                input.value = this.settings.feishuWebhook || "";
                input.oninput = (e) => { this.settings.feishuWebhook = e.target.value.trim(); };
                return input;
            }
        });

        // 5. 飞书 CLI / 自定义命令模板 (扩展性设计)
        this.setting.addItem({
            title: "飞书 CLI / 自定义 Shell 命令扩展模板",
            description: "支持 {title} 和 {content} 占位符，支持一键调用类似 feishu-cli 命令行",
            createActionElement: () => {
                const input = document.createElement("input");
                input.className = "b3-text-field fn__flex-1";
                input.placeholder = "feishu doc create --title \"{title}\" --content \"{content}\"";
                input.value = this.settings.feishuCliTemplate || "";
                input.oninput = (e) => { this.settings.feishuCliTemplate = e.target.value.trim(); };
                return input;
            }
        });

        // 6. 思源默认新建文档路径前缀
        this.setting.addItem({
            title: "默认新建笔记路径前缀",
            description: "例如 /AI创作，点击'转为新笔记'时将自动按日期和标题归档",
            createActionElement: () => {
                const input = document.createElement("input");
                input.className = "b3-text-field fn__flex-1";
                input.value = this.settings.notePathPrefix || "/AI创作";
                input.oninput = (e) => { this.settings.notePathPrefix = e.target.value.trim(); };
                return input;
            }
        });
    }

    async onunload() {
        console.log("[AIStudio] Plugin unloaded.");
    }
}

module.exports = AIStudioPlugin;
