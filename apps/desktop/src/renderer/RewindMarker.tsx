import type { ChatRewind } from "./events.js";

export function RewindMarker({
  rewind,
  onLoadPrompt,
}: {
  rewind: ChatRewind;
  onLoadPrompt?: ((seq: number) => void) | undefined;
}) {
  const promptSeq = rewind.promptSeq;
  return (
    <li className="rewind-marker" data-testid="rewind-marker">
      <div>
        <strong>Rewound to before this prompt</strong>
        <p className="rewind-counts">
          {String(rewind.restored)} restored · {String(rewind.deleted)} deleted · {String(rewind.removed)} removed
        </p>
        {rewind.failed === 0 ? null : <p role="alert">{String(rewind.failed)} could not be restored.</p>}
        {rewind.notCaptured === 0 ? null : (
          <p>
            {String(rewind.notCaptured)} not captured, left as they were.
          </p>
        )}
        {rewind.engineNotRewound ? (
          <p className="rewind-note">This engine keeps its own memory, so it was not rewound.</p>
        ) : null}
      </div>
      {promptSeq === null || onLoadPrompt === undefined ? null : (
        <button type="button" className="link" onClick={() => onLoadPrompt(promptSeq)}>
          Load the prompt again
        </button>
      )}
    </li>
  );
}
