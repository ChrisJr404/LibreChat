# Shared Links ACL — Design Spec

## Overview

Add granular access control to shared links by integrating them into the existing ACL system. Currently shared links are globally visible with no per-link access control. This feature lets users share conversation links with specific users, groups, roles, or everyone — using the same principal system as agents, prompts, and skills.

## Key UX Note

By default, regular users (USER role) have `SHARE: false` for shared links. This means the "Manage Access" button is **hidden in the UI for regular users out of the box**. Users can still create shared links (shared to everyone, as today), but the granular ACL sharing UI requires an admin to enable `SHARE` permission via `librechat.yaml` or the admin panel. Users with `SHARE: true` can freely toggle the "shared with everyone" switch and add/remove specific principals.

Note: the role-level `SHARE` permission is a UI gate, not an API gate. A creator with OWNER AclEntry (which includes `PermissionBits.SHARE`) can call the permission API directly regardless of their role's SHARE setting. This is a **known limitation across all resource types** — agents, prompts, MCP servers, and skills all have the same gap. The admin's `SHARE: false` intent is unenforceable for resource owners at the API level. See separate issue: "Enforce role-level SHARE permission at API layer for all resource types."

## Naming Note: "Public" vs "No Auth"

In the context of shared links, "public" (`SHARE_PUBLIC`, PUBLIC principal) means **"shared with everyone"** — not "accessible without authentication." Whether "everyone" includes unauthenticated users is controlled by the `ALLOW_SHARED_LINKS_PUBLIC` env var (admin-level, global). Phase 2 may add a per-link auth flag (e.g., `require_auth`) as a separate concept. Do not conflate "shared with everyone" with "no auth required" during implementation.

## `SHARE_PUBLIC` Not Used for Shared Links

Unlike agents/prompts where resources start private and `SHARE_PUBLIC` gates making them public, shared links start public by default — creating a link IS sharing with everyone. `SHARE_PUBLIC` doesn't map naturally to this model. Therefore:

- **`SHARE_PUBLIC` is not used for shared links in phase 1.** The "shared with everyone" toggle is gated by `SHARE` alone.
- The `checkSharePublicAccess` middleware skips the `SHARE_PUBLIC` check for `resourceType === 'sharedLink'`.
- `SHARE_PUBLIC` can be repurposed in phase 2 for the per-link no-auth toggle.

This means users with `SHARE: true` can freely toggle "shared with everyone" on/off — no design tension between default-public links and permission restrictions.

## Auto-Migration

By default, when a shared link with zero ACL entries is visited, the system auto-creates ACL entries on the spot (PUBLIC VIEWER + OWNER to the `user` field author, if present). This eliminates any deployment inaccessibility window — legacy links work immediately after deploying new code without running the migration script.

An env var `SHARED_LINKS_AUTO_MIGRATE` (default: `true`) controls this. Setting it to `false` disables auto-migration — links with no ACL entries become inaccessible until the bulk migration script is run manually. All auto-migration events are logged.

The bulk migration script (`config/migrate-shared-link-permissions.js`) is still available for pre-migrating all links in one pass, avoiding the per-visit overhead of auto-migration. It is recommended but not required.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Protected resource | SharedLink (not conversation) | A conversation can have multiple shared links with different ACLs and target messages. SharedLink is its own entity with anonymized data. |
| ACL integration | Extend existing ACL system | Add `SHARED_LINK` to `ResourceType`. Reuses `AclEntry`, `AccessControlService`, permission routes, principal search. Consistent with agents/prompts. |
| Permission levels | OWNER (auto) + VIEWER (assignable only) | Creator gets OWNER on creation. All other principals are VIEWER. OWNER assignment blocked by server-side validation in `bulkUpdateResourcePermissions`. OWNER stays in roles response for correct UI rendering of the creator principal. |
| Auth model | Global env var only | `ALLOW_SHARED_LINKS_PUBLIC` controls whether "everyone" links require auth. Per-link auth toggle deferred to phase 2. |
| SHARE_PUBLIC | Not used for shared links | Shared links start public by default — `SHARE_PUBLIC` doesn't map naturally. The "everyone" toggle is gated by `SHARE` alone. `SHARE_PUBLIC` can be repurposed in phase 2 for per-link no-auth control. |
| `isPublic` field | Remove from SharedLink | "Public" state is derived from the presence of a PUBLIC AclEntry. Migration `$unset`s the field. |
| Legacy migration | Auto-migration + optional bulk script | By default, legacy links auto-migrate on first visit (create PUBLIC VIEWER + OWNER AclEntries). `SHARED_LINKS_AUTO_MIGRATE=false` disables this. Bulk migration script available for pre-migration. |
| Routing | Same `/api/share` path | New TS implementation in `packages/api/src/share/`, thin JS wrapper delegates. No versioning. |
| Frontend UI | SharedLinkButton dialog only | "Manage Access" button opens `GenericGrantAccessDialog`. Management page deferred to phase 2. |
| Dual ownership | `SharedLink.user` is authoritative for CRUD, AclEntry for access checks | Same pattern as agents (`author` + OWNER AclEntry). CRUD operations (delete, update) check `SharedLink.user`. Permission checks (view, manage access) use AclEntry. Migration ensures consistency. |
| Admin capability | `MANAGE_SHARED_LINKS` | New dedicated capability following the per-resource pattern (MANAGE_AGENTS, MANAGE_PROMPTS, etc.). |

## Section 1: Enum & Type Extensions

### `ResourceType` (packages/data-provider/src/accessPermissions.ts)

Add:

```ts
SHARED_LINK = 'sharedLink'
```

### `AccessRoleIds` (packages/data-provider/src/accessPermissions.ts)

Add:

```ts
SHARED_LINK_VIEWER = 'sharedLink_viewer'
SHARED_LINK_OWNER = 'sharedLink_owner'
```

No `SHARED_LINK_EDITOR` — VIEWER is the only assignable role.

### `PermissionTypes` (packages/data-provider/src/permissions.ts)

Add:

```ts
SHARED_LINKS = 'SHARED_LINKS'
```

Note: enum values are uppercase. The camelCase mapping goes in `PERMISSION_TYPE_INTERFACE_FIELDS` (same file, line 74):

```ts
[PermissionTypes.SHARED_LINKS]: 'sharedLinks'
```

Also add:
- A `sharedLinksPermissionsSchema` zod schema with `USE` and `SHARE` fields only (no `SHARE_PUBLIC` — not used for shared links in phase 1; see "SHARE_PUBLIC Not Used" section)
- Add to the `permissionsSchema` composite

### `accessRoleToPermBits` (packages/data-provider/src/accessPermissions.ts)

Add cases for `SHARED_LINK_VIEWER` (returns `VIEW`) and `SHARED_LINK_OWNER` (returns `VIEW | EDIT | DELETE | SHARE`). EDIT has no concrete consumer for shared links but is included for parity with `RoleBits.OWNER` — all resource types use the same OWNER bits.

### Role defaults (packages/data-provider/src/roles.ts)

- ADMIN: `{ USE: true, SHARE: true }`
- USER: `{ USE: true, SHARE: false }`

No `SHARE_PUBLIC` for shared links — the "everyone" toggle is gated by `SHARE` alone. See "SHARE_PUBLIC Not Used for Shared Links" section above.

`USE` gates whether the user can create and list shared links (same as `AGENTS.USE` gates agent usage). `SHARE` gates the "Manage Access" UI.

### Seed roles (packages/data-schemas/src/methods/accessRole.ts — `seedDefaultRoles`)

Add:

```ts
{ accessRoleId: 'sharedLink_viewer', resourceType: 'sharedLink', permBits: RoleBits.VIEWER }
{ accessRoleId: 'sharedLink_owner',  resourceType: 'sharedLink', permBits: RoleBits.OWNER }
```

### `SystemCapabilities` (packages/data-schemas/src/admin/capabilities.ts)

Add:

```ts
MANAGE_SHARED_LINKS: 'manage:sharedlinks'
```

Also add `READ_SHARED_LINKS: 'read:sharedlinks'` and add the implication `MANAGE_SHARED_LINKS → READ_SHARED_LINKS` to `CapabilityImplications`, matching the MANAGE_AGENTS → READ_AGENTS pattern.

### `ResourceCapabilityMap` (packages/data-schemas/src/admin/capabilities.ts)

Add:

```ts
[ResourceType.SHARED_LINK]: SystemCapabilities.MANAGE_SHARED_LINKS
```

### `RESOURCE_CONFIGS` (client/src/utils/resources.ts)

This is typed as `Record<ResourceType, ResourceConfig>` and must be exhaustive. Add a `SHARED_LINK` entry:

```ts
[ResourceType.SHARED_LINK]: {
  resourceType: ResourceType.SHARED_LINK,
  defaultViewerRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
  defaultEditorRoleId: AccessRoleIds.SHARED_LINK_VIEWER, // no editor role — map to viewer
  defaultOwnerRoleId: AccessRoleIds.SHARED_LINK_OWNER,
  getResourceName: (name?) => name || 'shared link',
  getShareMessage: (name?) => name || 'shared link',
  getManageMessage: (name?) => `Manage access for ${name || 'shared link'}`,
  getCopyUrlMessage: () => 'Share link copied',
}
```

### Resource-to-permission maps

- `api/server/middleware/checkSharePublicAccess.js` — skip `SHARE_PUBLIC` check for shared links (early return, not a mapping addition)
- `client/src/hooks/Sharing/useCanSharePublic.ts` — special-case `SHARED_LINK`: instead of looking up `SHARE_PUBLIC` via `resourceToPermissionMap` (which has no entry for shared links), return `useHasAccess({ permissionType: PermissionTypes.SHARED_LINKS, permission: Permissions.SHARE })`. This makes the hook return "can show public toggle" based on `SHARE`, not `SHARE_PUBLIC`. Semantic name preserved, one file changes, no divergent logic needed in `GenericGrantAccessDialog` or `SharedLinkButton`.

### Config system (packages/data-provider/src/config.ts)

Add `sharedLinks` to `interfaceSchema` defaults so the permission can be configured via `librechat.yaml`.

### Interface permission propagation (packages/api/src/app/permissions.ts)

Add `SHARED_LINKS` case to:
- `hasExplicitConfig` switch (line 15)
- Permission assembly in `allPermissions` object
- Share backfill array

## Section 2: Remove `isPublic`, ACL-based Access

### Remove `isPublic` from SharedLink

Remove the field from:
- Schema: `packages/data-schemas/src/schema/share.ts`
- Types: `packages/data-schemas/src/types/share.ts` (ISharedLink, SharedLinksResult, SharedMessagesResult)
- Backend methods: `packages/data-schemas/src/methods/share.ts` (all queries/filters/responses)
- Route: `api/server/routes/share.js` (query parameter)
- Frontend: endpoint URL, data-service, query params, types, zod schemas, SharedLinks component
- Tests: `packages/data-schemas/src/methods/share.test.ts`

Note: `isPublic` is redundantly always `true` in all existing documents — no code path sets it to `false`. However, it's actively used as a query filter, so removing the filter is a deliberate change. ACL replaces the access control it was guarding. The migration aborts if any `isPublic: false` documents are found (see Section 5).

### Route middleware change for `GET /api/share/:shareId`

The current route uses `requireJwtAuth` or a passthrough based on `ALLOW_SHARED_LINKS_PUBLIC`. With ACL, the auth decision depends on per-link state, not just the env var. Change to:

**Always use `optionalJwtAuth`** (`api/server/middleware/optionalJwtAuth.js`) for `GET /api/share/:shareId`. This populates `req.user` if a token is present but doesn't reject unauthenticated requests. The access resolver then decides:
- PUBLIC AclEntry + `ALLOW_SHARED_LINKS_PUBLIC` enabled → allow without auth
- PUBLIC AclEntry + `ALLOW_SHARED_LINKS_PUBLIC` disabled → require auth (reject if no `req.user`)
- No PUBLIC AclEntry → require auth + check specific principal permission (reject if no `req.user`)

This is necessary because with `ALLOW_SHARED_LINKS_PUBLIC=true`, both public and private ACL links share the same route. Public links allow anonymous access while private links need `req.user` for permission checks.

**Tenant context for anonymous access:** `optionalJwtAuth` only establishes tenant context when a user is authenticated (`optionalJwtAuth.js:25`). Anonymous requests have no tenant context. The access resolver handles this as follows: step 1 fetches SharedLink by `shareId` (globally unique, no tenant scoping needed). For the subsequent AclEntry lookup, queries are keyed on `resourceId` (ObjectId) which is already unique. If AclEntry rows have a `tenantId` field, the resolver uses the SharedLink's `tenantId` to scope: `tenantStorage.run({ tenantId: share.tenantId }, () => ...)`. The migration script has the same requirement — ACL upserts must run inside `tenantStorage.run({ tenantId: share.tenantId })` to ensure correct tenant scoping.

### Access resolution (new: packages/api/src/share/access.ts)

```
resolveShareAccess(shareId, req.user?)
  1. Fetch SharedLink by shareId → 404 if not found
  2. Count AclEntries for (resourceType: 'sharedLink', resourceId: share._id)
  3. Check if this is a legacy link. The initial SharedLink fetch (step 1) should NOT exclude `isPublic` via `.select()` — instead, read it from the raw document. Mongoose strict mode may strip unknown fields, so use a lean query or raw projection that includes `isPublic`. If `isPublic` exists on the fetched document, it's a legacy link that needs auto-migration. If `isPublic` doesn't exist, it's a new link or already bulk-migrated — skip to step 4. This avoids a separate raw collection query on every request.
  3a. If legacy link and SHARED_LINKS_AUTO_MIGRATE is disabled:
        - Log warning (legacy link with no ACL)
        - Return 403
  3b. If legacy link and SHARED_LINKS_AUTO_MIGRATE is enabled (default):
        - If no OWNER AclEntry exists and share.user is present: auto-create OWNER. If OWNER grant fails, log error and continue (link remains publicly accessible but unmanageable via permissions dialog).
        - If no PUBLIC VIEWER AclEntry exists: check if `isPublic` is `false` — if so, skip PUBLIC grant and log warning (security: don't escalate private to public). Otherwise, auto-create PUBLIC VIEWER.
        - Log the auto-migration event
        - Concurrent requests: `grantPermission` uses `findOneAndUpdate` with `upsert: true`. The AclEntry compound indexes are not unique, so concurrent upserts could theoretically create duplicate rows — this is harmless because all delete paths (`removeAllPermissions`, `bulkUpdateResourcePermissions` revoke) use broad filters that co-delete duplicates. This is an existing codebase characteristic, not shared-link-specific.
        - Proceed to step 4
  4. Query AclEntry for (resourceType: 'sharedLink', resourceId: share._id)
     where principalType = 'public'
  5. If PUBLIC AclEntry exists (shared to everyone):
     - ALLOW_SHARED_LINKS_PUBLIC enabled → allow without auth
     - ALLOW_SHARED_LINKS_PUBLIC disabled → require auth (reject if no req.user), any authenticated user passes
  6. If no PUBLIC AclEntry (shared to specific principals):
     - Require auth (reject if no req.user)
     - AccessControlService.checkPermission(userId, 'sharedLink', share._id, VIEW) → 403 if denied
  7. Return anonymized shared messages
```

Performance note: first visit to a legacy link (auto-migration) costs ~4-5 DB operations (count, OWNER upsert, PUBLIC upsert, public lookup, message fetch). Steady-state for migrated links is 2-3 queries (fetch link, public AclEntry check, optional principal check). This matches the cost agents pay for ACL checks. Can be optimized later with compound queries or caching if needed.

### Refactored share methods

- `getSharedMessages` — fetch by `shareId` without `isPublic` filter (access control at route handler layer)
- `getSharedLinks` — remove `isPublic` parameter, list all links the user *created* (filtered by `user` field, same as today; listing links shared *with* you by others is out of scope)
- `createSharedLink` — remove `isPublic` from duplicate-check logic
- `getSharedLink` — remove `isPublic: true` filter. Also trigger auto-migration here (same logic as the access resolver) — this is the creator's natural path before seeing the "Manage Access" button. Without this, legacy links have no AclEntries and `useResourcePermissions` returns zero permissions, hiding the button.

## Section 3: Link Creation + OWNER Grant

### On creation (packages/api/src/share/service.ts)

1. Create SharedLink document (same as today, minus `isPublic`)
2. Grant OWNER to creator:
   ```
   grantPermission({
     principalType: PrincipalType.USER,
     principalId: userId,
     resourceType: ResourceType.SHARED_LINK,
     resourceId: sharedLink._id,
     accessRoleId: AccessRoleIds.SHARED_LINK_OWNER,
     grantedBy: userId
   })
   ```
   **If OWNER grant fails:** delete the SharedLink and throw. Without the OWNER AclEntry, the permission management routes (`accessPermissions.js:98` checks ACL SHARE) would be inaccessible, making the link unmanageable.
3. Grant PUBLIC VIEWER by default (preserves current behavior):
   ```
   grantPermission({
     principalType: PrincipalType.PUBLIC,
     principalId: null,
     resourceType: ResourceType.SHARED_LINK,
     resourceId: sharedLink._id,
     accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
     grantedBy: userId
   })
   ```
   **If PUBLIC VIEWER grant fails:** delete the SharedLink, clean up the OWNER AclEntry, and throw. Creating a shared link means sharing with everyone — returning success without PUBLIC access violates that contract and gives the user a broken link they may immediately copy and share.

### On deletion (single link)

Call `AccessControlService.removeAllPermissions({ resourceType: 'sharedLink', resourceId })` to clean up AclEntry rows.

### On bulk deletion

`deleteAllSharedLinks` and `deleteConvoSharedLink` currently do `SharedLink.deleteMany(...)` with no ACL cleanup. These must be updated to:
1. Query the SharedLink `_id`s being deleted
2. Delete the SharedLink documents first
3. Then call `AclEntry.deleteMany({ resourceType: 'sharedLink', resourceId: { $in: ids } })` to clean up

Order matters: delete SharedLinks first, then AclEntries. Orphan AclEntries are harmless (no resource to access). Orphan SharedLinks without ACL could trigger auto-migration and re-create entries.

### On user deletion

`UserController.js` calls `deleteAllSharedLinks(user.id)` then later `deleteAclEntries({ principalId: user._id })`. The second call only removes entries where the user is the *principal* — it doesn't remove PUBLIC, GROUP, or ROLE AclEntries for the user's shared links. Fix:
1. Query all SharedLink `_id`s for the user
2. Delete the SharedLink documents first (`deleteAllSharedLinks(user.id)`)
3. Then call `AclEntry.deleteMany({ resourceType: 'sharedLink', resourceId: { $in: userSharedLinkIds } })` to clean up all ACL entries (PUBLIC, GROUP, ROLE)

Same ordering as bulk deletion: SharedLinks first, then AclEntries. Orphan AclEntries are harmless; orphan SharedLinks without ACL could trigger auto-migration.

### On update (refresh link)

AclEntry rows reference `resourceId` (`_id`), not `shareId`. Permissions survive a link refresh. Adding `_id` to `UpdateShareResult` is the only change needed — the existing update mutation already stores the full response object in the cache.

### Response changes

Return `_id` alongside `shareId` from **creator-facing** endpoints only. The consumer-facing endpoint (`GET /api/share/:shareId` returning shared messages to anonymous viewers) should NOT expose `_id` — anonymous viewers don't need the database key. Update types:
- `CreateShareResult` — add `_id`
- `UpdateShareResult` — add `_id`
- `GetShareLinkResult` — add `_id`
- `GET /share/link/:conversationId` response — add `_id` (this is the primary endpoint the frontend uses to discover an existing link's identity before opening the ACL dialog)

**Cache preservation:** The React Query `onSuccess` handler at `packages/data-provider/src/react-query/react-query-service.ts:53` rewrites the shared link cache to only `{ conversationId, shareId }`, stripping any additional fields. Must preserve `_id` in the cache rewrite, otherwise the dialog receives no ACL resource ID despite the API returning one.

### Type mismatch note

`SharedLink.user` is stored as `String`, while `AclEntry.principalId` is `Types.ObjectId`. The creation code and migration must convert `user` string to ObjectId when calling `grantPermission`. The `grantPermission` method already validates ObjectId format, so string user IDs that are valid ObjectId strings will work. Any invalid ones will be caught and logged.

## Section 4: Permission Management Endpoints

### Route middleware additions

The existing `/api/permissions/:resourceType/:resourceId` routes use `checkResourcePermissionAccess` middleware (`api/server/routes/accessPermissions.js:46`) which has an explicit if/else chain per resource type. Add a `SHARED_LINK` case:

```js
} else if (resourceType === ResourceType.SHARED_LINK) {
  middleware = canAccessResource({
    resourceType: ResourceType.SHARED_LINK,
    requiredPermission,
    resourceIdParam: 'resourceId',
  });
}
```

No `idResolver` is needed because the permission routes receive `resourceId` (the MongoDB `_id`), not the `shareId` nanoid. The frontend passes `_id` directly.

### `checkSharePublicAccess` middleware

Skip the `SHARE_PUBLIC` check for shared links. Add an early return in `checkSharePublicAccess.js` when `resourceType === ResourceType.SHARED_LINK` — the "everyone" toggle is gated by `SHARE` (via `canAccessResource`), not `SHARE_PUBLIC`. Do NOT add `SHARED_LINK` to the `resourceToPermissionType` map.

### Block OWNER assignment — server-side validation

**API (server-side):** Add validation in `bulkUpdateResourcePermissions` (`api/server/services/PermissionService.js`) to protect the OWNER entry for shared links. Three rules:

- **Existing OWNER principal:** only allow `updated` entries where `accessRoleId === SHARED_LINK_OWNER` (no-op). Reject any other role (prevents demotion).
- **All other principals:** reject `accessRoleId === SHARED_LINK_OWNER` in the `updated` array (prevents granting OWNER to non-owners).
- **Removed array:** reject any `removed` entry whose current AclEntry role is `SHARED_LINK_OWNER` (prevents removing the owner).

The validation must fetch each principal's current AclEntry for the resource before applying the rules — it cannot rely solely on the request body.

**Do NOT filter OWNER from `GET /roles` response.** The creator's existing OWNER AclEntry is returned by `GET /permissions`, and the dialog renders it as a principal with a role. If OWNER is absent from the available roles list, `AccessRolesPicker` shows an unknown/blank state for the creator. Instead, keep OWNER in the roles response. The creator is rendered as a non-removable principal with "Owner" role (matching the agent pattern). New principals default to VIEWER via `RESOURCE_CONFIGS.defaultViewerRoleId`.

**Frontend role picker filtering:** `AccessRolesPicker` renders every role from the response. For shared links, the role picker for non-owner principals (and the `PublicSharingToggle` public role picker) must filter out OWNER and only show VIEWER. This is a UI-side filter based on `defaultOwnerRoleId` from `RESOURCE_CONFIGS` — exclude it from the assignable options while keeping it for display on the creator principal.

## Section 5: Migration Script

### File: `config/migrate-shared-link-permissions.js`

### When to use

The bulk migration script is **optional** — auto-migration handles legacy links on first visit by default. Use the script when:
- You want to pre-migrate all links in one pass (avoids per-visit overhead on first access)
- You have `SHARED_LINKS_AUTO_MIGRATE=false` and need to manually migrate
- You want to verify migration results with `--dry-run` before enabling auto-migration

### Prerequisites

**Deploy new code first.** The migration depends on seeded roles (`SHARED_LINK_OWNER`, `SHARED_LINK_VIEWER`) which are created by `seedDefaultRoles` on server startup. Running the migration before deploying new code will fail because the roles don't exist.

### Steps

Following the pattern from `config/migrate-prompt-permissions.js`:

1. Connect to MongoDB, ensure required collections exist
2. Look up `SHARED_LINK_OWNER` and `SHARED_LINK_VIEWER` roles (fail if not seeded)
3. **Abort if any SharedLink documents have `isPublic: false`** — these are anomalous (no code path creates them) and granting PUBLIC VIEWER would be a security escalation. Log the count and document IDs. Operator can re-run with `--force` after manual review. When `--force` is used, `isPublic: false` documents get OWNER grant (if `user` exists) but **skip PUBLIC VIEWER** — they remain private.
4. Find all SharedLink documents, check OWNER and PUBLIC grants independently per link (not a coarse "skip if any AclEntry exists" — this handles partial migrations where OWNER was created but PUBLIC failed)
5. For each SharedLink, in batches:
   - If `user` field exists and no OWNER AclEntry: grant `SHARED_LINK_OWNER` to `SharedLink.user` (convert string to ObjectId)
   - If `user` field is missing: log warning, skip OWNER grant
   - If no PUBLIC VIEWER AclEntry AND the raw document has an `isPublic` field: grant `SHARED_LINK_VIEWER` to `PUBLIC` principal (for links with `isPublic: true`, including userless ones — preserves their current public accessibility). Skip if `isPublic: false` (unless `--force`). Skip entirely if `isPublic` field is absent — missing `isPublic` means the link is already migrated or new; ACL is the source of truth.
6. After all links migrated, `$unset: { isPublic: 1 }` on all SharedLink documents uniformly. Userless `isPublic: false` documents (from `--force`) end up with zero AclEntries and no `isPublic` field — they return 403 on visit. This is correct: they were already inaccessible before migration (no code path serves `isPublic: false` links), and no user exists to manage them. The dry-run output reports these for operator awareness.

### Flags

- `--dry-run` — report without writing
- `--batch-size=N` — default 100
- `--force` — proceed even if `isPublic: false` documents exist
- 100ms pause between batches

### Userless links

SharedLinks with no `user` field get PUBLIC VIEWER but no OWNER. They remain publicly accessible (matching current behavior) but have no owner who can manage them. The dry-run output should report these for manual review.

## Section 6: Frontend — ACL UI in SharedLinkButton

### SharedLinkButton changes

File: `client/src/components/Conversations/ConvoOptions/SharedLinkButton.tsx`

When a shared link exists, add a "Manage Access" button. Gate it the same way agents do (`AgentFooter.tsx:44`):

1. **Role-level check:** `useHasAccess({ permissionType: PermissionTypes.SHARED_LINKS, permission: Permissions.SHARE })` — hides the button if the user's system role doesn't have SHARE enabled
2. **Resource-level check:** `useResourcePermissions(ResourceType.SHARED_LINK, sharedLink._id)` then `hasPermission(PermissionBits.SHARE)` — hides the button if the user doesn't have SHARE on this specific link's AclEntry

Both must pass for the button to show. On click, open `GenericGrantAccessDialog` with:
- `resourceType: ResourceType.SHARED_LINK`
- `resourceDbId: sharedLink._id` (the MongoDB ObjectId from the updated response — this is the prop `GenericGrantAccessDialog` uses for ACL operations, distinct from `resourceId` which is a display/custom ID)

The dialog handles principal search, public toggle, and role management via the existing `useResourcePermissionState` hook.

### `GenericGrantAccessDialog` integration

The dialog returns `null` without a resource config (`client/src/components/Sharing/GenericGrantAccessDialog.tsx:102`). The `RESOURCE_CONFIGS` entry added in Section 1 satisfies this requirement.

### Role dropdown behavior

OWNER stays in the roles response for correct rendering of the creator principal. For non-owner principals, the role picker defaults to VIEWER (`RESOURCE_CONFIGS.defaultViewerRoleId`). Since VIEWER is the only practical choice for non-owner principals, hide the role dropdown for them and display a static "Viewer" label. The creator is rendered as a non-removable "Owner" entry (matching the agent dialog pattern). This requires a small change to `AccessRolesPicker` or `SelectedPrincipalsList` (`client/src/components/Sharing/PeoplePicker/SelectedPrincipalsList.tsx:75`).

### Localization

New keys in `client/src/locales/en/translation.json`:
- `com_ui_shared_link_manage_access` — "Manage Access"
- `com_ui_shared_link_shared_with_everyone` — "Shared with everyone"
- `com_ui_shared_link_shared_with_count` — "Shared with {{count}} users"

Reuse existing keys: `com_ui_role_viewer`, `com_ui_role_owner`.

## Scope Boundaries

### Phase 1 (this spec)

- Enum/type extensions for SHARED_LINK
- `MANAGE_SHARED_LINKS` system capability
- ACL-aware access check on `GET /api/share/:shareId` using `optionalJwtAuth`
- OWNER + PUBLIC VIEWER auto-granted on link creation (with rollback on OWNER failure)
- Remove `isPublic` from SharedLink
- Auto-migration for legacy links on first visit (with `SHARED_LINKS_AUTO_MIGRATE` env var opt-out)
- Bulk migration script for pre-migration (optional)
- Permission management via existing `/api/permissions/:resourceType/:resourceId` routes (with middleware additions)
- OWNER assignment blocked at both API and UI level
- ACL cleanup on single delete, bulk delete, and user deletion
- "Manage Access" UI in SharedLinkButton dialog
- Config/role permission propagation for `SHARED_LINKS` permission type

### Deferred to phase 2

- Per-link auth toggle (override `ALLOW_SHARED_LINKS_PUBLIC` per link — `SHARE_PUBLIC` can be repurposed for this)
- ACL UI in shared links management page (Settings > Data)
- Admin restrictions on which conversations can be shared

## Accepted Tradeoffs

These are deliberate design choices that were considered and rejected or deferred during review. They are documented here so future reviewers understand the reasoning.

**Non-transactional link creation.** SharedLink creation + OWNER grant + PUBLIC grant are not wrapped in a MongoDB transaction. If either ACL grant fails, a compensating delete removes the SharedLink and any already-created AclEntries. This matches the agent creation pattern (`agents/v1.js`) which uses the same compensating-action approach. The false-failure edge case (timeout where the write actually succeeded) is covered in the "Orphaned AclEntries" tradeoff below. Transactions can be added as an implementation optimization.

**Auto-migration does not `$unset isPublic`.** Request-time auto-migration creates AclEntries but leaves the `isPublic` field on the document. This is intentional — `isPublic` presence is the signal that distinguishes legacy links from new/migrated links. The bulk migration script's `$unset` is the finalization step. Deployments relying only on lazy migration stay in mixed mode indefinitely; this is benign because auto-migration is idempotent (re-checks find existing AclEntries and skip). Operators who want clean state should run the bulk script.

**Duplicate AclEntries from concurrent upserts.** AclEntry compound indexes are not unique (`aclEntry.ts:73`). Concurrent upserts could theoretically create duplicate rows. This is harmless: all delete paths (`removeAllPermissions`, `bulkUpdateResourcePermissions` revoke) use broad filters that co-delete duplicates. Permission reads may return duplicates but the effective permission calculation (bitwise OR) produces the correct result. Adding a unique index is an existing codebase concern affecting all resource types, not specific to shared links.

**Role-level SHARE is a UI gate, not an API gate.** A creator with OWNER AclEntry (which includes `PermissionBits.SHARE`) can call the permission API directly regardless of their role's SHARE setting. This is a known limitation across all resource types (agents, prompts, MCP servers, skills). Server-side enforcement is tracked as a separate codebase-wide issue. See: "Enforce role-level SHARE permission at API layer for all resource types."

**Performance: 2 queries steady-state vs 1 today.** Migrated public links require 2 queries (SharedLink fetch + PUBLIC AclEntry lookup) vs 1 today. Legacy links on first visit cost ~4-5 ops (fetch + isPublic check + OWNER upsert + PUBLIC upsert + public lookup). This matches the cost agents pay for ACL checks. Public shared links can receive anonymous traffic from social media; if this becomes a bottleneck, the PUBLIC AclEntry check can be cached per-resource or folded into a compound query.

**`MANAGE_SHARED_LINKS` has no admin UI consumer in phase 1.** The capability IS consumed by `canAccessResource.js:74` — it allows admins with this capability to bypass ACL checks on shared link permission routes. The admin-facing shared links management page (which would directly use this capability for UI gating) is deferred to phase 2.

**`EDIT` bit in SHARED_LINK_OWNER permBits.** No shared-link operation is gated by EDIT. Included for parity with `RoleBits.OWNER` — all resource types use the same OWNER bit pattern. Avoids a special case in the role seeding.

**No incoming shares listing.** In phase 1, recipients of shared links discover them via out-of-band URL sharing (e.g., Slack, email). There is no "shared with me" inbox or listing. Recipients visit the URL directly; the access resolver grants or denies based on their AclEntry. A listing feature is deferred to phase 2.

**`SHARED_LINKS.USE` has no enforced consumer in phase 1.** The permission is defined in role defaults but no route middleware or frontend gate checks it. The existing share routes (`POST /:conversationId`, `GET /`) use only `requireJwtAuth`. Adding USE enforcement would change existing behavior (currently any authenticated user can create links). USE is included in the schema for future gating (admin can disable shared links entirely for a role) but is not wired in phase 1 to avoid behavioral regression. Enforcement is a phase 2 addition.

**People Picker dependency for adding specific principals.** Users with `SHARE: true` can open "Manage Access" and toggle the "everyone" switch, but adding specific users/groups requires People Picker permissions (`VIEW_USERS`, `VIEW_GROUPS`) separately configured for their role. `GenericGrantAccessDialog` hides the principal search UI without these permissions (`GenericGrantAccessDialog.tsx:284`). The dialog is still useful for the public toggle alone. This matches the agent pattern — People Picker is a prerequisite for per-principal sharing across all resource types.

**Duplicate AclEntries may appear in permission responses.** The `GET /permissions` endpoint iterates raw AclEntry rows into the UI principal list (`PermissionsController.js:247`). Duplicate rows from concurrent upserts could appear as duplicate principals in the dialog. This is a pre-existing codebase issue affecting all resource types. If it causes UX problems, add read-time deduplication in `PermissionsController.js` — but this is a codebase-wide fix, not shared-link-specific.

**Orphaned AclEntries from false-failure compensating deletes.** If an OWNER grant appears to fail but actually succeeded (timeout), the compensating delete removes the SharedLink while the AclEntry persists. The orphan is harmless — the resource ID will never be reissued (ObjectId uniqueness), so no access path exists. There is no periodic cleanup job; orphans accumulate but have zero security or functional impact.

**Raw `isPublic` lookup is a transitional hack.** After `isPublic` is removed from the Mongoose schema, the access resolver reads it via lean query (Mongoose strict mode strips unknown fields). This works but creates a TypeScript-vs-Mongo schema lie. The hack persists until all installations are presumed migrated and the bulk script has run. A phase 3 cleanup should remove the `isPublic` detection logic from the access resolver and auto-migration path.

## Files Changed

### packages/data-provider (shared types)
- `src/accessPermissions.ts` — ResourceType, AccessRoleIds, accessRoleToPermBits, make `public` optional in updateResourcePermissionsRequestSchema
- `src/permissions.ts` — PermissionTypes, PERMISSION_TYPE_INTERFACE_FIELDS (line 74), sharedLinksPermissionsSchema, permissionsSchema
- `src/roles.ts` — roleDefaults for SHARED_LINKS
- `src/config.ts` — interfaceSchema defaults for sharedLinks
- `src/api-endpoints.ts` — remove isPublic from getSharedLinks endpoint
- `src/data-service.ts` — remove isPublic from listSharedLinks
- `src/types/queries.ts` — remove isPublic from SharedLinksListParams
- `src/schemas.ts` — remove isPublic from share zod schemas
- `src/react-query/react-query-service.ts` — preserve `_id` in shared link query cache rewrite (mutations.ts stores entire _data, no change needed there)

### packages/data-schemas (backend models/methods)
- `src/schema/share.ts` — remove isPublic field
- `src/types/share.ts` — remove isPublic from interfaces
- `src/methods/share.ts` — remove isPublic from all queries/filters/responses; add ACL cleanup to bulk deletes
- `src/methods/share.test.ts` — update tests
- `src/methods/accessRole.ts` — add SHARED_LINK roles to seedDefaultRoles
- `src/admin/capabilities.ts` — add MANAGE_SHARED_LINKS + READ_SHARED_LINKS to SystemCapabilities, add implication to CapabilityImplications, add to CAPABILITY_CATEGORIES, add to ResourceCapabilityMap

### packages/api (new TS backend logic)
- `src/share/access.ts` — new: ACL-based access resolution
- `src/share/service.ts` — new: creation with ACL grants (rollback on OWNER failure), deletion with cleanup
- `src/app/permissions.ts` — add SHARED_LINKS to hasExplicitConfig, permission assembly, and share backfill

### api (thin JS wrappers)
- `server/routes/share.js` — delegate to new TS handlers, use optionalJwtAuth, remove isPublic query param
- `server/routes/accessPermissions.js` — add SHARED_LINK case to checkResourcePermissionAccess
- `server/middleware/checkSharePublicAccess.js` — skip SHARE_PUBLIC check for sharedLink resource type
- `server/services/PermissionService.js` — protect OWNER for shared links: reject assignment to non-owners, reject demotion of owners, reject removal of owners (see truth table in Section 4)
- `server/controllers/PermissionsController.js` — treat missing `public` field as "no change" instead of "revoke"
- `server/controllers/UserController.js` — add shared link AclEntry cleanup on user deletion
- `server/controllers/__tests__/deleteUserResourceCoverage.spec.js` — update test that asserts user deletion covers all resource types

### config (migration)
- `migrate-shared-link-permissions.js` — new: migration script

### client (frontend)
- `src/utils/resources.ts` — add SHARED_LINK to RESOURCE_CONFIGS
- `src/hooks/Sharing/useCanSharePublic.ts` — special-case SHARED_LINK to check SHARE instead of SHARE_PUBLIC
- `src/components/Conversations/ConvoOptions/SharedLinkButton.tsx` — add "Manage Access" button with dual gate (useHasAccess + useResourcePermissions)
- `src/components/Sharing/GenericGrantAccessDialog.tsx` — only send `public` field when value changed from initial state (fixes 403 when public state is unchanged)
- `src/components/Sharing/AccessRolesPicker.tsx` — filter out OWNER from assignable options, gate on `resourceType === SHARED_LINK` (or `RESOURCE_CONFIGS.ownerLocked` flag) to avoid regressing agents/prompts
- `src/components/Sharing/PeoplePicker/SelectedPrincipalsList.tsx` — render OWNER principal as non-removable, gate on resourceType to avoid regressing agents/prompts
- `src/components/Sharing/PublicSharingToggle.tsx` — add SHARED_LINK to `accessDescriptions: Record<ResourceType, ...>`
- `src/utils/roles.ts` — add `sharedLink_viewer` and `sharedLink_owner` to `ROLE_LOCALIZATIONS`
- `src/components/Nav/SettingsTabs/Data/SharedLinks.tsx` — remove isPublic from query params
- `src/data-provider/queries.ts` — remove isPublic from query hook
- `src/locales/en/translation.json` — new localization keys (com_ui_shared_link_manage_access used in SharedLinkButton; others deferred to phase 2 management page)

## Testing Strategy

Per CLAUDE.md: real logic over mocks, `mongodb-memory-server` for DB tests. Key test surfaces:

- **Access resolver branches:** PUBLIC AclEntry × `ALLOW_SHARED_LINKS_PUBLIC` on/off × auth-present/absent (matrix of cases)
- **Auto-migration:** legacy link with user, legacy without user, legacy with `isPublic: false`, already-migrated link, concurrent visits
- **OWNER validation:** the three truth-table rules (reject assignment to non-owner, reject demotion, reject removal)
- **Creation rollback:** OWNER grant failure deletes SharedLink; PUBLIC grant failure deletes SharedLink + OWNER AclEntry
- **Bulk delete / user delete cleanup:** AclEntries cleaned up, correct ordering
- **Migration script:** `--dry-run`, `--force`, `isPublic: false` abort, batched processing, idempotent re-runs
- **DTO regression for existing resources:** the `public` optional change in `updateResourcePermissionsRequestSchema` affects agents, prompts, MCP servers, skills. At least one round-trip test per resource type confirming that omitting `public` preserves current public state (not revoking)
- **Tenant context:** anonymous access resolves tenant from SharedLink, not from `req.user`

Detailed test implementation is part of the implementation plan, not this design spec.
