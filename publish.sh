#!/bin/bash
#
#  publish.sh
#  tdb-ai-bridge
#
#  把当前目录的源码推到 GitHub。只在白名单里挑文件，不会把主仓 SVN 里的东西带过去。
#
#  用法: ./publish.sh "这次改了什么"
#
#  Created by AI鲁志刚 on 2026/11/11.
#  Copyright © 2026 FEBA. All rights reserved.
#

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "${ROOT}"

MESSAGE="${1:-}"
if [ -z "${MESSAGE}" ]; then
  printf '用法: ./publish.sh "这次改了什么"\n' >&2
  exit 2
fi

if [ ! -d .git ]; then
  printf '[初始化] git init -b main\n'
  git init -b main
  git add .
  git commit -m "chore: 初始化仓库" >/dev/null
  printf '请先配置远端: git remote add origin git@github.com:mysic-zx/tdb-ai-bridge.git\n'
  exit 0
fi

if [ -n "$(git status --porcelain -- src test docs skills examples .github package.json package-lock.json tsconfig.json README.md LICENSE .gitignore init.sh publish.sh)" ]; then
  git add -- src test docs skills examples .github package.json package-lock.json tsconfig.json README.md LICENSE .gitignore init.sh publish.sh
  git commit -m "${MESSAGE}"
else
  printf '没有需要提交的改动。\n'
  exit 0
fi

if git remote get-url origin >/dev/null 2>&1; then
  git push origin HEAD
else
  printf '还没配远端，先执行: git remote add origin git@github.com:mysic-zx/tdb-ai-bridge.git\n'
fi
