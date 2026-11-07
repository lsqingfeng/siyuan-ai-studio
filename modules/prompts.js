"use strict";

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

module.exports = { PRESET_PROMPTS };
