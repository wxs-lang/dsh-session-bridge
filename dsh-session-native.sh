#!/usr/bin/env bash
# dsh-session-native.sh — native messaging 启动器（macOS / Linux）
#
# 浏览器拉起本脚本，脚本再启动 node native-host.mjs。
# stdin/stdout 是二进制协议通道，绝不能有任何额外输出。

set -eu

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 优先用环境里指定的 node，其次 PATH
NODE_BIN="${DSH_NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi

if [ -z "$NODE_BIN" ]; then
  # 浏览器拉起时 PATH 可能不完整，试几个常见位置
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
    [ -x "$c" ] && { NODE_BIN="$c"; break; }
  done
fi

if [ -z "$NODE_BIN" ]; then
  # 协议通道不能写 stdout，只能写 stderr
  echo "[dsh-session-native] 找不到 node" >&2
  exit 1
fi

exec "$NODE_BIN" "$HERE/native-host.mjs"
