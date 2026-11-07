# SiYuan AI Studio (AI 创作工坊)

[English](./README.md) | [简体中文](./README.zh-CN.md)

> Native AI creative co-pilot for SiYuan Note. Chat, polish, summarize, stream generate, and write back into documents seamlessly!  
> **100% frontend/Node implementation with zero Python dependency and zero external server ports.**

---

## 🌟 Key Features

1. **Active Document Awareness by Default**:
   - Built-in live document context indicator bar in sidebar;
   - Automatically reads the currently opened note when you ask to polish, summarize, or explain—no manual copy-pasting needed.

2. **Automated Intent Recognition & Action Loop**:
   - **Full Knowledge RAG & Chapter Jump**: Ask *“Find test environment credentials”* and get instant block-level results with direct section navigation and highlights;
   - **Semantic Note Creation**: Ask *“Write a Docker guide to /tech-docs/containers”* and it creates notes in clean semantic hierarchy;
   - **One-Click Writeback**: Directly replace or overwrite the active document with polished results.

3. **Multi-Model & Fast Streaming Support**:
   - Supports DeepSeek-V4 Pro / Flash, DeepSeek-V3 / R1, GPT-4o, Claude 3.5 Sonnet, Kimi, and local Ollama;
   - Server-Sent Events (SSE) typewriter-style real-time streaming.

4. **Seamless Integration**:
   - Shortcut `⌥A` (Option + A) for instant popup dialog;
   - Dock icon in lower-right corner for persistent sidebar co-writing.

---

## 🚀 Installation

### Via SiYuan Bazaar (Recommended)
Go to **Settings -> Bazaar -> Plugins**, search for **"AI Studio"** or **"AI 创作工坊"**, and click install.

---

## 📄 License
This project is licensed under the [MIT License](LICENSE).
