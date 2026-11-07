"use strict";
const siyuan = require("siyuan");

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

module.exports = SiYuanBridge;
