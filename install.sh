#!/usr/bin/env bash
# install.sh — dsh-session-bridge 一键安装（macOS / Linux）
#
# Windows 用 install.ps1，功能对等。
#
# 做这些事：
#   1. 检查环境（node / DSH profile）
#   2. 复制插件到 profile 的 vendor/
#   3. 装 ws 依赖
#   4. 生成并注册 native messaging 宿主（Chrome / Chromium / Edge / Brave）
#   5. 打印扩展加载步骤
#   6. 可选追加 cordis.patch.yml
#   7. 跑 doctor 自检
#
# 用法：
#   ./install.sh                 # 交互式
#   ./install.sh --yes           # 全自动（不改配置时静默）
#   ./install.sh --skip-native   # 不装原生宿主
#   ./install.sh --force         # 覆盖已存在目录
#
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/desktop"
TARGET="$PROFILE_DIR/vendor/dsh-session-bridge"

ASSUME_YES=0
SKIP_NATIVE=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)      ASSUME_YES=1 ;;
    --skip-native) SKIP_NATIVE=1 ;;
    --force|-f)    FORCE=1 ;;
    --help|-h)     sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
done

step() { printf '\n\033[36m[%s]\033[0m %s\n' "$1" "$2"; }
ok()   { printf '    \033[32m+\033[0m %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n    \033[31mx\033[0m %s\n' "$1"; exit 1; }

# ── 0. 环境 ──────────────────────────────────────────────────────────
step 0 '检查环境'

[ -f "$PLUGIN_DIR/impl.js" ] || die "请在插件根目录运行（找不到 impl.js）。当前：$PLUGIN_DIR"
ok "插件目录：$PLUGIN_DIR"

[ -d "$DSH_HOME" ] || die "找不到 DSH 配置目录：$DSH_HOME（装过 DSH 再用，或设 DSH_HOME）"
ok "DSH 配置：$DSH_HOME"

command -v node >/dev/null 2>&1 || die '找不到 node，请先装 Node.js 20+'
NODE_V="$(node -v | tr -d 'v')"
NODE_MAJOR="${NODE_V%%.*}"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 版本太低：$NODE_V（需要 20+）"
ok "Node $NODE_V"

[ -d "$PROFILE_DIR" ] || die "profile 目录不存在：$PROFILE_DIR（先启动一次 DSH）"
ok "DSH profile：$PROFILE_DIR"

# ── 1. 放置插件 ──────────────────────────────────────────────────────
step 1 '放置插件文件'

mkdir -p "$PROFILE_DIR/vendor"

if [ "$PLUGIN_DIR" = "$TARGET" ]; then
  ok '已在 vendor 目标目录里运行，跳过复制'
else
  if [ -e "$TARGET" ]; then
    [ "$FORCE" -eq 1 ] || die "目标已存在：$TARGET（用 --force 覆盖）"
    rm -rf "$TARGET"
    ok '已清理旧版本'
  fi
  mkdir -p "$TARGET"
  # 排除不该进 vendor 的东西
  for item in "$PLUGIN_DIR"/* "$PLUGIN_DIR"/.[!.]*; do
    [ -e "$item" ] || continue
    base="$(basename "$item")"
    case "$base" in
      .git|node_modules|icon-src|test|.gitignore|install.ps1|install.sh|uninstall.ps1|uninstall.sh|*.tgz)
        continue ;;
    esac
    cp -R "$item" "$TARGET/"
  done
  chmod +x "$TARGET/dsh-session-native.sh" 2>/dev/null || true
  ok "已复制到 $TARGET"
fi

# ── 2. 依赖 ──────────────────────────────────────────────────────────
step 2 '安装依赖（ws）'

cd "$TARGET"
if [ -d node_modules/ws ]; then
  ok 'ws 已存在，跳过'
else
  REGS=()
  [ -f "$HOME/.npmrc" ] && REGS+=("$(grep -E '^registry\s*=' "$HOME/.npmrc" | head -1 | sed 's/^registry\s*=\s*//' || true)")
  REGS+=("https://registry.npmjs.org" "https://registry.npmmirror.com")

  INSTALLED=0
  for reg in "${REGS[@]}"; do
    [ -n "$reg" ] || continue
    printf '    尝试 %s ... ' "$reg"
    if npm install ws --no-audit --no-fund --loglevel=error --registry="$reg" >/dev/null 2>&1; then
      printf 'ok\n'
      INSTALLED=1
      break
    fi
    printf '失败\n'
  done

  if [ "$INSTALLED" -eq 1 ]; then
    ok 'ws 已就位'
  else
    warn 'ws 装不上。原生宿主无法启动，但插件主体仍可用（扩展直连 WebSocket）'
    warn "手动修复：cd \"$TARGET\" && npm install ws"
    warn '有代理的话先设 HTTPS_PROXY 再重跑'
  fi
fi

# ── 3. 原生宿主 ──────────────────────────────────────────────────────
if [ "$SKIP_NATIVE" -eq 0 ]; then
  step 3 '注册原生消息宿主'

  HOST_JSON="$TARGET/com.dsh.session.json"
  LAUNCHER="$TARGET/dsh-session-native.sh"

  # 尝试从已装的扩展里猜 ID（Chrome / Chromium / Edge / Brave）
  EXT_ID=""
  for root in "$HOME/Library/Application Support/Google/Chrome" \
              "$HOME/.config/google-chrome" \
              "$HOME/.config/chromium" \
              "$HOME/Library/Application Support/Microsoft Edge" \
              "$HOME/.config/microsoft-edge" \
              "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" \
              "$HOME/.config/BraveSoftware/Brave-Browser"; do
    [ -d "$root" ] || continue
    found="$(find "$root" -maxdepth 3 -type d -name '????????????????????????????????' 2>/dev/null | head -1 || true)"
    if [ -n "$found" ]; then
      EXT_ID="$(basename "$found")"
      break
    fi
  done

  if [ -n "$EXT_ID" ]; then
    ok "检测到扩展 ID：$EXT_ID"
  else
    warn '还没装扩展，猜不到扩展 ID（装上后重跑本脚本会自动填入）'
    EXT_ID='REPLACE_WITH_YOUR_EXTENSION_ID'
  fi

  cat > "$HOST_JSON" <<EOF
{
  "type": "stdio",
  "name": "com.dsh.session",
  "description": "DSH Session Bridge native messaging host",
  "path": "$LAUNCHER",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF
  chmod +x "$LAUNCHER" 2>/dev/null || true
  ok "已写 $HOST_JSON"

  # macOS: 放进浏览器支持的 NativeMessagingHosts 目录
  if [ "$(uname -s)" = "Darwin" ]; then
    for d in "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
             "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" \
             "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" \
             "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"; do
      if [ -d "$(dirname "$d")" ]; then
        mkdir -p "$d"
        ln -sf "$HOST_JSON" "$d/com.dsh.session.json"
        ok "已链接 $(basename "$(dirname "$d")")"
      fi
    done
  else
    # Linux: 用 ~/.config/<browser>/NativeMessagingHosts
    for d in "$HOME/.config/google-chrome/NativeMessagingHosts" \
             "$HOME/.config/chromium/NativeMessagingHosts" \
             "$HOME/.config/microsoft-edge/NativeMessagingHosts" \
             "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"; do
      parent="$(dirname "$d")"
      if [ -d "$parent" ]; then
        mkdir -p "$d"
        ln -sf "$HOST_JSON" "$d/com.dsh.session.json"
        ok "已链接 $d"
      fi
    done
  fi

  if [ "$EXT_ID" = 'REPLACE_WITH_YOUR_EXTENSION_ID' ]; then
    warn ''
    warn 'allowed_origins 现在是占位符 —— 装上扩展后重跑本脚本会自动修正'
  fi
else
  step 3 '跳过原生宿主（--skip-native）'
  warn '扩展断线后要等 alarm 唤醒（最多 60 秒）才重连'
fi

# ── 4. 扩展 ──────────────────────────────────────────────────────────
step 4 '加载浏览器扩展（必须手动）'

echo ''
echo '    扩展目录：'
echo "      $TARGET/extension"
echo ''
echo '    1. 地址栏打开  chrome://extensions'
echo '    2. 右上角开启「开发者模式」'
echo '    3. 点「加载已解压的扩展程序」'
echo '    4. 选择上面那个 extension 目录'
echo ''
echo '    Edge / Brave / Chromium / 360 同样操作。'

# ── 5. 启用插件 ──────────────────────────────────────────────────────
step 5 '启用插件'

CORDIS="$PROFILE_DIR/cordis.patch.yml"
if [ -f "$CORDIS" ] && grep -q 'dsh-session-bridge' "$CORDIS"; then
  ok 'cordis.patch.yml 里已存在，跳过'
else
  echo ''
  echo "    需要在 $CORDIS 末尾追加："
  echo ''
  cat <<'YAML'
- insert:
    - id: dsh-session-bridge
      name: dsh-session-bridge
      inject: [ systemPrompt, tools ]
      config: {}
YAML
  echo ''
  if [ "$ASSUME_YES" -eq 0 ]; then
    printf '    自动追加？(Y/n) '
    read -r ans
    case "$ans" in [nN]*) ans=n ;; *) ans=y ;; esac
  else
    ans=n
  fi
  if [ "$ans" = y ]; then
    cp "$CORDIS" "$CORDIS.bak-dshsession-$(date +%Y%m%d%H%M%S)"
    cat >> "$CORDIS" <<'YAML'

- insert:
    - id: dsh-session-bridge
      name: dsh-session-bridge
      inject: [ systemPrompt, tools ]
      config: {}
YAML
    ok '已追加'
  else
    warn '跳过（记得手动加，否则插件不会加载）'
  fi
fi

# ── 6. 自检 ──────────────────────────────────────────────────────────
step 6 '自检'

cd "$TARGET"
node doctor.mjs || true

echo ''
echo '    下一步：'
echo '      1. 完全退出 DSH，再重新启动'
echo '      2. 在 DSH 里说：browser_status'
echo ''
echo '    卡住了看 TROUBLESHOOTING.md'
echo ''
