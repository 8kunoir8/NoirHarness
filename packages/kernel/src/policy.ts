import { PermissionPolicySchema, type PermissionPolicy } from "@noir/protocol";

/**
 * Reads a stored permission policy. Missing keys mean `ask`; a hand-edited or older row is read as
 * the defaults rather than breaking callers, and unknown keys fail closed like the RPC schema.
 */
export function parsePermissionPolicy(text: string): PermissionPolicy {
  try {
    const parsed = PermissionPolicySchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
