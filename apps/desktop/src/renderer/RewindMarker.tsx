import type { ChatRewind } from "./events.js";

export function RewindMarker({
  rewind,
  onLoadPrompt,
  onUndo,
}: {
  rewind: ChatRewind;
  onLoadPrompt?: ((seq: number) => void) | undefined;
  /** Restores the safety checkpoint this rewind took, putting back what it removed. */
  onUndo?: (() => void) | undefined;
}) {
  const promptSeq = rewind.promptSeq;
  return (
    <li className="rewind-marker" data-testid="rewind-marker">
      <div>
        <strong>Rewound to before this prompt</strong>
        <p className="rewind-counts">
          {String(rewind.restored)} restored · {String(rewind.deleted)} deleted · {String(rewind.removed)} removed
        </p>
        {rewind.failed === 0 ? null : <p role="alert">{String(rewind.failed)} could not be applied.</p>}
        {rewind.notCaptured === 0 ? null : (
          <p>
            {String(rewind.notCaptured)} {rewind.notCaptured === 1 ? "item was" : "items were"} not captured, left as{" "}
            {rewind.notCaptured === 1 ? "it was" : "they were"}.
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
      {onUndo === undefined ? null : (
        <button type="button" className="link" onClick={onUndo}>
          Undo this rewind
        </button>
      )}
    </li>
  );
}
