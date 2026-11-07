"use strict";

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

module.exports = IntentEngine;
