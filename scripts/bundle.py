import os

base_dir = "/Users/liushuai/Documents/develop/workspace/siyuan-ai-studio"

with open(os.path.join(base_dir, "modules/prompts.js")) as f:
    prompts_code = f.read().replace('"use strict";', '').replace('module.exports = { PRESET_PROMPTS };', '')

with open(os.path.join(base_dir, "modules/ai-client.js")) as f:
    ai_client_code = f.read().replace('"use strict";', '').replace('module.exports = AIClient;', '')

with open(os.path.join(base_dir, "modules/siyuan-bridge.js")) as f:
    siyuan_bridge_code = f.read().replace('"use strict";', '').replace('const siyuan = require("siyuan");', '').replace('module.exports = SiYuanBridge;', '')

with open(os.path.join(base_dir, "modules/feishu-bridge.js")) as f:
    feishu_bridge_code = f.read().replace('"use strict";', '').replace('const { exec } = require("child_process");', '').replace('module.exports = FeishuBridge;', '')

with open(os.path.join(base_dir, "modules/intent-engine.js")) as f:
    intent_engine_code = f.read().replace('"use strict";', '').replace('module.exports = IntentEngine;', '')

with open(os.path.join(base_dir, "index.css")) as f:
    css_content = f.read()

with open(os.path.join(base_dir, "index.js")) as f:
    main_code = f.read()

# Strip initial declarations before class AIStudioPlugin
lines = main_code.splitlines()
body_lines = []
skip = True
for line in lines:
    if line.startswith("class AIStudioPlugin"):
        skip = False
    if not skip:
        body_lines.append(line)

class_body = "\n".join(body_lines)

# Ensure container.style and CSS injection
bundled = f'''"use strict";
const siyuan = require("siyuan");

// 安全获取 child_process
let child_process = null;
try {{
    child_process = require("child_process");
}} catch (e) {{
    if (typeof window !== "undefined" && window.require) {{
        try {{ child_process = window.require("child_process"); }} catch (err) {{}}
    }}
}}
const exec = child_process ? child_process.exec : null;

// ==========================================
// 1. 预设提示词模板模块
// ==========================================
{prompts_code.strip()}

// ==========================================
// 2. AI SSE 流式客户端模块
// ==========================================
{ai_client_code.strip()}

// ==========================================
// 3. 思源笔记内核桥接模块
// ==========================================
{siyuan_bridge_code.strip()}

// ==========================================
// 4. 飞书卡片与 CLI 桥接模块
// ==========================================
{feishu_bridge_code.strip()}

// ==========================================
// 5. 意图识别与自动执行引擎
// ==========================================
{intent_engine_code.strip()}

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
const INLINE_CSS = `{css_content.strip().replace('`', '\\`').replace('${', '\\${')}`;

// ==========================================
// 8. 思源插件主入口类
// ==========================================
{class_body}
'''

output_path = os.path.join(base_dir, "index.js")
with open(output_path, "w") as f:
    f.write(bundled)

print("Bundled index.js successfully, size:", len(bundled))
