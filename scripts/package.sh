#!/bin/bash
# ==============================================================================
# SiYuan AI Studio (AI 创作工坊) 发布打包脚本
# ==============================================================================

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$DIR"

OUT_DIR="$DIR/release"
mkdir -p "$OUT_DIR"

ZIP_NAME="siyuan-ai-studio-v1.0.0.zip"
TARGET_ZIP="$OUT_DIR/$ZIP_NAME"
BAZAAR_ZIP="$OUT_DIR/package.zip"

echo "[*] 正在打包思源 AI 创作工坊插件: $ZIP_NAME 及集市标准包 package.zip..."
zip -r "$TARGET_ZIP" \
    plugin.json \
    index.js \
    index.css \
    style.css \
    icon.png \
    README.md \
    i18n/ \
    modules/

cp -f "$TARGET_ZIP" "$BAZAAR_ZIP"

echo "✔ 打包成功！"
echo "  - 本地安装包: $TARGET_ZIP"
echo "  - 官方集市包: $BAZAAR_ZIP"
