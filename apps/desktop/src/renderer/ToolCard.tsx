import type { ChatTool } from "./events.js";

export interface ToolCardProps {
  tool: ChatTool;
}

/** One tool call: the summary stays visible, the output collapses once the call settles. */
export function ToolCard({ tool }: ToolCardProps) {
  const title = tool.title === "" ? tool.id : tool.title;
  const running = tool.status === "running";
  return (
    <li className="tool" data-testid="tool-card" data-status={tool.status}>
      <details open={running}>
        <summary>
          <strong>{title}</strong>
          <span className="tool-status">{tool.status}</span>
        </summary>
        {tool.output === "" ? <p className="tool-empty">No output yet.</p> : <pre>{tool.output}</pre>}
      </details>
    </li>
  );
}
