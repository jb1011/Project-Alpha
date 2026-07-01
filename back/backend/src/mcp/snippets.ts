export interface ConnectionInfo {
  mcpUrl: string;
  apiKey: string;
}

/** Per-agent "paste-here" MCP config for the same universal server. Claude Code is the flagship. */
export function buildSnippets({ mcpUrl, apiKey }: ConnectionInfo) {
  const auth = `Bearer ${apiKey}`;
  const jsonEntry = { legalbody: { url: mcpUrl, headers: { Authorization: auth } } };
  const jsonBlock = JSON.stringify({ mcpServers: jsonEntry }, null, 2);
  return {
    claudeCode: `claude mcp add legalbody --transport http ${mcpUrl} --header "Authorization: ${auth}"`,
    cursor: jsonBlock, // ~/.cursor/mcp.json
    codex: jsonBlock, // Codex MCP config
    openclaw: jsonBlock, // OpenClaw MCP config
    gemini: jsonBlock, // Gemini CLI settings.json mcpServers
    generic: JSON.stringify({ url: mcpUrl, headers: { Authorization: auth } }, null, 2),
  };
}
