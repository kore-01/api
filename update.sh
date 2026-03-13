#!/bin/bash
# AKDN Update Script - 从 GitHub 拉取最新代码并重启服务

set -e

echo "📦 正在从 GitHub 拉取最新代码..."
cd /opt/akdn

# 暂存本地修改
git stash push -m "auto-stash before update" 2>/dev/null || true

# 拉取最新代码
git fetch origin
git reset --hard origin/main

echo "🔨 正在编译..."
npm run build

echo "♻️ 正在重启服务..."
pm2 restart akdn

echo "✅ 更新完成!"
pm2 status
