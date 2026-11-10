import { useCallback, useEffect, useRef, useState } from "react";
import {
  SkillListResult,
  SkillReadResult,
  type SkillScopeSchema,
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

function SkillRow({
  skill,
  busy,
  selected,
  onView,
  onToggle,
}: {
  skill: SkillView;
  busy: boolean;
  selected: boolean;
  onView: (skill: SkillRef) => void;
  onToggle: (skill: SkillView) => void;
}) {
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
        <button type="button" disabled={busy} onClick={() => onToggle(skill)}>
          {`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
        </button>
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

  // Any workspace switch bumps this, so a list or body that resolves late is dropped instead of
  // being shown for the wrong workspace.
  const generation = useRef(0);
  const selectionTicket = useRef(0);
  const selection = useRef<SkillRef | undefined>(undefined);

  const load = useCallback(
    async (ticket: number, workspace: string): Promise<SkillListResult | undefined> => {
      try {
        const result = SkillListResult.parse(await request<unknown>("skill.list", { workspaceId: workspace }));
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
      <div className="skills-sections">
        <section aria-label="Global skills">
          <h3>Global skills</h3>
          <ul className="skills-list">
            {shadowed.map((name) => (
              <li key={`shadowed-${name}`} className="skills-row skills-row-shadowed">
                {`${name} (shadowed by a project skill)`}
              </li>
            ))}
            {globalSkills.map((skill) => (
              <SkillRow
                key={`global-${skill.name}`}
                skill={skill}
                busy={busy}
                selected={sameSkill(selected, skill)}
                onView={view}
                onToggle={(candidate) => void toggle(candidate)}
              />
            ))}
            {list !== undefined && globalSkills.length === 0 && shadowed.length === 0 ? (
              <li className="skills-empty">No global skills</li>
            ) : null}
          </ul>
        </section>
        <section aria-label="Project skills">
          <h3>Project skills</h3>
          <ul className="skills-list">
            {projectSkills.map((skill) => (
              <SkillRow
                key={`project-${skill.name}`}
                skill={skill}
                busy={busy}
                selected={sameSkill(selected, skill)}
                onView={view}
                onToggle={(candidate) => void toggle(candidate)}
              />
            ))}
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
