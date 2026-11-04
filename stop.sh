#!/bin/bash
# 停止 GNSS 上位机的本地服务
PIDFILE=/tmp/gnss-web.pid

if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" && echo "已停止服务（PID $PID）"
    rm -f "$PIDFILE"
    exit 0
  fi
  rm -f "$PIDFILE"
fi

# 没记录 PID 时按端口查找
PID=$(lsof -nP -iTCP:8765 -sTCP:LISTEN -t 2>/dev/null | head -1)
if [ -n "$PID" ]; then
  kill "$PID" && echo "已停止服务（PID $PID）"
else
  echo "服务未在运行"
fi
