#!/bin/bash
#
#  init.sh
#  tdb-ai-bridge
#
#  听读宝 AI Bridge（CLI + MCP，TypeScript）初始化，由 Libs/init.sh 调用，也可单独执行。
#
#  用法: ./init.sh [选项]
#    （无参）   轻量初始化：node_modules 缺失时执行 npm install
#    --check    只检查 Node/npm 与依赖、构建产物状态
#    --build    额外执行 npm run build 产出 dist/index.js
#    -h|--help  显示帮助
#
#  Created by AI鲁志刚 on 2026/11/11.
#  Copyright © 2026 FEBA. All rights reserved.
#

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MODE="init"
missing=0

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --build) MODE="build"; shift ;;
    -h|--help) sed -n '4,12p' "$0"; exit 0 ;;
    *) printf '未知参数: %s\n' "$1" >&2; exit 2 ;;
  esac
done

check() {
  if command -v node >/dev/null 2>&1; then
    node_major="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [ "${node_major}" -ge 18 ] 2>/dev/null; then
      printf '  [ok] node %s\n' "$(node -v)"
    else
      printf '  [缺失] node %s（需要 >=18）\n' "$(node -v)"
      missing=1
    fi
  else
    printf '  [缺失] node（>=18，建议用 nvm 安装）\n'
    missing=1
  fi

  if command -v npm >/dev/null 2>&1; then
    printf '  [ok] npm %s\n' "$(npm -v)"
  else
    printf '  [缺失] npm\n'
    missing=1
  fi

  if [ -f "${ROOT}/package.json" ]; then
    printf '  [ok] package.json\n'
  else
    printf '  [缺失] package.json\n'
    missing=1
  fi

  if [ -d "${ROOT}/node_modules" ]; then
    printf '  [ok] node_modules 已安装\n'
  else
    printf '  [缺失] node_modules（初始化会 npm install）\n'
    missing=1
  fi

  if [ -f "${ROOT}/dist/index.js" ]; then
    printf '  [ok] dist/index.js\n'
  else
    printf '  [提示] dist/index.js 缺失（--build 会 npm run build）\n'
  fi
}

prepare() {
  if [ -d "${ROOT}/node_modules" ]; then
    printf '  [跳过] node_modules 已安装\n'
  else
    printf '  [安装] npm install\n'
    ( cd "${ROOT}" && npm install )
  fi
}

case "${MODE}" in
  check)
    check
    [ "${missing}" -eq 0 ] || exit 1
    ;;
  init)
    prepare
    ;;
  build)
    prepare
    printf '  [构建] npm run build\n'
    ( cd "${ROOT}" && npm run build )
    if [ ! -f "${ROOT}/dist/index.js" ]; then
      printf '  [失败] 构建后仍缺少 dist/index.js\n' >&2
      exit 1
    fi
    ;;
esac
