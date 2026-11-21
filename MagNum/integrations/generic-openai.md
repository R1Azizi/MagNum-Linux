# Goddot & OpenAI-compatible clients

When MagNum is running, the backend exposes an OpenAI-compatible API:

- `GET  /v1/models` — returns `magnum-agent`
- `POST /v1/chat/completions` — accepts standard OpenAI messages array

## How to call a MagNum tool

Send a user message whose content starts with `TOOL_CALL:<tool_name>` followed by a JSON arguments object:

    TOOL_CALL:read_files
    {"files": ["README.md"]}

MagNum runs the tool against the currently-open workspace and returns the result as an assistant message.

## Example

    curl -s http://127.0.0.1:5454/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -d '{
        "model": "magnum-agent",
        "messages": [{
          "role": "user",
          "content": "TOOL_CALL:search_code\\n{\\"query\\":\\"function main\\"}"
        }]
      }' | jq

## Discovery of tools

For a full tool schema list call `GET /mcp/info`, or send `POST /mcp` with `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`.

## Notes

- No API key required; the port is 127.0.0.1 only.
- The shim is stateless; every call runs a fresh tool invocation on `currentTools` (the workspace currently open inside MagNum).
