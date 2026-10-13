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
emit '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I will first review "}}}'
pause
# Deliberately split one JSON record across two writes to exercise framing.
printf '%s' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"'
sleep 0.2
printf '%s\n' 'the relevant information, "}}}'
pause
emit '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"then create a short summary."}}}'
emit '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}'
pause
emit '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"fixture-search-1","name":"WebSearch","input":{}}}}'
emit '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"Offline streaming verification example\"}"}}}'
emit '{"type":"stream_event","event":{"type":"content_block_stop","index":1}}'
emit '{"type":"stream_event","event":{"type":"message_stop"}}'
emit '{"type":"assistant","message":{"id":"fixture-message-1","role":"assistant","content":[{"type":"text","text":"I will first review the relevant information, then create a short summary."},{"type":"tool_use","id":"fixture-search-1","name":"WebSearch","input":{"query":"Offline streaming verification example"}}]}}'
sleep 2
emit '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"fixture-search-1","content":"This result comes from an offline fixture; no network was accessed.","is_error":false}]}}'
pause
emit '{"type":"stream_event","event":{"type":"message_start","message":{"id":"fixture-message-2","type":"message","role":"assistant","content":[],"model":"offline-fixture","stop_reason":null}}}'
emit '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}'
emit '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"## Streaming output verification\n\n"}}}'
pause
emit '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"This text arrives in batches, "}}}'
pause
emit '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"and the app should display it before the process exits.\n\n"}}}'
pause
emit '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"The search stage is an offline simulation with no model or network calls."}}}'
emit '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}'
emit '{"type":"stream_event","event":{"type":"message_stop"}}'
emit '{"type":"assistant","message":{"id":"fixture-message-2","role":"assistant","content":[{"type":"text","text":"## Streaming output verification\n\nThis text arrives in batches, and the app should display it before the process exits.\n\nThe search stage is an offline simulation with no model or network calls."}]}}'
emit '{"type":"result","subtype":"success","is_error":false,"session_id":"offline-fixture-session","result":"## Streaming output verification\n\nThis text arrives in batches, and the app should display it before the process exits.\n\nThe search stage is an offline simulation with no model or network calls.","duration_ms":11000,"usage":{"input_tokens":0,"output_tokens":0}}'
