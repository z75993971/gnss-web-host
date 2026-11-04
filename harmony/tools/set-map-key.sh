#!/bin/bash
# 把高德地图 Key 写进 map.html
#
# 用法：
#   bash tools/set-map-key.sh "你的Key" "你的安全密钥"
#
# Key 必须是「Web端(JS API)」类型。用「Web服务」类型的 Key 地图加载不出来，
# 那是给服务端拉静态图用的，两回事。
#
# 安全密钥（jscode）不是必须的，留空也能加载；有就一并填上。
# 这个脚本改的是工作副本，别把改完的文件提交上去 —— 仓库里应当始终是占位符。

set -u

KEY="${1:-}"
SECRET="${2:-}"
HTML="$(cd "$(dirname "$0")/.." && pwd)/UM621Collector/entry/src/main/resources/rawfile/map.html"

if [ -z "$KEY" ]; then
  echo "用法：bash tools/set-map-key.sh \"你的Key\" \"你的安全密钥\""
  echo ""
  echo "当前 map.html 里的配置："
  grep -E "var AMAP_KEY|var AMAP_SECRET" "$HTML" | sed 's/^ *//'
  exit 1
fi

if [ ! -f "$HTML" ]; then
  echo "找不到 map.html：$HTML"
  exit 1
fi

# 路径可能含中文，用 python 做替换比 sed 稳
python3 - "$HTML" "$KEY" "$SECRET" <<'PY'
import sys, re
path, key, secret = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path, encoding='utf-8').read()

s = re.sub(r"var AMAP_KEY = '[^']*';", "var AMAP_KEY = '%s';" % key, s)
s = re.sub(r"var AMAP_SECRET = '[^']*';", "var AMAP_SECRET = '%s';" % secret, s)

open(path, 'w', encoding='utf-8').write(s)
print("Key 已写入 map.html")
PY

echo ""
echo "已配置："
grep -E "var AMAP_KEY|var AMAP_SECRET" "$HTML" | sed 's/^ *//'
echo ""
echo "下一步：bash tools/build.sh"
echo "注意：提交前把 Key 改回 __AMAP_KEY__ 占位符，别把账号资产推上去。"
