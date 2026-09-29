#!/usr/bin/env bash
# sync-aliyun-bundle.sh —— aliyun 部署机与 GitHub 的离线同步工具（git bundle + ssh）
#
# 背景：aliyun（47.111.180.58）直连 GitHub 的 git 协议端点（github.com:443）会持续超时挂起，
#       git bundle + ssh 已在本交付中验证可用（两端 SHA 一致）。本脚本把该机制固化：
#         push       本机(main，应已与 GitHub 同步) → aliyun ~/work/cybercafe
#         pull       aliyun 独有的提交 → 本机（不自动 push）
#         push-back  aliyun 侧提交（经本机）推送到 GitHub
#         status     三方 SHA 对比（本机 / GitHub / aliyun），只读不修改
#   安全约定：全程绝不 force / reset / 覆盖；仅在 fast-forward 时自动合并，
#   任一侧有独有提交导致分叉时一律拒绝并给出指引，杜绝覆盖丢提交。
#
# 用法（在 cybercafe 仓库根目录下执行）:
#   scripts/sync-aliyun-bundle.sh status
#   scripts/sync-aliyun-bundle.sh push
#   scripts/sync-aliyun-bundle.sh pull
#   scripts/sync-aliyun-bundle.sh push-back
# 可选环境变量：
#   SYNC_HOST=aliyun        ssh 别名（默认 aliyun，本机 ~/.ssh/config）
#   SYNC_DIR=~/work/cybercafe   aliyun 上的仓库路径
#   SYNC_BRANCH=main       同步分支
set -euo pipefail

HOST="${SYNC_HOST:-aliyun}"
DIR="${SYNC_DIR:-/root/work/cybercafe}"   # aliyun ssh 用户为 root；SYNC_DIR 覆盖时请用绝对路径
BRANCH="${SYNC_BRANCH:-main}"
REMOTE_URL="https://github.com/zcr268/cybercafe.git"
BUNDLE="/tmp/cybercafe-${BRANCH}.bundle"

say() { printf '\033[1;34m[cybercafe-sync]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[cybercafe-sync ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

check_ssh() {
  ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" 'true' \
    || die "无法 ssh 到 ${HOST}（检查 ~/.ssh/config 别名与密钥）"
}

local_head()  { git rev-parse HEAD; }
remote_head() { git ls-remote "$REMOTE_URL" "refs/heads/$BRANCH" | awk '{print $1}'; }
aliyun_head() { ssh "$HOST" "cd $DIR && git rev-parse $BRANCH 2>/dev/null || echo MISSING"; }

cmd_status() {
  local lh rh ah
  lh=$(local_head); rh=$(remote_head)
  ah=$(aliyun_head 2>/dev/null) || ah="<ssh 不可达>"
  say "本机  $BRANCH = $lh"
  say "GitHub $BRANCH = $rh"
  say "aliyun $BRANCH = $ah"
  if [ "$ah" = "$rh" ]; then say "aliyun ↔ GitHub 一致 ✓"; else say "aliyun ↔ GitHub 不一致（落后或分叉）"; fi
  if [ "$lh" = "$rh" ]; then say "本机 ↔ GitHub 一致 ✓"; else say "本机 ↔ GitHub 不一致（先 git merge --ff-only origin/${BRANCH}）"; fi
  if [ "$lh" = "$ah" ]; then say "本机 ↔ aliyun 一致 ✓"; fi
}

bundle_from_local() {
  git status --porcelain | grep -q . && die "本机工作区有未提交改动，请先 commit 或 stash"
  say "创建 bundle（${BRANCH}）..."
  git bundle create "$BUNDLE" "$BRANCH" >/dev/null
}

apply_bundle_aliyun() {
  # bundle 已传至 aliyun ${BUNDLE}：verify → fetch 到 refs/remotes/bundle/<branch> → 仅 ff 合并
  ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
cd "$DIR"
git bundle verify "$BUNDLE" >/dev/null 2>&1 || { echo "bundle verify 失败" >&2; exit 1; }
git fetch "$BUNDLE" "$BRANCH:refs/remotes/bundle/$BRANCH" -q
new=\$(git rev-parse refs/remotes/bundle/$BRANCH)
cur=\$(git rev-parse "$BRANCH")
if [ "\$new" = "\$cur" ]; then echo "ALREADY: $BRANCH 已是 \$new"; exit 0; fi
if git merge-base --is-ancestor "\$cur" "\$new" 2>/dev/null; then
  git merge --ff-only refs/remotes/bundle/$BRANCH -q
  echo "FF: \$cur -> \$new"
else
  echo "CONFLICT: aliyun $BRANCH (\$cur) 与 bundle (\$new) 分叉，拒绝自动合并；先在本机执行 pull 把 aliyun 提交带回处理" >&2
  exit 1
fi
REMOTE
}

cmd_push() {
  check_ssh
  bundle_from_local
  say "传输 bundle 到 $HOST ..."
  scp -q "$BUNDLE" "$HOST:$BUNDLE"
  apply_bundle_aliyun
  rm -f "$BUNDLE"
  say "推送完成，验证："
  cmd_status
}

bundle_from_aliyun() {
  check_ssh
  ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
cd "$DIR"
if git status --porcelain | grep -q .; then echo "aliyun 工作区有未提交改动，请先在 aliyun 上处理" >&2; exit 1; fi
git bundle create "$BUNDLE" "$BRANCH" >/dev/null
echo "aliyun bundle 就绪"
REMOTE
  scp -q "$HOST:$BUNDLE" "$BUNDLE"
}

apply_bundle_local() {
  git bundle verify "$BUNDLE" >/dev/null 2>&1 || die "bundle verify 失败"
  git fetch "$BUNDLE" "$BRANCH:refs/remotes/bundle/$BRANCH" -q
  local new cur
  new=$(git rev-parse "refs/remotes/bundle/$BRANCH")
  cur=$(git rev-parse "$BRANCH")
  if [ "$new" = "$cur" ]; then say "本机 $BRANCH 已是 $new"; return; fi
  if git merge-base --is-ancestor "$cur" "$new" 2>/dev/null; then
    git merge --ff-only "refs/remotes/bundle/$BRANCH" -q
    say "FF: $cur -> $new"
  else
    die "本机 $BRANCH ($cur) 与 aliyun ($new) 分叉，拒绝自动合并；请手工 merge 后处理"
  fi
}

cmd_pull() {
  bundle_from_aliyun
  apply_bundle_local
  rm -f "$BUNDLE"
  say "pull 完成：本机 $BRANCH 已含 aliyun 提交（尚未推 GitHub）"
}

cmd_push_back() {
  cmd_pull
  say "推送到 GitHub ..."
  git push origin "$BRANCH"
  say "验证："
  cmd_status
}

case "${1:-}" in
  status)    cmd_status ;;
  push)      cmd_push ;;
  pull)      cmd_pull ;;
  push-back) cmd_push_back ;;
  *) die "用法: $0 {status|push|pull|push-back}" ;;
esac
