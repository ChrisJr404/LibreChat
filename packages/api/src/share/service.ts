import mongoose from 'mongoose';
import { logger } from '@librechat/data-schemas';
import { PrincipalType, ResourceType, AccessRoleIds } from 'librechat-data-provider';
import type { Model, Types, DeleteResult } from 'mongoose';
import type { IAclEntry } from '@librechat/data-schemas';
import { AccessControlService } from '~/acl/accessControlService';

let _aclService: AccessControlService | null = null;
function getAclService(): AccessControlService {
  if (!_aclService) {
    _aclService = new AccessControlService(mongoose);
  }
  return _aclService;
}

export async function grantCreationPermissions(
  sharedLinkId: string | Types.ObjectId,
  userId: string,
  grantPublic: boolean = true,
): Promise<void> {
  const resourceId = sharedLinkId.toString();

  try {
    await getAclService().grantPermission({
      principalType: PrincipalType.USER,
      principalId: userId,
      resourceType: ResourceType.SHARED_LINK,
      resourceId,
      accessRoleId: AccessRoleIds.SHARED_LINK_OWNER,
      grantedBy: userId,
    });
  } catch (err) {
    logger.error('[grantCreationPermissions] OWNER grant failed, deleting SharedLink', {
      resourceId,
      error: err instanceof Error ? err.message : String(err),
    });
    await mongoose.models.SharedLink.deleteOne({ _id: sharedLinkId });
    throw err;
  }

  if (grantPublic) {
    try {
      await getAclService().grantPermission({
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.SHARED_LINK,
        resourceId,
        accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
        grantedBy: userId,
      });
    } catch (err) {
      logger.error('[grantCreationPermissions] PUBLIC VIEWER grant failed, cleaning up', {
        resourceId,
        error: err instanceof Error ? err.message : String(err),
      });
      await Promise.all([
        mongoose.models.SharedLink.deleteOne({ _id: sharedLinkId }),
        getAclService().removeAllPermissions({
          resourceType: ResourceType.SHARED_LINK,
          resourceId,
        }),
      ]);
      throw err;
    }
  }
}

export async function cleanupSharedLinkPermissions(
  resourceId: string | Types.ObjectId,
): Promise<DeleteResult> {
  return getAclService().removeAllPermissions({
    resourceType: ResourceType.SHARED_LINK,
    resourceId,
  });
}

export async function cleanupBulkSharedLinkPermissions(
  resourceIds: (string | Types.ObjectId)[],
): Promise<DeleteResult> {
  const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
  return AclEntry.deleteMany({
    resourceType: ResourceType.SHARED_LINK,
    resourceId: { $in: resourceIds },
  });
}
