import type { ReactNode } from "react";
import { shortcutLabel, type Command } from "./commands.js";

/** Where every link here goes; the release rule below refers to the same repository. */
const REPOSITORY = "https://github.com/8kunoir8/NoirHarness";

/** External links leave through the typed preload bridge, as `MarkdownContent` does. */
function openExternally(href: string): void {
  const bridge = window.noir;
  if (bridge !== undefined) void bridge.openExternal(href);
  else window.open(href, "_blank", "noopener,noreferrer");
}

export interface HelpProps {
  version: string;
  /** The kernel build the window talks to; absent where the shell reports no handshake. */
  buildId: string | undefined;
  /** The `Command[]` the shell dispatches; the table is generated from it, never written twice. */
  commands: readonly Command[];
  /** The update row: `UpdateNotice` renders it, so Help only says where it goes. */
  update?: ReactNode | undefined;
}

interface KeyedCommand {
  id: string;
  label: string;
  key: string;
}

/**
 * The page a bug report starts from: which build this is, which keys this build actually
 * dispatches, and where the code lives. Every shortcut comes from the registry, so a key that
 * moves in `App.tsx` moves here with it.
 */
export function Help({ version, buildId, commands, update }: HelpProps) {
  const keyed: KeyedCommand[] = [];
  for (const command of commands) {
    if (command.shortcut === undefined) continue;
    keyed.push({ id: command.id, label: command.label, key: shortcutLabel(command.shortcut) });
  }
  const identity = `${version}${buildId === undefined ? "" : ` · ${buildId.slice(0, 12)}`}`;

  return (
    <section aria-label="Help" className="help">
      <header className="help-header">
        <h2>Help</h2>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(identity).catch(() => undefined)}>
          Copy build info
        </button>
      </header>

      <section className="help-block" aria-label="Running this build">
        <h3>Running this build</h3>
        <dl className="help-facts">
          <dt>Version</dt>
          <dd>{version}</dd>
          <dt>Kernel build</dt>
          <dd className="help-mono">{buildId === undefined ? "not reported" : buildId.slice(0, 12)}</dd>
        </dl>
        <p className="empty">
          A release is a commit that bumps the version plus a tag <code>v&lt;version&gt;</code> pushed to the
          remote; without the tag the update check correctly reports up to date.
        </p>
      </section>

      <section className="help-block" aria-label="Keyboard">
        <h3>Keyboard</h3>
        {keyed.length === 0 ? (
          <p className="empty">No command declares a shortcut.</p>
        ) : (
          <table className="help-keys">
            <thead>
              <tr>
                <th scope="col">Command</th>
                <th scope="col">Key</th>
              </tr>
            </thead>
            <tbody>
              {keyed.map((row) => (
                <tr key={row.id}>
                  <td>{row.label}</td>
                  <td className="help-mono">
                    <kbd>{row.key}</kbd>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {update === undefined ? null : (
        <section className="help-block" aria-label="Updates">
          <h3>Updates</h3>
          {update}
        </section>
      )}

      <section className="help-block" aria-label="Links">
        <h3>Links</h3>
        <ul className="help-links">
          <li>
            <button type="button" className="link" onClick={() => openExternally(REPOSITORY)}>
              Repository
            </button>
          </li>
          <li>
            <button type="button" className="link" onClick={() => openExternally(`${REPOSITORY}#readme`)}>
              README
            </button>
          </li>
          <li>
            <button type="button" className="link" onClick={() => openExternally(`${REPOSITORY}/tree/main/docs`)}>
              Docs
            </button>
          </li>
          <li>
            <button type="button" className="link" onClick={() => openExternally(`${REPOSITORY}/issues`)}>
              Issues
            </button>
          </li>
        </ul>
      </section>
    </section>
  );
}
