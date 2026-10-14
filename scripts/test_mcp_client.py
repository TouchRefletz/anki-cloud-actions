import urllib.request
import json
import ssl

ctx = ssl.create_default_context()
URL = "https://croak-grinch-luxury.ngrok-free.dev/"

def send_rpc(payload, session_id=None):
    headers = {
        "ngrok-skip-browser-warning": "true",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": "curl/8.0.0"
    }
    if session_id:
        headers["mcp-session-id"] = session_id
    
    req = urllib.request.Request(
        URL,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST"
    )
    with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
        sess = resp.headers.get("mcp-session-id") or session_id
        raw = resp.read().decode("utf-8")
        lines = raw.strip().split("\n")
        data_lines = [line[5:].strip() for line in lines if line.startswith("data:")]
        if data_lines:
            return json.loads("\n".join(data_lines)), sess
        else:
            return json.loads(raw), sess

# 1. Initialize
init_payload = {
    "jsonrpc": "2.0",
    "method": "initialize",
    "params": {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "antigravity-tester", "version": "1.0.0"}
    },
    "id": 1
}
res, sess = send_rpc(init_payload)
print("1. INITIALIZE RESPONSE:")
print(json.dumps(res, indent=2))
print("Session ID:", sess)

# 2. Initialized Notification
notif_payload = {
    "jsonrpc": "2.0",
    "method": "notifications/initialized",
    "params": {}
}
try:
    send_rpc(notif_payload, session_id=sess)
    print("\n2. NOTIFICATION INITIALIZED SENT")
except Exception as e:
    print("\nNotification (optional):", e)

# 3. Tools List
tools_payload = {
    "jsonrpc": "2.0",
    "method": "tools/list",
    "params": {},
    "id": 2
}
tools_res, _ = send_rpc(tools_payload, session_id=sess)
print("\n3. TOOLS LIST:")
tools = tools_res.get("result", {}).get("tools", [])
print(f"Total tools found: {len(tools)}")
for t in tools:
    name = t.get("name")
    desc = t.get("description", "")
    print(f" - {name}: {desc[:80]}")

# 4. Call a tool: Let's find deck listing tool or get deck names
deck_tool = None
for candidate in ["get_deck_names", "list_decks", "get_decks", "deck_names"]:
    for t in tools:
        if candidate in t.get("name", ""):
            deck_tool = t.get("name")
            break
    if deck_tool:
        break

if not deck_tool and tools:
    deck_tool = tools[0].get("name")

if deck_tool:
    print(f"\n4. TESTING TOOL CALL: {deck_tool}")
    call_payload = {
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": {
            "name": deck_tool,
            "arguments": {}
        },
        "id": 3
    }
    call_res, _ = send_rpc(call_payload, session_id=sess)
    print("TOOL RESULT:")
    print(json.dumps(call_res, indent=2))
