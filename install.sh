#!/system/bin/sh
# 草爬子（aihub-checkin 2.0）安装脚本 —— DSHM 端侧
#
# 用法：
#   DSH_HOME="$DSH_HOME" sh install.sh
#
# 做四件事：
#   1. 找到 profile 目录（$DSH_HOME/profiles/*/，且带 cordis.yml 与 @deepseek-ai）
#   2. 把插件复制进 <profile>/node_modules/aihub-checkin
#   3. 往 $DSH_HOME/cordis.patch.yml 追加一行 insert（已存在则跳过，改前先备份）
#   4. 把新增文件的属主改回 profile 的属主（防止以 root 运行后应用读不到）
#
# 装完必须重启 DSHM 应用。

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
H=${DSH_HOME:-}

if [ -z "$H" ] || [ ! -d "$H" ]; then
  echo "找不到 DSH_HOME。请显式传入，例如：DSH_HOME=/data/.../dsh/home sh install.sh" >&2
  exit 1
fi

PROFILE=""
for d in "$H"/profiles/*/; do
  [ -d "$d" ] || continue
  [ -f "$d/cordis.yml" ] || continue
  [ -d "$d/node_modules/@deepseek-ai" ] || continue
  PROFILE=${d%/}
  break
done
if [ -z "$PROFILE" ]; then
  echo "在 $H/profiles/*/ 下没找到 profile 目录（需要同时有 cordis.yml 和 node_modules/@deepseek-ai）" >&2
  exit 1
fi
echo "[1/4] profile: $PROFILE"

PREV_UID=$(stat -c %u "$PROFILE" 2>/dev/null || true)
PREV_GID=$(stat -c %g "$PROFILE" 2>/dev/null || true)

DST="$PROFILE/node_modules/aihub-checkin"
rm -rf "$DST"
mkdir -p "$DST/lib"
cp "$HERE/index.js" "$DST/index.js" || exit 1
cp "$HERE/libseat.js" "$DST/libseat.js" || exit 1
cp "$HERE/package.json" "$DST/package.json" || exit 1
cp "$HERE/README.md" "$DST/README.md" || exit 1
cp "$HERE/lib/client.js" "$DST/lib/client.js" || exit 1
chmod 644 "$DST/index.js" "$DST/libseat.js" "$DST/package.json" "$DST/README.md" "$DST/lib/client.js" 2>/dev/null || true
chmod 755 "$DST" "$DST/lib" 2>/dev/null || true
if [ -n "$PREV_UID" ]; then chown -R "$PREV_UID:$PREV_GID" "$DST" 2>/dev/null || true; fi
echo "[2/4] 已复制到 $DST"

PATCH="$H/cordis.patch.yml"
if [ -f "$PATCH" ] && grep -q "id: aihub-checkin" "$PATCH"; then
  echo "[3/4] patch 里已有 aihub-checkin 行，跳过"
else
  PUID=$(stat -c %u "$PATCH" 2>/dev/null || echo "$PREV_UID")
  PGID=$(stat -c %g "$PATCH" 2>/dev/null || echo "$PREV_GID")
  if [ -f "$PATCH" ]; then
    cp "$PATCH" "$PATCH.bak-aihub-$(date +%s)" 2>/dev/null || true
  fi
  if [ ! -f "$PATCH" ]; then
    cat > "$PATCH" <<'YAML'
# 草爬子：AI Hub 签到 + 图书馆抢座（aihub-checkin）
- insert:
    - id: aihub-checkin
      name: aihub-checkin
YAML
  elif grep -Eq '^\[[[:space:]]*\][[:space:]]*$' "$PATCH"; then
    cat > "$PATCH" <<'YAML'
# 草爬子：AI Hub 签到 + 图书馆抢座（aihub-checkin）
- insert:
    - id: aihub-checkin
      name: aihub-checkin
YAML
  else
    printf '\n# 草爬子：AI Hub 签到 + 图书馆抢座（aihub-checkin）\n- insert:\n    - id: aihub-checkin\n      name: aihub-checkin\n' >> "$PATCH"
  fi
  chmod 600 "$PATCH" 2>/dev/null || true
  if [ -n "$PUID" ]; then chown "$PUID:$PGID" "$PATCH" 2>/dev/null || true; fi
  echo "[3/4] 已写入 $PATCH"
fi

OK=1
[ -f "$DST/index.js" ] || OK=0
[ -f "$DST/libseat.js" ] || OK=0
[ -f "$DST/lib/client.js" ] || OK=0
[ -f "$DST/package.json" ] || OK=0
grep -q "id: aihub-checkin" "$PATCH" 2>/dev/null || OK=0
if [ "$OK" = "1" ]; then
  echo "[4/4] 校验通过"
  echo ""
  echo "安装完成。下一步："
  echo "  1) 重启 DSHM 应用（必须，插件在启动时挂载）"
  echo "  2) 打开 设置 → 草爬子，填图书馆学工号 / 密码，选好座位优先级"
  echo "  3) AI Hub 那边对助手说「登录 aihub」扫码一次"
else
  echo "[4/4] 校验失败：文件或 patch 行缺失，请检查上面的输出" >&2
  exit 2
fi
