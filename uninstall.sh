#!/system/bin/sh
# 草爬子（aihub-checkin）卸载脚本
#
# 用法：DSH_HOME="$DSH_HOME" sh uninstall.sh
# 删除插件目录，并从 $DSH_HOME/cordis.patch.yml 里摘掉对应 insert 块（改前自动备份）。
# 执行后重启应用生效。

set -u

H=${DSH_HOME:-}
if [ -z "$H" ] || [ ! -d "$H" ]; then
  echo "找不到 DSH_HOME。请显式传入，例如：DSH_HOME=/data/.../dsh/home sh uninstall.sh" >&2
  exit 1
fi

PROFILE=""
for d in "$H"/profiles/*/; do
  [ -d "$d" ] || continue
  [ -f "$d/cordis.yml" ] || continue
  PROFILE=${d%/}
  break
done
if [ -z "$PROFILE" ]; then
  echo "没找到 profile 目录" >&2
  exit 1
fi

DST="$PROFILE/node_modules/aihub-checkin"
if [ -d "$DST" ]; then
  rm -rf "$DST"
  echo "已删除 $DST"
else
  echo "插件目录不存在，跳过"
fi

PATCH="$H/cordis.patch.yml"
if [ -f "$PATCH" ] && grep -q "id: aihub-checkin" "$PATCH"; then
  PUID=$(stat -c %u "$PATCH" 2>/dev/null || true)
  PGID=$(stat -c %g "$PATCH" 2>/dev/null || true)
  cp "$PATCH" "$PATCH.bak-aihub-uninstall-$(date +%s)" 2>/dev/null || true
  awk '
    /^# 草爬子/ { skip = 1; next }
    /^# 南林 ACM AI Hub/ { skip = 1; next }
    skip == 1 && /^- insert:/ { next }
    skip == 1 && /id: aihub-checkin/ { next }
    skip == 1 && /name: aihub-checkin/ { skip = 0; next }
    { print }
  ' "$PATCH" > "$PATCH.tmp" && mv "$PATCH.tmp" "$PATCH"
  chmod 600 "$PATCH" 2>/dev/null || true
  if [ -n "${PUID:-}" ]; then chown "$PUID:$PGID" "$PATCH" 2>/dev/null || true; fi
  echo "已从 patch 摘掉 aihub-checkin 行"
else
  echo "patch 里没有 aihub-checkin 行，跳过"
fi

echo ""
echo "卸载完成。重启应用生效；数据目录 \$DSH_HOME/aihub-checkin/ 可手动删除。"
