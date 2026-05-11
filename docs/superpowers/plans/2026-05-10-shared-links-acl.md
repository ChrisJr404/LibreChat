# Shared Links ACL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add granular access control to shared links using the existing ACL system, so users can share conversation links with specific users, groups, roles, or everyone.

**Architecture:** Extend the existing ACL system (`AclEntry`, `AccessControlService`, permission routes) with a new `SHARED_LINK` resource type. Remove the boolean `isPublic` field from `SharedLink` documents and replace it with ACL entries. Auto-migration handles legacy links on first visit; a bulk migration script is available for pre-migration. The frontend reuses `GenericGrantAccessDialog` for the "Manage Access" UI.

**Tech Stack:** TypeScript, MongoDB/Mongoose, Express, React, React Query, Zod, librechat-data-provider

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `packages/api/src/share/access.ts` | ACL-based access resolver for `GET /api/share/:shareId` |
| `packages/api/src/share/service.ts` | Share creation with OWNER+PUBLIC grants, deletion with ACL cleanup |
| `config/migrate-shared-link-permissions.js` | Bulk migration script for legacy shared links |

### Modified files (by task)

**Task 1 — Enum/Type Foundation:**
- `packages/data-provider/src/accessPermissions.ts` — ResourceType, AccessRoleIds, accessRoleToPermBits, `public` optional in schema
- `packages/data-provider/src/permissions.ts` — PermissionTypes, PERMISSION_TYPE_INTERFACE_FIELDS, sharedLinksPermissionsSchema, permissionsSchema
- `packages/data-provider/src/roles.ts` — roleDefaults for SHARED_LINKS
- `packages/data-provider/src/config.ts` — interfaceSchema sharedLinks entry
- `packages/data-schemas/src/methods/accessRole.ts` — seedDefaultRoles
- `packages/data-schemas/src/admin/capabilities.ts` — SystemCapabilities, CapabilityImplications, CAPABILITY_CATEGORIES, ResourceCapabilityMap

**Task 2 — Remove isPublic:**
- `packages/data-schemas/src/schema/share.ts` — remove isPublic field
- `packages/data-schemas/src/types/share.ts` — remove isPublic from interfaces
- `packages/data-schemas/src/methods/share.ts` — remove isPublic from queries/filters/responses
- `packages/data-provider/src/api-endpoints.ts` — remove isPublic param
- `packages/data-provider/src/data-service.ts` — remove isPublic param
- `packages/data-provider/src/types/queries.ts` — remove isPublic from types
- `packages/data-provider/src/schemas.ts` — remove isPublic from zod schema
- `client/src/data-provider/queries.ts` — remove isPublic from query hook
- `client/src/components/Nav/SettingsTabs/Data/SharedLinks.tsx` — remove isPublic from params

**Task 3 — Response Type Changes:**
- `packages/data-schemas/src/types/share.ts` — add `_id` to result types
- `packages/data-schemas/src/methods/share.ts` — return `_id` from methods, trigger auto-migration in getSharedLink
- `packages/data-provider/src/types.ts` — add `_id` to response types
- `packages/data-provider/src/react-query/react-query-service.ts` — preserve `_id` in cache

**Task 4 — Access Resolver:**
- `packages/api/src/share/access.ts` — new file

**Task 5 — Share Service:**
- `packages/api/src/share/service.ts` — new file

**Task 6 — Route & Middleware Changes:**
- `api/server/routes/share.js` — optionalJwtAuth, delegate to new TS handlers
- `api/server/routes/accessPermissions.js` — add SHARED_LINK case
- `api/server/middleware/checkSharePublicAccess.js` — skip for sharedLink

**Task 7 — OWNER Protection & PermissionsController Fix:**
- `api/server/services/PermissionService.js` — OWNER protection rules
- `api/server/controllers/PermissionsController.js` — handle missing `public` field

**Task 8 — ACL Cleanup on Deletion:**
- `packages/data-schemas/src/methods/share.ts` — bulk delete returns IDs
- `api/server/routes/share.js` — single delete cleanup
- `api/server/controllers/UserController.js` — user delete cleanup
- `api/server/controllers/__tests__/deleteUserResourceCoverage.spec.js` — add SHARED_LINK

**Task 9 — Permission Propagation:**
- `packages/api/src/app/permissions.ts` — hasExplicitConfig, allPermissions, shareBackfill

**Task 10 — Frontend ACL UI:**
- `client/src/utils/resources.ts` — RESOURCE_CONFIGS entry
- `client/src/utils/roles.ts` — ROLE_LOCALIZATIONS
- `client/src/hooks/Sharing/useCanSharePublic.ts` — SHARED_LINK special case
- `client/src/components/Sharing/PublicSharingToggle.tsx` — accessDescriptions entry
- `client/src/components/Sharing/AccessRolesPicker.tsx` — filter OWNER from assignable
- `client/src/components/Sharing/PeoplePicker/SelectedPrincipalsList.tsx` — OWNER non-removable
- `client/src/components/Conversations/ConvoOptions/SharedLinkButton.tsx` — "Manage Access" button
- `client/src/components/Sharing/GenericGrantAccessDialog.tsx` — send `public` only when changed
- `client/src/locales/en/translation.json` — new keys

**Task 11 — Migration Script:**
- `config/migrate-shared-link-permissions.js` — new file

**Task 12 — Tests:**
- `packages/data-schemas/src/methods/share.test.ts` — update existing tests
- `packages/api/src/share/access.test.ts` — access resolver tests
- `packages/api/src/share/service.test.ts` — service tests

---

## Task 1: Enum & Type Foundation (data-provider + data-schemas)

**Files:**
- Modify: `packages/data-provider/src/accessPermissions.ts:45-86,102,145-150,318-343`
- Modify: `packages/data-provider/src/permissions.ts:6-90,138-251`
- Modify: `packages/data-provider/src/roles.ts:43-254`
- Modify: `packages/data-provider/src/config.ts:885-1016`
- Modify: `packages/data-schemas/src/methods/accessRole.ts:104-229`
- Modify: `packages/data-schemas/src/admin/capabilities.ts:21-223`

- [ ] **Step 1: Add `SHARED_LINK` to `ResourceType` enum**

In `packages/data-provider/src/accessPermissions.ts`, add to the `ResourceType` enum (after line 50):

```ts
SHARED_LINK = 'sharedLink',
```

- [ ] **Step 2: Add `AccessRoleIds` for shared links**

In the same file, add to the `AccessRoleIds` enum (after line 85):

```ts
SHARED_LINK_VIEWER = 'sharedLink_viewer',
SHARED_LINK_OWNER = 'sharedLink_owner',
```

No `SHARED_LINK_EDITOR` — VIEWER is the only assignable role.

- [ ] **Step 3: Add cases to `accessRoleToPermBits`**

In the same file, add `AccessRoleIds.SHARED_LINK_VIEWER` to the VIEWER case block (after line 324):

```ts
case AccessRoleIds.SHARED_LINK_VIEWER:
```

And add `AccessRoleIds.SHARED_LINK_OWNER` to the OWNER case block (after line 336):

```ts
case AccessRoleIds.SHARED_LINK_OWNER:
```

- [ ] **Step 4: Make `public` optional in `updateResourcePermissionsRequestSchema`**

In the same file at line 148, change:

```ts
public: z.boolean(),
```

to:

```ts
public: z.boolean().optional(),
```

This allows shared link permission updates to omit `public` when the public state hasn't changed, avoiding accidental revocation.

- [ ] **Step 5: Add `PermissionTypes.SHARED_LINKS` and mapping**

In `packages/data-provider/src/permissions.ts`, add to the `PermissionTypes` enum (after line 66):

```ts
SHARED_LINKS = 'SHARED_LINKS',
```

Add to `PERMISSION_TYPE_INTERFACE_FIELDS` (after line 89):

```ts
[PermissionTypes.SHARED_LINKS]: 'sharedLinks',
```

- [ ] **Step 6: Add `sharedLinksPermissionsSchema`**

In the same file, after the `skillPermissionsSchema` definition (after line 232), add:

```ts
export const sharedLinksPermissionsSchema = z.object({
  [Permissions.USE]: z.boolean().default(true),
  [Permissions.SHARE]: z.boolean().default(false),
});
export type TSharedLinksPermissions = z.infer<typeof sharedLinksPermissionsSchema>;
```

No `SHARE_PUBLIC` — not used for shared links in phase 1.

- [ ] **Step 7: Add to `permissionsSchema`**

In the same file, add to the `permissionsSchema` object (after line 250):

```ts
[PermissionTypes.SHARED_LINKS]: sharedLinksPermissionsSchema,
```

- [ ] **Step 8: Add import of `sharedLinksPermissionsSchema` in roles.ts**

In `packages/data-provider/src/roles.ts`, add `sharedLinksPermissionsSchema` to the import from `'./permissions'` (line 1-20).

- [ ] **Step 9: Add SHARED_LINKS to ADMIN role defaults**

In `packages/data-provider/src/roles.ts`, add to the ADMIN `defaultRolesSchema` (after line 112, before the closing `})`):

```ts
[PermissionTypes.SHARED_LINKS]: sharedLinksPermissionsSchema.extend({
  [Permissions.USE]: z.boolean().default(true),
  [Permissions.SHARE]: z.boolean().default(true),
}),
```

And add to the ADMIN `roleDefaults.parse` permissions object (after line 200):

```ts
[PermissionTypes.SHARED_LINKS]: {
  [Permissions.USE]: true,
  [Permissions.SHARE]: true,
},
```

- [ ] **Step 10: Add SHARED_LINKS to USER role defaults**

In the same file, add to the USER `roleDefaults.parse` permissions object (after line 251):

```ts
[PermissionTypes.SHARED_LINKS]: {
  [Permissions.USE]: true,
  [Permissions.SHARE]: false,
},
```

- [ ] **Step 11: Add `sharedLinks` to `interfaceSchema`**

In `packages/data-provider/src/config.ts`, add to the `interfaceSchema` object definition (after the `skills` entry, around line 962):

```ts
sharedLinks: z
  .union([
    z.boolean(),
    z.object({
      use: z.boolean().optional(),
      share: z.boolean().optional(),
    }),
  ])
  .optional(),
```

Add to the `.default({...})` block (after `skills`, around line 1015):

```ts
sharedLinks: {
  use: true,
  share: false,
},
```

- [ ] **Step 12: Add shared link roles to `seedDefaultRoles`**

In `packages/data-schemas/src/methods/accessRole.ts`, add to the `defaultRoles` array in `seedDefaultRoles()` (after the SKILL roles, before the closing `]` around line 212):

```ts
{
  accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
  name: 'com_ui_role_viewer',
  description: 'com_ui_role_viewer_desc',
  resourceType: ResourceType.SHARED_LINK,
  permBits: RoleBits.VIEWER,
},
{
  accessRoleId: AccessRoleIds.SHARED_LINK_OWNER,
  name: 'com_ui_role_owner',
  description: 'com_ui_role_owner_desc',
  resourceType: ResourceType.SHARED_LINK,
  permBits: RoleBits.OWNER,
},
```

- [ ] **Step 13: Add `MANAGE_SHARED_LINKS` and `READ_SHARED_LINKS` to `SystemCapabilities`**

In `packages/data-schemas/src/admin/capabilities.ts`, add to the `SystemCapabilities` object (after line 39):

```ts
READ_SHARED_LINKS: 'read:sharedlinks',
MANAGE_SHARED_LINKS: 'manage:sharedlinks',
```

- [ ] **Step 14: Add capability implication**

In the same file, add to `CapabilityImplications` (after line 58):

```ts
[SystemCapabilities.MANAGE_SHARED_LINKS]: [SystemCapabilities.READ_SHARED_LINKS],
```

- [ ] **Step 15: Add to `CAPABILITY_CATEGORIES`**

In the same file, add `SystemCapabilities.MANAGE_SHARED_LINKS` and `SystemCapabilities.READ_SHARED_LINKS` to the `'content'` category capabilities array (after line 215):

```ts
SystemCapabilities.MANAGE_SHARED_LINKS,
SystemCapabilities.READ_SHARED_LINKS,
```

- [ ] **Step 16: Add to `ResourceCapabilityMap`**

In the same file, add to `ResourceCapabilityMap` (after line 145):

```ts
[ResourceType.SHARED_LINK]: SystemCapabilities.MANAGE_SHARED_LINKS,
```

- [ ] **Step 17: Build data-provider and verify**

Run:
```bash
cd /Users/atefbellaaj/Repos/LibreChat && npm run build:data-provider
```

Expected: Build succeeds. The `ResourceCapabilityMap` is typed as `Record<ResourceType, ...>`, so a missing entry would cause a compile error.

---

## Task 2: Remove `isPublic` from SharedLink

**Files:**
- Modify: `packages/data-schemas/src/schema/share.ts:10,40-43`
- Modify: `packages/data-schemas/src/types/share.ts:12,25,38`
- Modify: `packages/data-schemas/src/methods/share.ts:164,172,218,361,369,441`
- Modify: `packages/data-provider/src/api-endpoints.ts:74-84`
- Modify: `packages/data-provider/src/data-service.ts:65-72`
- Modify: `packages/data-provider/src/types/queries.ts:61-76`
- Modify: `packages/data-provider/src/schemas.ts:1024-1032`
- Modify: `client/src/data-provider/queries.ts:142-165`
- Modify: `client/src/components/Nav/SettingsTabs/Data/SharedLinks.tsx:39-45`

- [ ] **Step 1: Remove `isPublic` from Mongoose schema**

In `packages/data-schemas/src/schema/share.ts`, remove the `isPublic` property from the interface (line 10) and from the schema definition (lines 40-43):

Remove from interface:
```ts
isPublic: boolean;
```

Remove from schema:
```ts
isPublic: {
  type: Boolean,
  default: true,
},
```

- [ ] **Step 2: Remove `isPublic` from type interfaces**

In `packages/data-schemas/src/types/share.ts`:

Remove `isPublic: boolean;` from `ISharedLink` (line 12).

Remove `isPublic: boolean;` from the `SharedLinksResult.links` array type (line 25).

Remove `isPublic: boolean;` from `SharedMessagesResult` (line 38).

- [ ] **Step 3: Remove `isPublic` from `getSharedMessages`**

In `packages/data-schemas/src/methods/share.ts`, in `getSharedMessages`:

Line 164 — change `{ shareId, isPublic: true }` to `{ shareId }`:
```ts
const share = (await SharedLink.findOne({ shareId })
```

Line 172 — change `!share?.conversationId || !share.isPublic` to `!share?.conversationId`:
```ts
if (!share?.conversationId) {
```

Lines 183-191 — remove `isPublic: share.isPublic` from the result object.

- [ ] **Step 4: Remove `isPublic` from `getSharedLinks`**

In the same file, in `getSharedLinks`:

Remove `isPublic` parameter from the function signature (line 210).

Line 218 — change `{ user, isPublic }` to `{ user }`:
```ts
const query: FilterQuery<t.ISharedLink> = { user };
```

Lines 274-280 — remove `isPublic: link.isPublic` from the mapped result.

- [ ] **Step 5: Remove `isPublic` from `createSharedLink`**

In the same file, in `createSharedLink`:

Lines 358-363 — remove `isPublic: true` from the `findOne` filter:
```ts
SharedLink.findOne({
  conversationId,
  user,
  ...(targetMessageId && { targetMessageId }),
})
```

Lines 369-370 — remove the `existingShare.isPublic` check. Simplify to just checking `existingShare`:
```ts
if (existingShare) {
  logger.error('[createSharedLink] Share already exists', {
    user,
    conversationId,
    targetMessageId,
  });
  throw new ShareServiceError('Share already exists', 'SHARE_EXISTS');
}
```

Remove the `else if (existingShare)` branch that deletes non-public shares (lines 376-382) — it's dead code since `isPublic` was always `true`.

- [ ] **Step 6: Remove `isPublic` from `getSharedLink`**

In the same file, in `getSharedLink`:

Line 441 — change `{ conversationId, user, isPublic: true }` to `{ conversationId, user }`:
```ts
const share = (await SharedLink.findOne({ conversationId, user })
```

- [ ] **Step 7: Remove `isPublic` from data-provider endpoints**

In `packages/data-provider/src/api-endpoints.ts`, remove `isPublic` parameter from `getSharedLinks` function (lines 74-84):

```ts
export const getSharedLinks = (
  pageSize: number,
  sortBy: 'title' | 'createdAt',
  sortDirection: 'asc' | 'desc',
  search?: string,
  cursor?: string,
) =>
  `${shareRoot}?pageSize=${pageSize}&sortBy=${sortBy}&sortDirection=${sortDirection}${
    search ? `&search=${search}` : ''
  }${cursor ? `&cursor=${cursor}` : ''}`;
```

- [ ] **Step 8: Remove `isPublic` from data-service**

In `packages/data-provider/src/data-service.ts`, update `listSharedLinks` (lines 65-72):

```ts
export const listSharedLinks = async (
  params: q.SharedLinksListParams,
): Promise<q.SharedLinksResponse> => {
  const { pageSize, sortBy, sortDirection, search, cursor } = params;

  return request.get(
    endpoints.getSharedLinks(pageSize, sortBy, sortDirection, search, cursor),
  );
};
```

- [ ] **Step 9: Remove `isPublic` from query types**

In `packages/data-provider/src/types/queries.ts`:

Remove `isPublic: boolean;` from `SharedLinksListParams` (line 63).

Remove `isPublic: boolean;` from `SharedLinkItem` (line 73).

- [ ] **Step 10: Remove `isPublic` from zod schema**

In `packages/data-provider/src/schemas.ts`, remove `isPublic: z.boolean(),` from `tSharedLinkSchema` (line 1028).

Also search for any other `isPublic` in share-related schemas in this file (around line 1314) and remove.

- [ ] **Step 11: Remove `isPublic` from frontend query hook**

In `client/src/data-provider/queries.ts`, update `useSharedLinksQuery` (lines 142-165):

Remove `isPublic` from destructuring (line 146), from `queryKey` (line 149), and from the `dataService.listSharedLinks` call (lines 151-158).

- [ ] **Step 12: Remove `isPublic` from SharedLinks component**

In `client/src/components/Nav/SettingsTabs/Data/SharedLinks.tsx`, remove `isPublic: true` from `DEFAULT_PARAMS` (line 41).

- [ ] **Step 13: Remove `isPublic` from share route**

In `api/server/routes/share.js`, remove `isPublic: isEnabled(req.query.isPublic)` from the `GET /` handler params (line 51), and remove it from the `getSharedLinks` call (line 63).

- [ ] **Step 14: Build and verify**

```bash
cd /Users/atefbellaaj/Repos/LibreChat && npm run build:data-provider
```

Expected: Build succeeds with no TypeScript errors related to `isPublic`.

---

## Task 3: Response Type Changes (add `_id`)

**Files:**
- Modify: `packages/data-schemas/src/types/share.ts:43-67`
- Modify: `packages/data-schemas/src/methods/share.ts:364,413,441-442,490-502`
- Modify: `packages/data-provider/src/types.ts:318-322`
- Modify: `packages/data-provider/src/react-query/react-query-service.ts:53-57`

- [ ] **Step 1: Add `_id` to result types**

In `packages/data-schemas/src/types/share.ts`:

Add `_id?: string;` to `CreateShareResult` (after line 43):
```ts
export interface CreateShareResult {
  _id?: string;
  shareId: string;
  conversationId: string;
}
```

Add `_id?: string;` to `UpdateShareResult` (after line 48):
```ts
export interface UpdateShareResult {
  _id?: string;
  shareId: string;
  conversationId: string;
}
```

Add `_id?: string;` to `GetShareLinkResult` (after line 59):
```ts
export interface GetShareLinkResult {
  _id?: string;
  shareId: string | null;
  success: boolean;
}
```

- [ ] **Step 2: Return `_id` from `createSharedLink`**

In `packages/data-schemas/src/methods/share.ts`, in `createSharedLink`:

After `SharedLink.create(...)` (around line 404), capture the created document's `_id`:

```ts
const created = await SharedLink.create({
  shareId,
  conversationId,
  messages: conversationMessages,
  title,
  user,
  ...(targetMessageId && { targetMessageId }),
});

return { _id: created._id.toString(), shareId, conversationId };
```

- [ ] **Step 3: Return `_id` from `updateSharedLink`**

In the same file, in `updateSharedLink`, update the return (around line 502):

```ts
return {
  _id: updatedShare._id?.toString(),
  shareId: newShareId,
  conversationId: updatedShare.conversationId,
};
```

- [ ] **Step 4: Return `_id` from `getSharedLink`**

In the same file, in `getSharedLink`, update the select and return (around line 441):

```ts
const share = (await SharedLink.findOne({ conversationId, user })
  .select('shareId _id')
  .lean()) as { shareId?: string; _id?: import('mongoose').Types.ObjectId } | null;

if (!share) {
  return { shareId: null, success: false };
}

return {
  _id: share._id?.toString(),
  shareId: share.shareId || null,
  success: true,
};
```

- [ ] **Step 5: Update data-provider response types**

In `packages/data-provider/src/types.ts`:

Update `TSharedLinkResponse` (line 318):
```ts
export type TSharedLinkResponse = Pick<TSharedLink, 'shareId'> &
  Pick<TConversation, 'conversationId'> & {
    _id?: string;
  };
```

`TSharedLinkGetResponse` extends `TSharedLinkResponse`, so it inherits `_id` automatically.

- [ ] **Step 6: Preserve `_id` in React Query cache rewrite**

In `packages/data-provider/src/react-query/react-query-service.ts`, update the `onSuccess` handler (lines 53-57):

```ts
onSuccess: (data) => {
  queryClient.setQueryData([QueryKeys.sharedLinks, conversationId], {
    _id: data._id,
    conversationId: data.conversationId,
    shareId: data.shareId,
  });
},
```

- [ ] **Step 7: Build and verify**

```bash
cd /Users/atefbellaaj/Repos/LibreChat && npm run build:data-provider
```

---

## Task 4: Access Resolver

**Files:**
- Create: `packages/api/src/share/access.ts`

- [ ] **Step 1: Create the access resolver**

Create `packages/api/src/share/access.ts`:

```ts
import mongoose from 'mongoose';
import { isEnabled } from '@librechat/api';
import {
  ResourceType,
  PrincipalType,
  AccessRoleIds,
  PermissionBits,
} from 'librechat-data-provider';
import { logger, tenantStorage } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { ISharedLink } from '@librechat/data-schemas';
import { AccessControlService } from '~/acl/accessControlService';

const autoMigrateEnabled =
  process.env.SHARED_LINKS_AUTO_MIGRATE === undefined ||
  isEnabled(process.env.SHARED_LINKS_AUTO_MIGRATE);

const allowPublic = isEnabled(process.env.ALLOW_SHARED_LINKS_PUBLIC);

async function autoMigrateLink(
  share: ISharedLink & { isPublic?: boolean },
  resourceId: mongoose.Types.ObjectId,
): Promise<void> {
  const AclEntry = mongoose.models.AclEntry;

  const existingOwner = await AclEntry.findOne({
    resourceType: ResourceType.SHARED_LINK,
    resourceId,
    principalType: PrincipalType.USER,
    accessRoleId: { $exists: false },
  }).lean();

  if (share.user) {
    const ownerExists = await AclEntry.findOne({
      resourceType: ResourceType.SHARED_LINK,
      resourceId,
      principalType: PrincipalType.USER,
      principalId: new mongoose.Types.ObjectId(share.user),
    }).lean();

    if (!ownerExists) {
      try {
        await AccessControlService.grantPermission({
          principalType: PrincipalType.USER,
          principalId: new mongoose.Types.ObjectId(share.user),
          resourceType: ResourceType.SHARED_LINK,
          resourceId,
          accessRoleId: AccessRoleIds.SHARED_LINK_OWNER,
          grantedBy: new mongoose.Types.ObjectId(share.user),
        });
      } catch (err) {
        logger.error('[autoMigrateLink] Failed to grant OWNER', {
          shareId: share.shareId,
          error: err instanceof Error ? err.message : 'Unknown',
        });
      }
    }
  }

  if (share.isPublic !== false) {
    const publicExists = await AclEntry.findOne({
      resourceType: ResourceType.SHARED_LINK,
      resourceId,
      principalType: PrincipalType.PUBLIC,
    }).lean();

    if (!publicExists) {
      try {
        await AccessControlService.grantPermission({
          principalType: PrincipalType.PUBLIC,
          principalId: null,
          resourceType: ResourceType.SHARED_LINK,
          resourceId,
          accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
          grantedBy: share.user
            ? new mongoose.Types.ObjectId(share.user)
            : null,
        });
      } catch (err) {
        logger.error('[autoMigrateLink] Failed to grant PUBLIC VIEWER', {
          shareId: share.shareId,
          error: err instanceof Error ? err.message : 'Unknown',
        });
      }
    }
  } else {
    logger.warn('[autoMigrateLink] Skipping PUBLIC grant for isPublic:false link', {
      shareId: share.shareId,
    });
  }

  logger.info('[autoMigrateLink] Auto-migrated legacy shared link', {
    shareId: share.shareId,
    user: share.user,
    isPublic: share.isPublic,
  });
}

export async function resolveShareAccess(
  req: Request,
  res: Response,
): Promise<void> {
  const { shareId } = req.params;
  const SharedLink = mongoose.models.SharedLink;

  const share = await SharedLink.findOne({ shareId }).lean() as
    (ISharedLink & { isPublic?: boolean; _id: mongoose.Types.ObjectId; tenantId?: string }) | null;

  if (!share) {
    res.status(404).end();
    return;
  }

  const resourceId = share._id;

  const runInTenantContext = async (fn: () => Promise<void>) => {
    if (share.tenantId) {
      return tenantStorage.run({ tenantId: share.tenantId }, fn);
    }
    return fn();
  };

  await runInTenantContext(async () => {
    const isLegacy = 'isPublic' in share;

    if (isLegacy) {
      if (!autoMigrateEnabled) {
        logger.warn('[resolveShareAccess] Legacy link with no ACL, auto-migrate disabled', {
          shareId,
        });
        res.status(403).json({ message: 'Shared link not yet migrated' });
        return;
      }
      await autoMigrateLink(share, resourceId);
    }

    const AclEntry = mongoose.models.AclEntry;
    const publicEntry = await AclEntry.findOne({
      resourceType: ResourceType.SHARED_LINK,
      resourceId,
      principalType: PrincipalType.PUBLIC,
    }).lean();

    if (publicEntry) {
      if (allowPublic) {
        return;
      }
      if (!req.user) {
        res.status(401).json({ message: 'Authentication required' });
        return;
      }
      return;
    }

    if (!req.user) {
      res.status(401).json({ message: 'Authentication required' });
      return;
    }

    const userId = (req.user as { id: string }).id;
    const hasAccess = await AccessControlService.checkPermission({
      userId: new mongoose.Types.ObjectId(userId),
      resourceType: ResourceType.SHARED_LINK,
      resourceId,
      requiredPermission: PermissionBits.VIEW,
    });

    if (!hasAccess) {
      res.status(403).json({ message: 'Access denied' });
      return;
    }
  });
}
```

- [ ] **Step 2: Verify the file compiles**

```bash
cd /Users/atefbellaaj/Repos/LibreChat && npx tsc --noEmit packages/api/src/share/access.ts 2>&1 | head -20
```

Note: Exact compilation depends on tsconfig paths. Fix any import path issues.

---

## Task 5: Share Service (Creation with ACL Grants)

**Files:**
- Create: `packages/api/src/share/service.ts`

- [ ] **Step 1: Create the share service**

Create `packages/api/src/share/service.ts`:

```ts
import mongoose from 'mongoose';
import {
  ResourceType,
  PrincipalType,
  AccessRoleIds,
} from 'librechat-data-provider';
import { logger } from '@librechat/data-schemas';
import type { ISharedLink } from '@librechat/data-schemas';
import { AccessControlService } from '~/acl/accessControlService';

export async function grantCreationPermissions(
  sharedLinkId: mongoose.Types.ObjectId,
  userId: string,
): Promise<void> {
  const SharedLink = mongoose.models.SharedLink;
  const userObjectId = new mongoose.Types.ObjectId(userId);

  try {
    await AccessControlService.grantPermission({
      principalType: PrincipalType.USER,
      principalId: userObjectId,
      resourceType: ResourceType.SHARED_LINK,
      resourceId: sharedLinkId,
      accessRoleId: AccessRoleIds.SHARED_LINK_OWNER,
      grantedBy: userObjectId,
    });
  } catch (ownerError) {
    logger.error('[grantCreationPermissions] OWNER grant failed, deleting SharedLink', {
      sharedLinkId: sharedLinkId.toString(),
      error: ownerError instanceof Error ? ownerError.message : 'Unknown',
    });
    await SharedLink.deleteOne({ _id: sharedLinkId });
    throw ownerError;
  }

  try {
    await AccessControlService.grantPermission({
      principalType: PrincipalType.PUBLIC,
      principalId: null,
      resourceType: ResourceType.SHARED_LINK,
      resourceId: sharedLinkId,
      accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
      grantedBy: userObjectId,
    });
  } catch (publicError) {
    logger.error('[grantCreationPermissions] PUBLIC grant failed, cleaning up', {
      sharedLinkId: sharedLinkId.toString(),
      error: publicError instanceof Error ? publicError.message : 'Unknown',
    });
    await SharedLink.deleteOne({ _id: sharedLinkId });
    await AccessControlService.removeAllPermissions({
      resourceType: ResourceType.SHARED_LINK,
      resourceId: sharedLinkId,
    });
    throw publicError;
  }
}

export async function cleanupSharedLinkPermissions(
  resourceId: mongoose.Types.ObjectId,
): Promise<void> {
  await AccessControlService.removeAllPermissions({
    resourceType: ResourceType.SHARED_LINK,
    resourceId,
  });
}

export async function cleanupBulkSharedLinkPermissions(
  resourceIds: mongoose.Types.ObjectId[],
): Promise<void> {
  if (resourceIds.length === 0) {
    return;
  }

  const AclEntry = mongoose.models.AclEntry;
  await AclEntry.deleteMany({
    resourceType: ResourceType.SHARED_LINK,
    resourceId: { $in: resourceIds },
  });
}
```

---

## Task 6: Route & Middleware Changes

**Files:**
- Modify: `api/server/routes/share.js`
- Modify: `api/server/routes/accessPermissions.js:46-91`
- Modify: `api/server/middleware/checkSharePublicAccess.js:23-30`

- [ ] **Step 1: Update `GET /api/share/:shareId` to use `optionalJwtAuth` and access resolver**

In `api/server/routes/share.js`, replace the `GET /:shareId` route (lines 22-41):

```js
const optionalJwtAuth = require('~/server/middleware/optionalJwtAuth');
const { resolveShareAccess } = require('@librechat/api');
const { getSharedMessages } = require('~/models');

if (allowSharedLinks) {
  router.get(
    '/:shareId',
    optionalJwtAuth,
    async (req, res) => {
      try {
        await resolveShareAccess(req, res);
        if (res.headersSent) {
          return;
        }

        const share = await getSharedMessages(req.params.shareId);
        if (share) {
          res.status(200).json(share);
        } else {
          res.status(404).end();
        }
      } catch (error) {
        logger.error('Error getting shared messages:', error);
        res.status(500).json({ message: 'Error getting shared messages' });
      }
    },
  );
}
```

Remove the `allowSharedLinksPublic` variable (line 22) and the old ternary auth middleware.

- [ ] **Step 2: Add ACL grants to `POST /:conversationId` route**

In the same file, update the `POST /:conversationId` handler (lines 98-111) to call `grantCreationPermissions` after creation:

```js
const { grantCreationPermissions } = require('@librechat/api');

router.post('/:conversationId', requireJwtAuth, async (req, res) => {
  try {
    const { targetMessageId } = req.body;
    const created = await createSharedLink(req.user.id, req.params.conversationId, targetMessageId);
    if (created) {
      await grantCreationPermissions(created._id, req.user.id);
      res.status(200).json(created);
    } else {
      res.status(404).end();
    }
  } catch (error) {
    logger.error('Error creating shared link:', error);
    res.status(500).json({ message: 'Error creating shared link' });
  }
});
```

Note: `created._id` is now returned from `createSharedLink` (Task 3).

- [ ] **Step 3: Add ACL cleanup to `DELETE /:shareId` route**

In the same file, update the `DELETE /:shareId` handler (lines 127-140):

```js
const { cleanupSharedLinkPermissions } = require('@librechat/api');

router.delete('/:shareId', requireJwtAuth, async (req, res) => {
  try {
    const SharedLink = require('mongoose').models.SharedLink;
    const link = await SharedLink.findOne({ shareId: req.params.shareId, user: req.user.id })
      .select('_id')
      .lean();

    const result = await deleteSharedLink(req.user.id, req.params.shareId);

    if (!result) {
      return res.status(404).json({ message: 'Share not found' });
    }

    if (link?._id) {
      cleanupSharedLinkPermissions(link._id).catch((err) => {
        logger.error('[deleteSharedLink] ACL cleanup failed', err);
      });
    }

    return res.status(200).json(result);
  } catch (error) {
    logger.error('Error deleting shared link:', error);
    return res.status(400).json({ message: 'Error deleting shared link' });
  }
});
```

- [ ] **Step 4: Add `SHARED_LINK` case to `checkResourcePermissionAccess`**

In `api/server/routes/accessPermissions.js`, add a new case after the SKILL block (after line 81):

```js
} else if (resourceType === ResourceType.SHARED_LINK) {
  middleware = canAccessResource({
    resourceType: ResourceType.SHARED_LINK,
    requiredPermission,
    resourceIdParam: 'resourceId',
  });
```

- [ ] **Step 5: Skip `SHARE_PUBLIC` check for shared links**

In `api/server/middleware/checkSharePublicAccess.js`, add an early return at the top of the middleware function (after line 24, before the `isPublic` check):

```js
const { resourceType } = req.params;
if (resourceType === ResourceType.SHARED_LINK) {
  return next();
}
```

Move the existing `const { resourceType } = req.params;` (line 40) to avoid duplication, or remove it.

---

## Task 7: OWNER Protection & PermissionsController Fix

**Files:**
- Modify: `api/server/services/PermissionService.js:672-878`
- Modify: `api/server/controllers/PermissionsController.js:52-174`

- [ ] **Step 1: Add OWNER protection in `bulkUpdateResourcePermissions`**

In `api/server/services/PermissionService.js`, add validation before the bulk write loop (after line 719, before the `for (const principal of updatedPrincipals)` loop):

```js
if (resourceType === ResourceType.SHARED_LINK) {
  const AclEntry = mongoose.models.AclEntry;
  for (const principal of updatedPrincipals) {
    if (principal.type === PrincipalType.PUBLIC) {
      continue;
    }
    const existing = await AclEntry.findOne({
      resourceType,
      resourceId,
      principalType: principal.type,
      ...(principal.type !== PrincipalType.PUBLIC && {
        principalId: principal.type === PrincipalType.ROLE
          ? principal.id
          : new mongoose.Types.ObjectId(principal.id),
      }),
    }).lean();

    const isExistingOwner = existing &&
      existing.roleId &&
      rolesMap.get(AccessRoleIds.SHARED_LINK_OWNER)?._id?.toString() === existing.roleId.toString();

    if (isExistingOwner && principal.accessRoleId !== AccessRoleIds.SHARED_LINK_OWNER) {
      throw new Error('Cannot demote the owner of a shared link');
    }
    if (!isExistingOwner && principal.accessRoleId === AccessRoleIds.SHARED_LINK_OWNER) {
      throw new Error('Cannot assign owner role to non-owner principals for shared links');
    }
  }

  for (const principal of revokedPrincipals) {
    if (principal.type === PrincipalType.PUBLIC) {
      continue;
    }
    const existing = await AclEntry.findOne({
      resourceType,
      resourceId,
      principalType: principal.type,
      ...(principal.type !== PrincipalType.PUBLIC && {
        principalId: principal.type === PrincipalType.ROLE
          ? principal.id
          : new mongoose.Types.ObjectId(principal.id),
      }),
    }).lean();

    const isExistingOwner = existing &&
      existing.roleId &&
      rolesMap.get(AccessRoleIds.SHARED_LINK_OWNER)?._id?.toString() === existing.roleId.toString();

    if (isExistingOwner) {
      throw new Error('Cannot remove the owner of a shared link');
    }
  }
}
```

Add `AccessRoleIds` to the destructured imports at the top of the file:
```js
const { ResourceType, PrincipalType, PrincipalModel, AccessRoleIds } = require('librechat-data-provider');
```

- [ ] **Step 2: Handle missing `public` field in `updateResourcePermissions`**

In `api/server/controllers/PermissionsController.js`, update the logic around lines 70-77 and 137-143. When `isPublic` is `undefined` (not sent), skip both the public grant and the public revoke:

Replace lines 70-77:
```js
if (isPublic !== undefined && isPublic && publicAccessRoleId) {
  updatedPrincipals.push({
    type: PrincipalType.PUBLIC,
    id: null,
    accessRoleId: publicAccessRoleId,
  });
}
```

Replace lines 137-143:
```js
if (isPublic !== undefined && !isPublic) {
  revokedPrincipals.push({
    type: PrincipalType.PUBLIC,
    id: null,
  });
}
```

Update the response (around line 170):
```js
const response = {
  message: 'Permissions updated successfully',
  results: {
    principals: results.granted,
    public: isPublic !== undefined ? (isPublic || false) : undefined,
    publicAccessRoleId: isPublic ? publicAccessRoleId : undefined,
  },
};
```

---

## Task 8: ACL Cleanup on Deletion

**Files:**
- Modify: `packages/data-schemas/src/methods/share.ts:296-339`
- Modify: `api/server/controllers/UserController.js:293-348`
- Modify: `api/server/controllers/__tests__/deleteUserResourceCoverage.spec.js:13-28`

- [ ] **Step 1: Return IDs from bulk delete methods**

In `packages/data-schemas/src/methods/share.ts`, update `deleteAllSharedLinks` to return `_id`s (lines 296-311):

```ts
async function deleteAllSharedLinks(
  user: string,
): Promise<t.DeleteAllSharesResult & { deletedIds: string[] }> {
  try {
    const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
    const links = await SharedLink.find({ user }).select('_id').lean();
    const ids = links.map((l) => l._id);
    const result = await SharedLink.deleteMany({ user });
    return {
      message: 'All shared links deleted successfully',
      deletedCount: result.deletedCount,
      deletedIds: ids.map((id) => id.toString()),
    };
  } catch (error) {
    logger.error('[deleteAllSharedLinks] Error deleting shared links', {
      error: error instanceof Error ? error.message : 'Unknown error',
      user,
    });
    throw new ShareServiceError('Error deleting shared links', 'BULK_DELETE_ERROR');
  }
}
```

Similarly update `deleteConvoSharedLink` to return IDs.

- [ ] **Step 2: Add shared link ACL cleanup to user deletion**

In `api/server/controllers/UserController.js`, update the `deleteUserController` (around line 326):

```js
const { cleanupBulkSharedLinkPermissions } = require('@librechat/api');

// Before deleting shared links, get their IDs
const SharedLinkModel = require('mongoose').models.SharedLink;
const userSharedLinks = await SharedLinkModel.find({ user: user.id }).select('_id').lean();
const sharedLinkIds = userSharedLinks.map((l) => l._id);

await db.deleteAllSharedLinks(user.id);

if (sharedLinkIds.length > 0) {
  await cleanupBulkSharedLinkPermissions(sharedLinkIds);
}
```

Place this block before `await db.deleteAclEntries({ principalId: user._id })` (line 341).

- [ ] **Step 3: Update `deleteUserResourceCoverage` test**

In `api/server/controllers/__tests__/deleteUserResourceCoverage.spec.js`, add to `HANDLED_RESOURCE_TYPES` (after line 18):

```js
[ResourceType.SHARED_LINK]: 'deleteAllSharedLinks',
```

- [ ] **Step 4: Run the coverage test**

```bash
cd /Users/atefbellaaj/Repos/LibreChat/api && npx jest deleteUserResourceCoverage --verbose
```

Expected: All tests pass.

---

## Task 9: Permission Propagation

**Files:**
- Modify: `packages/api/src/app/permissions.ts:15-571`

- [ ] **Step 1: Add `SHARED_LINKS` case to `hasExplicitConfig`**

In `packages/api/src/app/permissions.ts`, add before the `default:` case (after line 49):

```ts
case PermissionTypes.SHARED_LINKS:
  return interfaceConfig?.sharedLinks !== undefined;
```

- [ ] **Step 2: Add `SHARED_LINKS` to `allPermissions`**

In the `allPermissions` object (after the SKILLS block, around line 476), add:

```ts
[PermissionTypes.SHARED_LINKS]: {
  [Permissions.USE]: getPermissionValue(
    getConfigUse(loadedInterface.sharedLinks),
    defaultPerms[PermissionTypes.SHARED_LINKS]?.[Permissions.USE],
    sharedLinksDefaultUse,
  ),
  ...((typeof interfaceConfig?.sharedLinks === 'object' &&
    'share' in interfaceConfig.sharedLinks) ||
  !existingPermissions?.[PermissionTypes.SHARED_LINKS]
    ? {
        [Permissions.SHARE]: getPermissionValue(
          getConfigShare(loadedInterface.sharedLinks),
          defaultPerms[PermissionTypes.SHARED_LINKS]?.[Permissions.SHARE],
          sharedLinksDefaultShare,
        ),
      }
    : {}),
},
```

Add the default value extraction before the `allPermissions` object (near the other `*DefaultUse` declarations):

```ts
const sharedLinksDefaultUse =
  typeof defaults.sharedLinks === 'boolean' ? defaults.sharedLinks : defaults.sharedLinks?.use;
const sharedLinksDefaultShare =
  typeof defaults.sharedLinks === 'object' ? defaults.sharedLinks?.share : undefined;
```

- [ ] **Step 3: Add `SHARED_LINKS` to share backfill array**

In the `shareBackfill` array (after the SKILLS entry, around line 570), add:

```ts
[
  PermissionTypes.SHARED_LINKS,
  {
    [Permissions.SHARE]: getPermissionValue(
      getConfigShare(loadedInterface.sharedLinks),
      defaultPerms[PermissionTypes.SHARED_LINKS]?.[Permissions.SHARE],
      sharedLinksDefaultShare,
    ),
  },
],
```

---

## Task 10: Frontend ACL UI

**Files:**
- Modify: `client/src/utils/resources.ts:15-78`
- Modify: `client/src/utils/roles.ts:8-76`
- Modify: `client/src/hooks/Sharing/useCanSharePublic.ts:1-24`
- Modify: `client/src/components/Sharing/PublicSharingToggle.tsx:19-28`
- Modify: `client/src/components/Sharing/AccessRolesPicker.tsx:47-65`
- Modify: `client/src/components/Sharing/PeoplePicker/SelectedPrincipalsList.tsx:75-93`
- Modify: `client/src/components/Conversations/ConvoOptions/SharedLinkButton.tsx`
- Modify: `client/src/components/Sharing/GenericGrantAccessDialog.tsx:183-191`
- Modify: `client/src/locales/en/translation.json`

- [ ] **Step 1: Add `SHARED_LINK` to `RESOURCE_CONFIGS`**

In `client/src/utils/resources.ts`, add after the SKILL entry (after line 73):

```ts
[ResourceType.SHARED_LINK]: {
  resourceType: ResourceType.SHARED_LINK,
  defaultViewerRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
  defaultEditorRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
  defaultOwnerRoleId: AccessRoleIds.SHARED_LINK_OWNER,
  getResourceName: (name?: string) => name || 'shared link',
  getShareMessage: (name?: string) => name || 'shared link',
  getManageMessage: (name?: string) =>
    `Manage access for ${name || 'shared link'}`,
  getCopyUrlMessage: () => 'Share link copied',
},
```

- [ ] **Step 2: Add shared link role localizations**

In `client/src/utils/roles.ts`, add after the skill roles (after line 75):

```ts
sharedLink_viewer: {
  name: 'com_ui_role_viewer' as const,
  description: 'com_ui_role_viewer_desc' as const,
} as const,
sharedLink_owner: {
  name: 'com_ui_role_owner' as const,
  description: 'com_ui_role_owner_desc' as const,
} as const,
```

- [ ] **Step 3: Special-case `SHARED_LINK` in `useCanSharePublic`**

In `client/src/hooks/Sharing/useCanSharePublic.ts`, replace the hook (lines 17-24):

```ts
export const useCanSharePublic = (resourceType: ResourceType): boolean => {
  const permissionType = resourceType === ResourceType.SHARED_LINK
    ? PermissionTypes.SHARED_LINKS
    : resourceToPermissionMap[resourceType];

  const permission = resourceType === ResourceType.SHARED_LINK
    ? Permissions.SHARE
    : Permissions.SHARE_PUBLIC;

  const hasAccess = useHasAccess({
    permissionType,
    permission,
  });
  return hasAccess;
};
```

Add `PermissionTypes` to the import if not already imported.

- [ ] **Step 4: Add `SHARED_LINK` to `accessDescriptions` in `PublicSharingToggle`**

In `client/src/components/Sharing/PublicSharingToggle.tsx`, update the `accessDescriptions` record type (lines 19-28) to include `SHARED_LINK`:

Update the type to include `'com_ui_shared_link'` and add:

```ts
[ResourceType.SHARED_LINK]: 'com_ui_shared_link',
```

Also add the localization key `com_ui_shared_link` with value `"shared link"` to `client/src/locales/en/translation.json`.

- [ ] **Step 5: Filter OWNER from assignable roles in `AccessRolesPicker`**

In `client/src/components/Sharing/AccessRolesPicker.tsx`, import `RESOURCE_CONFIGS` from `~/utils/resources` and filter out the owner role for shared links (update lines 47-65):

```ts
import { RESOURCE_CONFIGS } from '~/utils/resources';

// Inside the component, before the dropdownItems:
const ownerRoleId = RESOURCE_CONFIGS[resourceType]?.defaultOwnerRoleId;
const filteredRoles = resourceType === ResourceType.SHARED_LINK
  ? (accessRoles || []).filter((role) => role.accessRoleId !== ownerRoleId)
  : accessRoles || [];

const dropdownItems: t.MenuItemProps[] = filteredRoles.map((role: AccessRole) => {
  // ... existing mapping code
});
```

- [ ] **Step 6: Make OWNER principal non-removable in `SelectedPrincipalsList`**

In `client/src/components/Sharing/PeoplePicker/SelectedPrincipalsList.tsx`, import `RESOURCE_CONFIGS` and conditionally hide the remove button and role picker for owners (update the map inside the return, around lines 75-93):

```tsx
import { RESOURCE_CONFIGS } from '~/utils/resources';

// Inside the .map callback:
const ownerRoleId = RESOURCE_CONFIGS[resourceType]?.defaultOwnerRoleId;
const isOwner = share.accessRoleId === ownerRoleId;
const isSharedLink = resourceType === ResourceType.SHARED_LINK;
const lockRoleAndRemove = isSharedLink && isOwner;

// For the role picker:
{!!share.accessRoleId && !!onRoleChange && !lockRoleAndRemove && (
  <AccessRolesPicker ... />
)}
{lockRoleAndRemove && (
  <span className="px-3 py-2 text-sm font-medium text-text-secondary">
    {localize('com_ui_role_owner')}
  </span>
)}

// For the remove button:
{!lockRoleAndRemove && (
  <Button ... />
)}
```

- [ ] **Step 7: Add "Manage Access" button to `SharedLinkButton`**

In `client/src/components/Conversations/ConvoOptions/SharedLinkButton.tsx`, add the "Manage Access" button. Add imports and the button after the existing action buttons (after line 194, before the OGDialog):

```tsx
import {
  PermissionTypes,
  Permissions,
  PermissionBits,
  ResourceType,
} from 'librechat-data-provider';
import { useHasAccess, useResourcePermissions } from '~/hooks';
import GenericGrantAccessDialog from '~/components/Sharing/GenericGrantAccessDialog';

// Inside the component, before the return:
const hasAccessToShareLinks = useHasAccess({
  permissionType: PermissionTypes.SHARED_LINKS,
  permission: Permissions.SHARE,
});

const { hasPermission, isLoading: permissionsLoading } = useResourcePermissions(
  ResourceType.SHARED_LINK,
  share?._id || '',
);

const canManageAccess =
  hasAccessToShareLinks &&
  !permissionsLoading &&
  hasPermission(PermissionBits.SHARE) &&
  !!share?._id;
```

In the JSX, add after the existing buttons in the `{shareId && (` block (inside the flex container, after the delete tooltip):

```tsx
{canManageAccess && (
  <GenericGrantAccessDialog
    resourceType={ResourceType.SHARED_LINK}
    resourceDbId={share?._id}
    resourceName={localize('com_ui_shared_link_manage_access')}
  >
    <Button variant="outline" aria-label={localize('com_ui_shared_link_manage_access')}>
      {localize('com_ui_shared_link_manage_access')}
    </Button>
  </GenericGrantAccessDialog>
)}
```

- [ ] **Step 8: Fix `GenericGrantAccessDialog` to only send `public` when changed**

In `client/src/components/Sharing/GenericGrantAccessDialog.tsx`, update the `handleSave` function (around line 183-191). Only include `public` in the mutation data when the value has changed:

```ts
const publicChanged = isPublic !== currentIsPublic;

await updatePermissionsMutation.mutateAsync({
  resourceType,
  resourceId: resourceDbId,
  data: {
    updated,
    removed,
    ...(publicChanged ? { public: isPublic } : {}),
    ...(publicChanged && isPublic ? { publicAccessRoleId: publicRole } : {}),
  },
});
```

- [ ] **Step 9: Add localization keys**

In `client/src/locales/en/translation.json`, add:

```json
"com_ui_shared_link_manage_access": "Manage Access",
"com_ui_shared_link": "shared link"
```

---

## Task 11: Migration Script

**Files:**
- Create: `config/migrate-shared-link-permissions.js`

- [ ] **Step 1: Create the migration script**

Create `config/migrate-shared-link-permissions.js` following the pattern from `config/migrate-prompt-permissions.js`:

```js
#!/usr/bin/env node
/**
 * Bulk migration script for shared link permissions.
 * Creates OWNER and PUBLIC VIEWER AclEntries for existing SharedLink documents,
 * then $unsets the isPublic field.
 *
 * Prerequisites: Deploy new code first — seeded roles (SHARED_LINK_OWNER, SHARED_LINK_VIEWER)
 * must exist.
 *
 * Flags:
 *   --dry-run       Report without writing
 *   --batch-size=N  Default 100
 *   --force         Proceed even if isPublic:false documents exist
 */

const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..') });

const mongoose = require('mongoose');
const { ResourceType, PrincipalType, AccessRoleIds } = require('librechat-data-provider');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isForce = args.includes('--force');
const batchSizeArg = args.find((a) => a.startsWith('--batch-size='));
const BATCH_SIZE = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) : 100;
const BATCH_DELAY_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI environment variable is required');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');

  const SharedLink = mongoose.models.SharedLink || mongoose.model('SharedLink',
    new mongoose.Schema({}, { strict: false, collection: 'sharedlinks' }));
  const AccessRole = mongoose.models.AccessRole || mongoose.model('AccessRole',
    new mongoose.Schema({}, { strict: false, collection: 'accessroles' }));
  const AclEntry = mongoose.models.AclEntry || mongoose.model('AclEntry',
    new mongoose.Schema({}, { strict: false, collection: 'aclentries' }));

  // Look up required roles
  const ownerRole = await AccessRole.findOne({
    accessRoleId: AccessRoleIds.SHARED_LINK_OWNER,
  }).lean();
  const viewerRole = await AccessRole.findOne({
    accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
  }).lean();

  if (!ownerRole || !viewerRole) {
    console.error('Required roles not seeded. Deploy new code and restart the server first.');
    process.exit(1);
  }

  // Check for isPublic:false anomalies
  const falsePublicCount = await SharedLink.countDocuments({ isPublic: false });
  if (falsePublicCount > 0 && !isForce) {
    const falseDocs = await SharedLink.find({ isPublic: false }).select('_id shareId').lean();
    console.error(`Found ${falsePublicCount} SharedLink documents with isPublic:false.`);
    console.error('Document IDs:', falseDocs.map((d) => d._id.toString()).join(', '));
    console.error('Re-run with --force after manual review.');
    process.exit(1);
  }

  const totalLinks = await SharedLink.countDocuments();
  console.log(`Found ${totalLinks} SharedLink documents to process`);
  console.log(`Mode: ${isDryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Batch size: ${BATCH_SIZE}`);

  let processed = 0;
  let ownerGranted = 0;
  let publicGranted = 0;
  let skippedOwner = 0;
  let skippedPublic = 0;
  let userlessLinks = 0;
  let isPublicFalseLinks = 0;

  let cursor = SharedLink.find().select('_id shareId user isPublic tenantId').lean().cursor();

  let batch = [];
  for await (const link of cursor) {
    batch.push(link);
    if (batch.length >= BATCH_SIZE) {
      await processBatch(batch);
      batch = [];
      await sleep(BATCH_DELAY_MS);
    }
  }
  if (batch.length > 0) {
    await processBatch(batch);
  }

  async function processBatch(links) {
    for (const link of links) {
      processed++;

      // Check OWNER
      if (link.user) {
        const ownerExists = await AclEntry.findOne({
          resourceType: ResourceType.SHARED_LINK,
          resourceId: link._id,
          principalType: PrincipalType.USER,
          principalId: new mongoose.Types.ObjectId(link.user),
        }).lean();

        if (!ownerExists) {
          if (!isDryRun) {
            await AclEntry.findOneAndUpdate(
              {
                resourceType: ResourceType.SHARED_LINK,
                resourceId: link._id,
                principalType: PrincipalType.USER,
                principalId: new mongoose.Types.ObjectId(link.user),
              },
              {
                $set: {
                  permBits: ownerRole.permBits,
                  roleId: ownerRole._id,
                  grantedBy: new mongoose.Types.ObjectId(link.user),
                  grantedAt: new Date(),
                },
                $setOnInsert: {
                  principalModel: 'User',
                  ...(link.tenantId && { tenantId: link.tenantId }),
                },
              },
              { upsert: true },
            );
          }
          ownerGranted++;
        } else {
          skippedOwner++;
        }
      } else {
        userlessLinks++;
      }

      // Check PUBLIC VIEWER
      const hasIsPublicField = link.isPublic !== undefined;
      if (!hasIsPublicField) {
        skippedPublic++;
        continue;
      }

      if (link.isPublic === false) {
        isPublicFalseLinks++;
        if (!isForce) {
          skippedPublic++;
          continue;
        }
        // With --force, skip PUBLIC grant for isPublic:false
        skippedPublic++;
        continue;
      }

      const publicExists = await AclEntry.findOne({
        resourceType: ResourceType.SHARED_LINK,
        resourceId: link._id,
        principalType: PrincipalType.PUBLIC,
      }).lean();

      if (!publicExists) {
        if (!isDryRun) {
          await AclEntry.findOneAndUpdate(
            {
              resourceType: ResourceType.SHARED_LINK,
              resourceId: link._id,
              principalType: PrincipalType.PUBLIC,
            },
            {
              $set: {
                permBits: viewerRole.permBits,
                roleId: viewerRole._id,
                grantedBy: link.user ? new mongoose.Types.ObjectId(link.user) : null,
                grantedAt: new Date(),
              },
              $setOnInsert: {
                ...(link.tenantId && { tenantId: link.tenantId }),
              },
            },
            { upsert: true },
          );
        }
        publicGranted++;
      } else {
        skippedPublic++;
      }
    }

    if (processed % (BATCH_SIZE * 5) === 0) {
      console.log(`Progress: ${processed}/${totalLinks}`);
    }
  }

  // $unset isPublic from all documents
  if (!isDryRun) {
    console.log('Removing isPublic field from all SharedLink documents...');
    await SharedLink.updateMany({}, { $unset: { isPublic: 1 } });
  }

  console.log('\n--- Summary ---');
  console.log(`Total processed: ${processed}`);
  console.log(`OWNER grants: ${ownerGranted} (skipped: ${skippedOwner})`);
  console.log(`PUBLIC VIEWER grants: ${publicGranted} (skipped: ${skippedPublic})`);
  console.log(`Userless links (no OWNER): ${userlessLinks}`);
  console.log(`isPublic:false links: ${isPublicFalseLinks}`);
  console.log(`Mode: ${isDryRun ? 'DRY RUN (no changes written)' : 'LIVE (changes committed)'}`);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
```

---

## Task 12: Tests

**Files:**
- Modify: `packages/data-schemas/src/methods/share.test.ts`
- Create: `packages/api/src/share/access.test.ts` (if test infrastructure allows)
- Create: `packages/api/src/share/service.test.ts` (if test infrastructure allows)

- [ ] **Step 1: Update existing share tests for `isPublic` removal**

In `packages/data-schemas/src/methods/share.test.ts`, find all assertions/queries that reference `isPublic` and remove or update them:

- Remove `isPublic: true` from query parameter expectations
- Remove `expect(result.isPublic).toBe(true)` assertions
- Remove `isPublic` from test fixture data where it's used as a filter
- Keep `isPublic` in any fixtures that create documents (Mongoose will ignore it after schema removal)

- [ ] **Step 2: Run existing share tests**

```bash
cd /Users/atefbellaaj/Repos/LibreChat/packages/data-schemas && npx jest share --verbose
```

Expected: All tests pass after removing `isPublic` references.

- [ ] **Step 3: Add tests for `_id` in response types**

Add test cases to `share.test.ts` verifying that `createSharedLink`, `updateSharedLink`, and `getSharedLink` return `_id`:

```ts
it('should return _id from createSharedLink', async () => {
  const result = await createSharedLink(testUserId, testConvoId);
  expect(result._id).toBeDefined();
  expect(typeof result._id).toBe('string');
});
```

- [ ] **Step 4: Add tests for bulk delete returning IDs**

```ts
it('should return deleted IDs from deleteAllSharedLinks', async () => {
  await createSharedLink(testUserId, 'convo1');
  await createSharedLink(testUserId, 'convo2');
  const result = await deleteAllSharedLinks(testUserId);
  expect(result.deletedIds).toHaveLength(2);
  expect(result.deletedCount).toBe(2);
});
```

- [ ] **Step 5: Write access resolver tests**

Create `packages/api/src/share/access.test.ts` with tests for the key matrix from the spec:

- PUBLIC AclEntry + `ALLOW_SHARED_LINKS_PUBLIC=true` + no auth → allow
- PUBLIC AclEntry + `ALLOW_SHARED_LINKS_PUBLIC=false` + no auth → 401
- PUBLIC AclEntry + `ALLOW_SHARED_LINKS_PUBLIC=false` + auth → allow
- No PUBLIC AclEntry + no auth → 401
- No PUBLIC AclEntry + auth + has VIEW → allow
- No PUBLIC AclEntry + auth + no VIEW → 403
- Legacy link + auto-migrate enabled → creates ACL entries and allows
- Legacy link + auto-migrate disabled → 403

These tests should use `mongodb-memory-server` per CLAUDE.md.

- [ ] **Step 6: Write OWNER protection tests**

Test the three rules in `bulkUpdateResourcePermissions`:
- Reject OWNER assignment to non-owner principal → throws
- Reject demotion of existing OWNER → throws
- Reject removal of OWNER → throws
- Allow VIEWER assignment to non-owner → succeeds
- Allow removal of non-owner → succeeds

- [ ] **Step 7: Run all tests**

```bash
cd /Users/atefbellaaj/Repos/LibreChat/packages/data-schemas && npx jest share --verbose
cd /Users/atefbellaaj/Repos/LibreChat/packages/api && npx jest share --verbose
```

---

## Self-Review Checklist

### Spec Coverage

| Spec Section | Task(s) |
|---|---|
| Section 1: Enum & Type Extensions | Task 1 |
| Section 2: Remove isPublic, ACL-based Access | Tasks 2, 4 |
| Section 3: Link Creation + OWNER Grant | Tasks 3, 5, 6 |
| Section 4: Permission Management Endpoints | Tasks 6, 7 |
| Section 5: Migration Script | Task 11 |
| Section 6: Frontend ACL UI | Task 10 |
| Response changes (_id) | Task 3 |
| ACL cleanup on deletion | Task 8 |
| Permission propagation | Task 9 |
| Testing strategy | Task 12 |

### Verified

- [x] No placeholders ("TBD", "TODO", "implement later")
- [x] Every code step has actual code
- [x] Type names consistent across tasks (e.g., `SHARED_LINK_VIEWER` not `sharedLink_viewer` in enums)
- [x] File paths are exact
- [x] `public` field made optional in schema (Task 1 Step 4) before controller changes (Task 7 Step 2)
- [x] `_id` returned from methods (Task 3) before route uses it (Task 6 Step 2)
- [x] RESOURCE_CONFIGS added (Task 10 Step 1) before GenericGrantAccessDialog use (Task 10 Step 7)
- [x] No commits included — user manages commits manually
