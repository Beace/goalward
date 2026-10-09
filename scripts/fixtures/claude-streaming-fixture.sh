#!/bin/sh
# Offline native QA fixture. Register explicitly as a Claude adapter only for QA.
# Ignores CLI options/prompt, never connects to a model or the network.
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    printf '%s\n' 'Goalward offline Claude stream fixture 1.0'
    exit 0
  fi
done

emit() { printf '%s\n' "$1"; }
pause() { sleep 1; }

emit '{"type":"system","subtype":"init","session_id":"offline-fixture-session","tools":["WebSearch"],"model":"offline-fixture"}'
pause
emit '{"type":"stream_event","event":{"type":"message_start","message":{"id":"fixture-message-1","type":"message","role":"assistant","content":[],"model":"offline-fixture","stop_reason":null}}}'
emit '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}'
emit '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我先查看"}}}'
pause
# Deliberately split one JSON record across two writes to exercise framing.
printf '%s' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"'
sleep 0.2
printf '%s\n' '相关信息，"}}}'
pause
emit '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"再整理为简短摘要。"}}}'
emit '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}'
pause
emit '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"fixture-search-1","name":"WebSearch","input":{}}}}'
emit '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"离线流式验收示例\"}"}}}'
emit '{"type":"stream_event","event":{"type":"content_block_stop","index":1}}'
emit '{"type":"stream_event","event":{"type":"message_stop"}}'
emit '{"type":"assistant","message":{"id":"fixture-message-1","role":"assistant","content":[{"type":"text","text":"我先查看相关信息，再整理为简短摘要。"},{"type":"tool_use","id":"fixture-search-1","name":"WebSearch","input":{"query":"离线流式验收示例"}}]}}'
sleep 2
emit '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"fixture-search-1","content":"本结果来自离线 fixture，没有访问网络。","is_error":false}]}}'
pause
emit '{"type":"stream_event","event":{"type":"message_start","message":{"id":"fixture-message-2","type":"message","role":"assistant","content":[],"model":"offline-fixture","stop_reason":null}}}'
emit '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}'
emit '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"## 流式输出验收\n\n"}}}'
pause
emit '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"这段文字分批到达，"}}}'
pause
emit '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"应用应在进程结束前展示。\n\n"}}}'
pause
emit '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"搜索阶段是离线模拟，没有调用模型，也没有访问网络。"}}}'
emit '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}'
emit '{"type":"stream_event","event":{"type":"message_stop"}}'
emit '{"type":"assistant","message":{"id":"fixture-message-2","role":"assistant","content":[{"type":"text","text":"## 流式输出验收\n\n这段文字分批到达，应用应在进程结束前展示。\n\n搜索阶段是离线模拟，没有调用模型，也没有访问网络。"}]}}'
emit '{"type":"result","subtype":"success","is_error":false,"session_id":"offline-fixture-session","result":"## 流式输出验收\n\n这段文字分批到达，应用应在进程结束前展示。\n\n搜索阶段是离线模拟，没有调用模型，也没有访问网络。","duration_ms":11000,"usage":{"input_tokens":0,"output_tokens":0}}'
