#!/usr/bin/env bash
# QQ Linux 通知补丁安装器(/opt/QQ 版,适用于官方 deb/rpm/pacman 安装)
# 安装:sudo ./install.sh
# 卸载:sudo ./install.sh --restore
set -e

QQDIR="/opt/QQ/resources/app"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP="$QQDIR/package.json.pristine"

if [ "$1" = "--restore" ]; then
  [ "$(id -u)" = 0 ] || { echo "请用 sudo 运行"; exit 1; }
  if [ -f "$BACKUP" ]; then
    cp "$BACKUP" "$QQDIR/package.json"
    rm -f "$QQDIR/qq_main_hook.js" "$QQDIR/qq-notifier-main.js" "$QQDIR/qq-notifier-preload.js"
    echo "✓ 已恢复原版 package.json 并移除补丁文件。重启 QQ 生效。"
  else
    echo "未找到备份(可能从未安装过),无需恢复。"
  fi
  exit 0
fi

[ "$(id -u)" = 0 ] || { echo "请用 sudo 运行(安装到 /opt/QQ)"; exit 1; }
[ -d "$QQDIR" ] || { echo "未找到 $QQDIR(需 /opt/QQ 版 QQ 3.2.34)"; exit 1; }
[ -f "$SRC/qq-notifier-main.js" ] && [ -f "$SRC/qq-notifier-preload.js" ] || { echo "补丁文件缺失"; exit 1; }

# 首次安装时备份原版 package.json
[ -f "$BACKUP" ] || cp "$QQDIR/package.json" "$BACKUP"

# 安装补丁本体
cp "$SRC/qq-notifier-main.js" "$QQDIR/qq-notifier-main.js"
cp "$SRC/qq-notifier-preload.js" "$QQDIR/qq-notifier-preload.js"

# 主进程入口:补丁 → 原启动链
cat > "$QQDIR/qq_main_hook.js" <<'EOF'
require('./qq-notifier-main.js');
module.exports = require('./application.asar/app_launcher/index.js');
EOF

# package.json main 指向补丁入口
python3 - <<PYEOF
import json
p = "$QQDIR/package.json"
d = json.load(open(p))
d["main"] = "./qq_main_hook.js"
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
print("package.json main ->", d["main"])
PYEOF

echo "✓ 安装完成(v$(cat "$SRC/VERSION" 2>/dev/null || echo 6.6))。重启 QQ 生效。"
echo "  行为:QQ 无焦点/最小化时新消息弹系统通知;免打扰会话不弹;点击通知打开对应会话。"
echo "  日志:~/.qq-notify-patch.log"
echo "  注意:QQ 升级覆盖 /opt/QQ 后需重新安装(文件在,package.json 会被还原)。"
