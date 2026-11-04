#!/bin/bash
# 鸿蒙采集器 —— 命令行编译脚本
#
# 为什么需要这个脚本，两件事都有实测原因：
#   1. 鸿蒙工具链不接受含中文或空格的工程路径（报 00306003 Invalid project path）。
#      源码放在工作区里方便看，所以每次编译先同步到纯英文的临时目录再编。
#   2. 某些宿主环境会往 NODE_OPTIONS 注入 node shim，导致 hvigor 的 node 进程
#      去连 IPC 并刷一屏 EPIPE，必须清掉。
#
# 用法：
#   bash tools/build.sh              # debug
#   bash tools/build.sh release      # release（无签名也能编，装机才要签名）

set -u

MODE="${1:-debug}"
SRC="$(cd "$(dirname "$0")/.." && pwd)/UM621Collector"
BUILD_ROOT="$HOME/harmony-build"
DST="$BUILD_ROOT/UM621Collector"
DEVECO="${DEVECO_HOME:-/Applications/DevEco-Studio.app/Contents}"

if [ ! -d "$SRC" ]; then
  echo "找不到工程目录：$SRC"
  exit 1
fi
if [ ! -d "$DEVECO" ]; then
  echo "找不到 DevEco Studio：$DEVECO"
  echo "装了以后如果不是这个路径，用 DEVECO_HOME 指定，例如："
  echo "  DEVECO_HOME=/opt/deveco/Contents bash tools/build.sh"
  exit 1
fi

echo "=== 1/3 同步源码到英文路径 ==="
echo "  源   $SRC"
echo "  目标 $DST"
mkdir -p "$DST"
rsync -a --delete \
  --exclude '.hvigor' --exclude 'build' --exclude 'oh_modules' \
  --exclude 'node_modules' --exclude '.idea' --exclude 'local.properties' \
  "$SRC/" "$DST/"

echo ""
echo "=== 2/3 准备工具链 ==="
export DEVECO_SDK_HOME="$DEVECO/sdk"
export JAVA_HOME="$DEVECO/jbr/Contents/Home"
export NODE_HOME="$DEVECO/tools/node"
export PATH="$NODE_HOME/bin:$DEVECO/tools/hvigor/bin:$DEVECO/sdk/default/openharmony/toolchains:$PATH"
# 清掉宿主注入的 node shim，否则 hvigor 会刷一屏 EPIPE
unset NODE_OPTIONS
unset NODE_PATH
echo "  node   $(node -v 2>/dev/null)"
echo "  hvigor $(hvigorw -v 2>/dev/null | tail -1)"
echo "  hdc    $(command -v hdc)"

echo ""
echo "=== 3/3 编译（${MODE}）==="
cd "$DST" || exit 1
LOG="$DST/build-output.log"
hvigorw assembleHap --mode module -p product=default -p buildMode="$MODE" --no-daemon > "$LOG" 2>&1
RC=$?

# 只挑关键行，别让日志刷屏
echo ""
grep -E "BUILD (SUCCESSFUL|FAILED)|ERROR|error:|Error Message|arkts-|\.ets:[0-9]+" "$LOG" 2>/dev/null \
  | grep -v "EPIPE\|ERR_STREAM_DESTROYED" | head -40

echo ""
if [ $RC -eq 0 ] && grep -q "BUILD SUCCESSFUL" "$LOG" 2>/dev/null; then
  echo "=== 编译成功 ==="
  HAP=$(find "$DST/entry/build" -name "*.hap" -type f 2>/dev/null | head -1)
  if [ -n "$HAP" ]; then
    echo "产物：$HAP"
    ls -lh "$HAP"
    OUTDIR="$SRC/../产物"
    mkdir -p "$OUTDIR"
    cp "$HAP" "$OUTDIR/" 2>/dev/null && echo "已复制到：$OUTDIR/$(basename "$HAP")"
  fi
else
  echo "=== 编译失败 ==="
  echo "完整日志：$LOG"
  echo ""
  echo "--- 最后 30 行 ---"
  grep -v "EPIPE\|ERR_STREAM_DESTROYED\|afterWriteDispatched\|log4js" "$LOG" 2>/dev/null | tail -30
  exit 1
fi
