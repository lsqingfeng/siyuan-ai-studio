"use strict";

const { exec } = require("child_process");

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

module.exports = FeishuBridge;
