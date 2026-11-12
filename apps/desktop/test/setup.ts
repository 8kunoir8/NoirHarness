/**
 * The suite runs in parallel with six other packages. A jsdom render that takes 200 ms idle has
 * been measured past Testing Library's one-second default under load, which fails `findBy*` on a
 * component that renders fine. Three seconds is still short enough to fail fast on a real hang.
 */
import { configure } from "@testing-library/react";

configure({ asyncUtilTimeout: 3_000 });
