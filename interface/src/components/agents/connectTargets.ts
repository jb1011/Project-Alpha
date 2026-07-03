import type { ConnectionSnippets } from "@/lib/api/types";

export type ConnectTarget = { key: keyof ConnectionSnippets; label: string; hint: string };

// Claude Code is the flagship (first). Hermes precedes generic; if the backend omits the
// hermes snippet, ConnectionSnippet simply skips rendering its pill.
export const CONNECT_TARGETS: ConnectTarget[] = [
  { key: "claudeCode", label: "Claude Code", hint: "Run this in your terminal." },
  { key: "cursor", label: "Cursor", hint: "Add to ~/.cursor/mcp.json" },
  { key: "codex", label: "Codex", hint: "Add to your Codex MCP config." },
  { key: "windsurf", label: "Windsurf", hint: "Add to ~/.codeium/windsurf/mcp_config.json" },
  { key: "cline", label: "Cline", hint: "Add to cline_mcp_settings.json" },
  { key: "gemini", label: "Gemini CLI", hint: "Add to your Gemini settings.json (mcpServers)." },
  { key: "vscode", label: "VS Code", hint: "Add to .vscode/mcp.json (uses `servers`)." },
  { key: "claudeDesktop", label: "Claude Desktop", hint: "Uses the mcp-remote bridge." },
  { key: "openclaw", label: "OpenClaw", hint: "Add to your OpenClaw MCP config." },
  { key: "hermes", label: "Hermes", hint: "Add to your Hermes MCP config." },
  { key: "generic", label: "Generic", hint: "Raw endpoint + auth header for any MCP client." },
];
