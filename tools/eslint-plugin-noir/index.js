/**
 * Local ESLint rules for NoirHarness.
 *
 * Each one encodes a defect that already happened here, so the rule is the only remaining trace of
 * it: a correction that cannot become a check comes back.
 */

import { builtinModules } from "node:module";
import path from "node:path";

const BUILTINS = new Set(builtinModules);
const RAW_TIMERS = new Set([
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "requestIdleCallback",
  "clearTimeout",
  "clearInterval",
]);
const RENDERER_PACKAGES = new Set(["@noir/kernel", "@noir/engine-acp", "@noir/engine-core", "@noir/engine-native", "@noir/omp-profile"]);
/** Locators whose `name` is a substring match unless `exact: true` is passed. */
const NAME_LOCATORS = new Set(["getByRole", "getByLabel"]);

function normalize(file) {
  return file.split(path.sep).join("/");
}

function isUnder(file, root) {
  const normalizedFile = normalize(file);
  return normalizedFile === root || normalizedFile.startsWith(`${root}/`);
}

function callName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") return callee.property.name;
  return undefined;
}

/** Source of an `import`/`export … from`/`import()` node, or undefined. */
function sourceOf(node) {
  const source = node.source ?? (node.type === "ImportExpression" ? node.source : null);
  if (source === null || source === undefined) return undefined;
  return source.type === "Literal" && typeof source.value === "string" ? source.value : undefined;
}

export const noCrossProcessImport = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A renderer module may only import the renderer, @noir/protocol, and npm packages: the renderer runs in its own process.",
    },
    schema: [
      {
        type: "object",
        properties: { rendererRoot: { type: "string" } },
        additionalProperties: false,
      },
    ],
    messages: {
      process:
        "The renderer cannot reach `{{source}}`: it runs in another process. Put the value in @noir/protocol, or ask the preload bridge for it.",
      escape:
        "`{{source}}` leaves the renderer directory: main-process code and its node builtins cannot run in the renderer. Put the shared type in @noir/protocol.",
    },
  },
  create(context) {
    const configured = context.options[0]?.rendererRoot;
    if (configured === undefined) return {};
    // `context.filename` is absolute; the option names a workspace-relative directory.
    const rendererRoot = normalize(path.resolve(context.cwd ?? process.cwd(), configured));
    const file = normalize(context.filename);
    if (!isUnder(file, rendererRoot)) return {};

    function check(node) {
      const source = sourceOf(node);
      if (source === undefined) return;
      if (source.startsWith("node:") || BUILTINS.has(source) || source === "electron" || source.startsWith("electron/")) {
        context.report({ node, messageId: "process", data: { source } });
        return;
      }
      if (RENDERER_PACKAGES.has(source)) {
        context.report({ node, messageId: "process", data: { source } });
        return;
      }
      if (source.startsWith("./") || source.startsWith("../")) {
        const target = normalize(path.resolve(path.dirname(file), source));
        if (!isUnder(target, rendererRoot)) context.report({ node, messageId: "escape", data: { source } });
      }
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
};

export const noBareTimer = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Timers come from the renderer's defer module, which hands back a canceller instead of an id.",
    },
    schema: [
      {
        type: "object",
        properties: { allow: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: {
      bare: "`{{name}}` returns an id a call site has to remember to clear. Use `after`, `every`, `coalesce`, or `debounce` from the renderer's defer module.",
    },
  },
  create(context) {
    const file = normalize(context.filename);
    // `context.filename` is absolute; the allow list names workspace-relative files.
    if ((context.options[0]?.allow ?? []).some((allowed) => file.endsWith(`/${allowed}`))) return {};
    return {
      CallExpression(node) {
        const name = callName(node.callee);
        if (name === undefined || !RAW_TIMERS.has(name)) return;
        context.report({ node, messageId: "bare", data: { name } });
      },
    };
  },
};

function hasProperty(object, name) {
  return object.properties.some(
    (property) =>
      property.type === "Property" &&
      property.computed === false &&
      ((property.key.type === "Identifier" && property.key.name === name) ||
        (property.key.type === "Literal" && property.key.value === name)),
  );
}

export const strictLocatorName = {
  meta: {
    type: "problem",
    fixable: "code",
    docs: {
      description:
        "A locator name is matched as a substring by default, so a new control whose name extends an old one silently joins the match.",
    },
    schema: [],
    messages: {
      exact:
        "`{{locator}}` matches `{{name}}` as a substring: add `exact: true` so a longer accessible name cannot join the match.",
    },
  },
  create(context) {
    function report(node, locator, name, fix) {
      context.report({ node, messageId: "exact", data: { locator, name }, fix });
    }

    return {
      CallExpression(node) {
        const locator = callName(node.callee);
        if (locator === undefined || !NAME_LOCATORS.has(locator)) return;
        const [first, second] = node.arguments;
        if (first === undefined) return;

        if (locator === "getByRole") {
          if (second === undefined || second.type !== "ObjectExpression") return;
          if (!hasProperty(second, "name") || hasProperty(second, "exact")) return;
          const name = second.properties.find((property) => property.type === "Property" && property.key.type === "Identifier" && property.key.name === "name");
          // A regex is already as strict as its author wrote it; `exact` does not apply to one.
          if (name !== undefined && name.type === "Property" && name.value.type === "Literal" && "regex" in name.value) return;
          const text = name === undefined ? locator : context.sourceCode.getText(name);
          report(node, locator, text, (fixer) => fixer.insertTextAfterRange([second.range[0], second.range[0] + 1], " exact: true,"));
          return;
        }

        if (first.type !== "Literal" || typeof first.value !== "string") return;
        if (second !== undefined) {
          if (second.type !== "ObjectExpression" || hasProperty(second, "exact")) return;
          report(node, locator, first.value, (fixer) =>
            fixer.insertTextAfterRange([second.range[0], second.range[0] + 1], " exact: true,"),
          );
          return;
        }
        // Inside the call, before its `)`: inserting after the node lands outside the argument list.
        report(node, locator, first.value, (fixer) => fixer.insertTextBeforeRange([node.range[1] - 1, node.range[1]], ", { exact: true }"));
      },
    };
  },
};

export default {
  meta: { name: "eslint-plugin-noir", version: "0.0.0" },
  rules: {
    "no-cross-process-import": noCrossProcessImport,
    "no-bare-timer": noBareTimer,
    "strict-locator-name": strictLocatorName,
  },
};
