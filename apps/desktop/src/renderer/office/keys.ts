/**
 * The contract between the React host and the lazily loaded Phaser scene. It lives in its own module
 * so `AgentOffice` can reference the keys without pulling Phaser or the scene into the startup
 * bundle, and so the scene can be replaced by a double in tests.
 */
export const OFFICE_WIDTH = 768;
export const OFFICE_HEIGHT = 512;

/** Registry keys: the scene reads the latest push on create and after every `OFFICE_STATES_EVENT`. */
export const OFFICE_STATES_KEY = "office:states";
export const OFFICE_SELECTED_KEY = "office:selected";
export const OFFICE_REDUCED_KEY = "office:reducedMotion";

/** Scene → React: the user clicked a character. */
export const OFFICE_SELECT_EVENT = "office:select";
/** Scene → React: the awaited load failed, so the canvas can never show an office. */
export const OFFICE_UNAVAILABLE_EVENT = "office:unavailable";
/** React → scene: a new roster snapshot is in the registry. */
export const OFFICE_STATES_EVENT = "office:states";
