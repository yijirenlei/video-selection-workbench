#!/bin/zsh
set -eu

cd -- "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

address="http://127.0.0.1:8732"
server_pid=""
if ! curl -fsS --max-time 2 "$address/api/videos" >/dev/null 2>&1; then
  mkdir -p data
  python3 -B server.py </dev/null >>data/server.log 2>&1 &
  server_pid=$!
  trap 'kill "$server_pid" 2>/dev/null || true' EXIT
  for attempt in {1..30}; do
    if curl -fsS --max-time 1 "$address/api/videos" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
fi

if ! curl -fsS --max-time 2 "$address/api/videos" >/dev/null 2>&1; then
  print -u2 '选片台启动失败。错误记录在 data/server.log。'
  tail -n 12 data/server.log >&2
  exit 1
fi

print "视频选片台已启动 $address"
if [[ "${1:-}" != "--no-browser" ]]; then
  open "$address"
fi
if [[ -n "$server_pid" ]]; then
  print '使用期间请保持这个窗口打开。'
  wait "$server_pid"
fi
