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
    windsurf: jsonBlock, // ~/.codeium/windsurf/mcp_config.json (mcpServers)
    cline: jsonBlock, // Cline: cline_mcp_settings.json (mcpServers)
    // VS Code's native MCP config uses `servers` (not `mcpServers`) with an explicit transport `type`.
    vscode: JSON.stringify(
      { servers: { legalbody: { type: "http", url: mcpUrl, headers: { Authorization: auth } } } },
      null,
      2,
    ),
    // Claude Desktop's config file speaks stdio; reach a remote HTTP server through the `mcp-remote` bridge
    // (or use Settings > Connectors > Add custom connector with the URL + header).
    claudeDesktop: JSON.stringify(
      {
        mcpServers: {
          legalbody: {
            command: "npx",
            args: ["-y", "mcp-remote", mcpUrl, "--header", `Authorization: ${auth}`],
          },
        },
      },
      null,
      2,
    ),
    // Any MCP client: the raw endpoint + auth header. MCP client config formats are young and still
    // shifting — verify the client-specific snippets above against current docs; this generic form and the
    // Claude Code CLI are the most stable.
    generic: JSON.stringify({ url: mcpUrl, headers: { Authorization: auth } }, null, 2),
    hermes: jsonBlock, // Hermes MCP config — assumed standard mcpServers form (not independently verified)
  };
}
