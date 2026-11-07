"use strict";

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

module.exports = AIClient;
