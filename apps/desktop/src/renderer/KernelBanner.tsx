/**
 * Two states the user has to know about, both invisible from the app otherwise: the daemon is an
 * older build than the one installed, and the kernel is not a daemon at all.
 */
export function KernelBanner({ daemon, buildMatches }: { daemon: boolean; buildMatches: boolean }) {
  if (daemon && buildMatches) return null;
  const text = buildMatches
    ? "The kernel runs as a child of this window: closing it stops automations. Restart the app to detach it."
    : "This window runs an older build of the kernel than the one installed. Restart NoirHarness to switch.";
  return <p role="status" className="kernel-banner">{text}</p>;
}
