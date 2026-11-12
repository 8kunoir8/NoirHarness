import { useCallback, useEffect, useRef, useState } from "react";
import {
  SkillCheckUpdateResult,
  SkillListResult,
  SkillReadResult,
  type SkillScopeSchema,
  type SkillSourceView,
  type SkillView,
} from "@noir/protocol";
import type { RequestFn } from "./api.js";
import { errorMessage } from "./events.js";

interface SkillsProps {
  workspaceId: string;
  request: RequestFn;
}

interface SkillRef {
  scope: SkillScopeSchema;
  name: string;
}

function sameSkill(left: SkillRef | undefined, right: SkillRef): boolean {
  return left !== undefined && left.scope === right.scope && left.name === right.name;
}

/** The badge is a verdict from the source, never a fact of the listing, so a fresh list clears it. */
function withoutUpdateBadges(result: SkillListResult): SkillListResult {
  return {
    ...result,
    skills: result.skills.map((skill) => {
      const source = skill.source ?? null;
      return source === null ? skill : { ...skill, source: { ...source, updateAvailable: false } };
    }),
  };
}

/** Only the row a check answered for carries its verdict, and the check is the only writer. */
function withUpdateBadge(
  list: SkillListResult,
  skill: SkillRef,
  updateAvailable: boolean,
): SkillListResult {
  return {
    ...list,
    skills: list.skills.map((row) => {
      const source = row.source ?? null;
      if (source === null || row.scope !== skill.scope || row.name !== skill.name) return row;
      return { ...row, source: { ...source, updateAvailable } };
    }),
  };
}

/** The row label: the short commit for a git source, the word itself for a directory. */
function sourceLabel(source: SkillSourceView): string {
  if (source.kind === "local") return "local";
  // A commit-less git row cannot be pinned, so it names no revision rather than claiming to be local.
  return source.commit === null ? "git" : `git ${source.commit.slice(0, 7)}`;
}

function SkillRow({
  skill,
  busy,
  selected,
  pinned,
  confirming,
  onView,
  onToggle,
  onCheckUpdate,
  onRequestUpdate,
  onConfirmUpdate,
  onCancelUpdate,
}: {
  skill: SkillView;
  busy: boolean;
  selected: boolean;
  /** The hash `checkUpdate` fetched, or undefined when this row has no live pin. */
  pinned: string | undefined;
  /** This row is the one whose confirmation is open. */
  confirming: boolean;
  onView: (skill: SkillRef) => void;
  onToggle: (skill: SkillView) => void;
  onCheckUpdate: (skill: SkillView) => void;
  onRequestUpdate: (skill: SkillView) => void;
  onConfirmUpdate: (skill: SkillView) => void;
  onCancelUpdate: (skill: SkillView) => void;
}) {
  const source = skill.source ?? null;
  // A confirmation without a pinned hash would print an arrow to nothing, so it needs both.
  const pinnedHash = pinned ?? "";
  const confirmingUpdate = confirming && pinnedHash !== "";
  return (
    <li className={`skills-row${selected ? " skills-row-selected" : ""}`}>
      <div className="skills-row-head">
        <button
          type="button"
          aria-pressed={selected}
          onClick={() => onView({ scope: skill.scope, name: skill.name })}
        >
          {`View ${skill.name}`}
        </button>
        <strong>{skill.name}</strong>
        <code className="skills-hash" title={skill.hash}>
          {skill.hash.slice(0, 12)}
        </code>
        {source === null ? null : (
          <span className="skills-source" title={source.url}>
            {sourceLabel(source)}
          </span>
        )}
        <button type="button" disabled={busy} onClick={() => onToggle(skill)}>
          {`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
        </button>
        {source === null ? null : confirmingUpdate ? (
          <>
            <span className="skills-confirm">
              {`${skill.name}: ${skill.hash.slice(0, 7)} → ${pinnedHash.slice(0, 7)}`}
            </span>
            <button type="button" disabled={busy} onClick={() => onConfirmUpdate(skill)}>
              {`Confirm update ${skill.name}`}
            </button>
            <button type="button" disabled={busy} onClick={() => onCancelUpdate(skill)}>
              {`Cancel update ${skill.name}`}
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => onCheckUpdate(skill)}>
              {`Check for updates ${skill.name}`}
            </button>
            {source.updateAvailable && pinnedHash !== "" ? (
              <button type="button" disabled={busy} onClick={() => onRequestUpdate(skill)}>
                {`Update ${skill.name}`}
              </button>
            ) : null}
          </>
        )}
      </div>
      {skill.description === "" ? null : <p className="skills-description">{skill.description}</p>}
    </li>
  );
}

/**
 * Skills installed for this machine and workspace. Toggling writes through `skill.setEnabled`
 * and reloads the list, because the kernel is the only source of truth for what an agent sees.
 */
export function Skills({ workspaceId, request }: SkillsProps) {
  const [list, setList] = useState<SkillListResult | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<SkillRef | undefined>(undefined);
  const [body, setBody] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [sourceInput, setSourceInput] = useState("");
  const [installScope, setInstallScope] = useState<"global" | "project">("project");
  // Keyed `scope|name`, because one name can live in both scopes under different pins.
  const [updateHashes, setUpdateHashes] = useState<Record<string, string>>({});
  // The row whose old → new hash is on screen; one confirmation at a time, keyed the same way.
  const [confirming, setConfirming] = useState<string | undefined>(undefined);

  // Any workspace switch bumps this, so a list or body that resolves late is dropped instead of
  // being shown for the wrong workspace.
  const generation = useRef(0);
  const selectionTicket = useRef(0);
  const selection = useRef<SkillRef | undefined>(undefined);

  // `skill.remove` answers with the listing too, but this panel has no remove control, so every
  // refresh goes through here — and a refreshed list never carries a badge of its own.
  const load = useCallback(
    async (ticket: number, workspace: string): Promise<SkillListResult | undefined> => {
      try {
        const result = withoutUpdateBadges(
          SkillListResult.parse(await request<unknown>("skill.list", { workspaceId: workspace })),
        );
        if (generation.current !== ticket) return undefined;
        setList(result);
        setError(undefined);
        return result;
      } catch (loadError) {
        if (generation.current === ticket) setError(errorMessage(loadError));
        return undefined;
      }
    },
    [request],
  );

  useEffect(() => {
    generation.current += 1;
    selectionTicket.current += 1;
    selection.current = undefined;
    setList(undefined);
    setError(undefined);
    setSelected(undefined);
    setBody(undefined);
    setUpdateHashes({});
    setConfirming(undefined);
    if (workspaceId === "") return;
    void load(generation.current, workspaceId);
  }, [workspaceId, load]);

  async function readBody(skill: SkillRef, ticket: number, workspace: string): Promise<void> {
    selectionTicket.current += 1;
    const selectionNow = selectionTicket.current;
    try {
      const result = SkillReadResult.parse(
        await request<unknown>("skill.read", { workspaceId: workspace, scope: skill.scope, name: skill.name }),
      );
      if (generation.current !== ticket || selectionTicket.current !== selectionNow) return;
      setBody(result.content);
      setError(undefined);
    } catch (readError) {
      if (generation.current !== ticket || selectionTicket.current !== selectionNow) return;
      setError(errorMessage(readError));
    }
  }

  function view(skill: SkillRef): void {
    selection.current = skill;
    setSelected(skill);
    setBody(undefined);
    void readBody(skill, generation.current, workspaceId);
  }

  async function toggle(skill: SkillView): Promise<void> {
    const ticket = generation.current;
    const workspace = workspaceId;
    setBusy(true);
    try {
      await request<unknown>("skill.setEnabled", {
        workspaceId: workspace,
        scope: skill.scope,
        name: skill.name,
        enabled: !skill.enabled,
      });
      if (generation.current !== ticket) return;
      const next = await load(ticket, workspace);
      if (next === undefined) return;
      // Keep the viewer in sync when the row the user is reading is the one they just toggled.
      if (sameSkill(selection.current, skill)) void readBody(skill, ticket, workspace);
    } catch (toggleError) {
      if (generation.current !== ticket) return;
      const message = `${skill.name}: ${errorMessage(toggleError)}`;
      // Reload so the row reflects whatever the kernel actually kept after the failed write.
      await load(ticket, workspace);
      if (generation.current !== ticket) return;
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function checkUpdate(skill: SkillView): Promise<void> {
    const ticket = generation.current;
    const workspace = workspaceId;
    const key = `${skill.scope}|${skill.name}`;
    setBusy(true);
    try {
      const result = SkillCheckUpdateResult.parse(
        await request<unknown>("skill.checkUpdate", {
          workspaceId: workspace,
          scope: skill.scope,
          name: skill.name,
        }),
      );
      if (generation.current !== ticket) return;
      // The pin the user will confirm. An unchanged source stores an empty pin, so nothing updates it.
      setUpdateHashes((current) => ({ ...current, [key]: result.changed ? result.hash : "" }));
      // A changed hash is only a badge until the user updates, so the list keeps the old pin.
      setList((current) =>
        current === undefined ? current : withUpdateBadge(current, skill, result.changed),
      );
      setError(undefined);
    } catch (checkError) {
      if (generation.current !== ticket) return;
      setError(errorMessage(checkError));
    } finally {
      setBusy(false);
    }
  }

  async function update(skill: SkillView): Promise<void> {
    const key = `${skill.scope}|${skill.name}`;
    const expectHash = updateHashes[key];
    // No check, or a check that found nothing: the row has no pin to confirm, so it is not updatable.
    if (expectHash === undefined || expectHash === "") return;
    const ticket = generation.current;
    const workspace = workspaceId;
    setBusy(true);
    try {
      await request<unknown>("skill.update", {
        workspaceId: workspace,
        scope: skill.scope,
        name: skill.name,
        expectHash,
      });
      if (generation.current !== ticket) return;
      // The kernel replaced that hash, so the pin is spent: forget it before the row can offer again.
      setUpdateHashes((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setList((current) => (current === undefined ? current : withUpdateBadge(current, skill, false)));
      await load(ticket, workspace);
    } catch (updateError) {
      if (generation.current !== ticket) return;
      setError(errorMessage(updateError));
    } finally {
      // Both outcomes close this row's confirmation, so a failed update leaves no dead prompt behind.
      setConfirming((current) => (current === key ? undefined : current));
      setBusy(false);
    }
  }

  function requestUpdate(skill: SkillView): void {
    const key = `${skill.scope}|${skill.name}`;
    // Nothing fetched means nothing to confirm; the button only renders when a pin exists anyway.
    if ((updateHashes[key] ?? "") === "") return;
    setConfirming(key);
  }

  function cancelUpdate(): void {
    setConfirming(undefined);
  }

  async function install(): Promise<void> {
    const value = sourceInput.trim();
    if (value === "") return;
    // A drive path, a POSIX absolute path, or a UNC share is a local directory; anything else is a URL.
    const kind = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value) ? "local" : "git";
    const ticket = generation.current;
    const workspace = workspaceId;
    setBusy(true);
    try {
      await request<unknown>("skill.install", {
        workspaceId: workspace,
        scope: installScope,
        kind,
        source: value,
      });
      if (generation.current !== ticket) return;
      setSourceInput("");
      await load(ticket, workspace);
    } catch (installError) {
      if (generation.current !== ticket) return;
      setError(errorMessage(installError));
    } finally {
      setBusy(false);
    }
  }

  if (workspaceId === "") {
    return (
      <section className="skills" aria-label="Skills">
        <p className="hint">Select a workspace to browse its skills.</p>
      </section>
    );
  }

  const globalSkills = list === undefined ? [] : list.skills.filter((skill) => skill.scope === "global");
  const projectSkills = list === undefined ? [] : list.skills.filter((skill) => skill.scope === "project");
  const shadowed = list === undefined ? [] : list.shadowed;
  const warnings = list === undefined ? [] : list.warnings;

  return (
    <section className="skills" aria-label="Skills">
      {error === undefined ? null : (
        <p role="status" className="skills-error">
          {error}
        </p>
      )}
      {warnings.length === 0 ? null : (
        <p role="status" className="skills-warnings">
          {warnings.join(" · ")}
        </p>
      )}
      <section className="skills-install" aria-label="Install a skill">
        <label htmlFor="skill-source">Skill source</label>
        <input
          id="skill-source"
          value={sourceInput}
          onChange={(event) => setSourceInput(event.target.value)}
          placeholder="https://host/repo.git or an absolute path"
        />
        <label htmlFor="skill-scope">Scope</label>
        <select
          id="skill-scope"
          value={installScope}
          onChange={(event) => setInstallScope(event.target.value as "global" | "project")}
        >
          <option value="project">project</option>
          <option value="global">global</option>
        </select>
        <button type="button" disabled={busy || sourceInput.trim() === ""} onClick={() => void install()}>
          Install skill
        </button>
      </section>
      <div className="skills-sections">
        <section aria-label="Global skills">
          <h3>Global skills</h3>
          <ul className="skills-list">
            {shadowed.map((name) => (
              <li key={`shadowed-${name}`} className="skills-row skills-row-shadowed">
                {`${name} (shadowed by a project skill)`}
              </li>
            ))}
            {globalSkills.map((skill) => {
              const key = `${skill.scope}|${skill.name}`;
              return (
                <SkillRow
                  key={`global-${skill.name}`}
                  skill={skill}
                  busy={busy}
                  selected={sameSkill(selected, skill)}
                  pinned={updateHashes[key]}
                  confirming={confirming === key}
                  onView={view}
                  onToggle={(candidate) => void toggle(candidate)}
                  onCheckUpdate={(candidate) => void checkUpdate(candidate)}
                  onRequestUpdate={requestUpdate}
                  onConfirmUpdate={(candidate) => void update(candidate)}
                  onCancelUpdate={cancelUpdate}
                />
              );
            })}
            {list !== undefined && globalSkills.length === 0 && shadowed.length === 0 ? (
              <li className="skills-empty">No global skills</li>
            ) : null}
          </ul>
        </section>
        <section aria-label="Project skills">
          <h3>Project skills</h3>
          <ul className="skills-list">
            {projectSkills.map((skill) => {
              const key = `${skill.scope}|${skill.name}`;
              return (
                <SkillRow
                  key={`project-${skill.name}`}
                  skill={skill}
                  busy={busy}
                  selected={sameSkill(selected, skill)}
                  pinned={updateHashes[key]}
                  confirming={confirming === key}
                  onView={view}
                  onToggle={(candidate) => void toggle(candidate)}
                  onCheckUpdate={(candidate) => void checkUpdate(candidate)}
                  onRequestUpdate={requestUpdate}
                  onConfirmUpdate={(candidate) => void update(candidate)}
                  onCancelUpdate={cancelUpdate}
                />
              );
            })}
            {list !== undefined && projectSkills.length === 0 ? (
              <li className="skills-empty">No project skills</li>
            ) : null}
          </ul>
        </section>
      </div>
      <section aria-label="Skill body" className="skill-body">
        {selected === undefined ? (
          <p className="skills-empty">Select a skill</p>
        ) : body === undefined ? (
          <p className="skills-empty" role="status">{`Loading ${selected.name}…`}</p>
        ) : (
          <pre>{body}</pre>
        )}
      </section>
    </section>
  );
}
