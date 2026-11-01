#!/usr/bin/env bash
# AIDrama 数据库每日全量备份
#
# - MySQL：mysqldump 全量（--single-transaction 一致性快照，不锁 InnoDB 表）→ gzip 成 .sql.gz
# - SQLite：sqlite3 .backup 在线热备（库文件快照）→ gzip 成 .db.gz
# - 输出：/var/backups/aidrama/aidrama-<日期>_<时间>.<sql|db>.gz，保留 14 天
# - DB 配置默认从 server/.env 读取（与运行时同源，不会配两遍）
#
# cron 示例（每天 03:15 备份；crontab -e 添加，路径按实际部署调整）：
#   15 3 * * * /usr/share/nginx/xworld-gz/AIDrama/deploy/backup.sh >> /var/log/aidrama-backup.log 2>&1
#
# 恢复步骤见 deploy/DEPLOY.md「备份与恢复」。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"          # AIDrama 根目录
ENV_FILE="$ROOT_DIR/server/.env"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/aidrama}"
KEEP_DAYS=14

# 读 server/.env（只取需要的 KEY，不覆盖已有环境变量）
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      DB_DIALECT|DB_HOST|DB_PORT|DB_NAME|DB_USER|DB_PASSWORD|DB_STORAGE)
        [ -n "${!key:-}" ] || export "$key=$value" ;;
    esac
  done < <(grep -E '^[A-Z_]+=' "$ENV_FILE" || true)
fi

DB_DIALECT="${DB_DIALECT:-sqlite}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-aidrama}"
DB_USER="${DB_USER:-root}"
STAMP="$(date +%Y%m%d_%H%M%S)"

mkdir -p "$BACKUP_DIR"
# 扩展名按内容区分：MySQL 逻辑导出 .sql.gz；SQLite 在线热备是库文件快照 .db.gz
case "$DB_DIALECT" in
  mysql)  EXT="sql" ;;
  sqlite) EXT="db"  ;;
  *) echo "[backup] 未知 DB_DIALECT=$DB_DIALECT，未备份"; exit 1 ;;
esac
OUT="$BACKUP_DIR/aidrama-$STAMP.$EXT.gz"
TMP_SQL="$BACKUP_DIR/.aidrama-$STAMP.$EXT.tmp"
trap 'rm -f "$TMP_SQL"' EXIT

case "$DB_DIALECT" in
  mysql)
    # 密码经环境变量传给 mysqldump，避免出现在进程列表（ps）里
    export MYSQL_PWD="${DB_PASSWORD:-}"
    dump_args=(--single-transaction --quick --routines --triggers
               -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME")
    if command -v mysqldump >/dev/null 2>&1; then
      mysqldump "${dump_args[@]}" > "$TMP_SQL"
    else
      # mysqldump 不在本机时走容器（按实际容器名调整）
      docker exec mysql mysqldump "${dump_args[@]}" > "$TMP_SQL"
    fi
    ;;
  sqlite)
    # DB_STORAGE 相对路径按 server/ 目录解析；绝对路径原样使用。.backup 在线热备，不怕运行中拷贝
    case "$DB_STORAGE" in
      /*)  db_file="$DB_STORAGE" ;;
      ./*) db_file="$ROOT_DIR/server/${DB_STORAGE#./}" ;;
      *)   db_file="$ROOT_DIR/server/$DB_STORAGE" ;;
    esac
    sqlite3 "$db_file" ".backup '$TMP_SQL'"
    ;;
esac

gzip -c "$TMP_SQL" > "$OUT"

# 清理 14 天前的旧备份（MySQL .sql.gz 与 SQLite .db.gz 一并清理）
OLD_COUNT=$(find "$BACKUP_DIR" -name 'aidrama-*.gz' -mtime +$KEEP_DAYS -delete -print | wc -l | tr -d ' ')

if [ -s "$OUT" ]; then
  echo "[backup] OK: $OUT ($(du -h "$OUT" | cut -f1))，清理 $OLD_COUNT 个过期备份（>$KEEP_DAYS 天）"
else
  echo "[backup] FAILED: 备份文件为空 $OUT"
  exit 1
fi
