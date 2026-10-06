export {
  type IdentityGroup,
  type IdentityInput,
  type JoinReason,
  KNOWN_BOTS,
  noreplyLogin,
  type RawIdentity,
  type ResolvedIdentities,
  resolveIdentities,
  saltedKey,
} from "./identities.ts";
export {
  applyMailmap,
  type Identity,
  type Mailmap,
  type MailmapRule,
  parseMailmap,
} from "./mailmap.ts";
export { type Assigned, assignIds } from "./registry.ts";
