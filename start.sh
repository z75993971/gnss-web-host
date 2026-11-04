#!/bin/bash
# =============================================================
# GNSS 上位机 启动脚本
# 用法：bash start.sh        正常启动
#       bash start.sh demo   仿真模式（无硬件演示）
# =============================================================

cd "$(dirname "$0")" || exit 1
PORT=8765
MODE="${1:-}"
URL="http://127.0.0.1:${PORT}/"
[ "$MODE" = "demo" ] && URL="${URL}?demo=1"

echo "GNSS 上位机"
echo "----------------------------------------"

# 端口已被占用则直接复用（避免重复起服务）
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "服务已在端口 $PORT 运行，直接复用"
else
  echo "启动本地服务 127.0.0.1:$PORT ..."
  # server.py 在静态托管之外还提供地图代理和 NTRIP 差分通道
  nohup python3 server.py --port "$PORT" >/tmp/gnss-web.log 2>&1 &
  echo $! > /tmp/gnss-web.pid
  sleep 1
fi

# 检查服务是否真的起来了
if ! curl -s -o /dev/null "http://127.0.0.1:${PORT}/"; then
  echo "服务启动失败，请检查端口 $PORT 是否被占用"
  exit 1
fi
echo "服务正常"

# 必须用 Chromium 内核浏览器，Safari 不支持 Web Serial
BROWSER=""
if [ -d "/Applications/Microsoft Edge.app" ]; then
  BROWSER="Microsoft Edge"
elif [ -d "/Applications/Google Chrome.app" ]; then
  BROWSER="Google Chrome"
elif command -v google-chrome >/dev/null 2>&1; then
  BROWSER="google-chrome"
elif command -v chromium >/dev/null 2>&1; then
  BROWSER="chromium"
fi

if [ -z "$BROWSER" ]; then
  echo "未找到 Chromium 内核浏览器。请手动用 Edge / Chrome 打开：$URL"
  exit 1
fi

if command -v open >/dev/null 2>&1; then
  open -a "$BROWSER" "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 &
else
  "$BROWSER" "$URL" >/dev/null 2>&1 &
fi
echo "已在 $BROWSER 打开：$URL"
echo
echo "首次使用：点页面右上角「连接串口」，选中你的接收机；不确定波特率就点「侦测」"
echo "停止服务：bash stop.sh"
