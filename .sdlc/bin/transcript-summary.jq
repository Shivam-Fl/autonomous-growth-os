# What an agent step did, from claude-code-action's execution file — for agent-transcript.mjs.
# Run with `jq -s`: the file is one JSON array (or JSON lines), and the slurp covers both.
# It runs in the agent's own job, after the framework check, so it is jq and not node: a node
# started there after the agent had a shell can be hijacked through $GITHUB_ENV.
(if length == 1 and (.[0] | type) == "array" then .[0] else . end) as $all
| [ $all[] | select(.type == "assistant") ] as $a
| ([ $all[] | select(.type == "user") | .message.content[]? | select(.type == "tool_result") ]
    | map({ key: .tool_use_id, value: . }) | from_entries) as $r
| {
    tools: ([ $a[] | .message.content[]? | select(.type == "tool_use") | .name ]
      | group_by(.) | map({ key: .[0], value: length }) | from_entries),
    writes: [ $a[] | .message.content[]? | select(.type == "tool_use" and (.name == "Write" or .name == "Edit"))
      | { tool: .name, path: (.input.file_path // "?"),
          bytes: ((.input.content // .input.new_string // "") | length),
          error: (if $r[.id].is_error then ($r[.id].content | if type == "array" then map(.text // "") | join(" ") else tostring end)[0:200] else null end) } ],
    stop: ([ $a[] | .message.stop_reason // empty ] | last),
    result: ([ $all[] | select(.type == "result") | { subtype, is_error, num_turns } ] | last),
    reply: ([ $a[] | .message.content[]? | select(.type == "text") | .text ] | last // "")
  }
