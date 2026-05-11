const path = require('path');
const { logger } = require('@librechat/data-schemas');
const { ensureRequiredCollectionsExist } = require('@librechat/api');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');

const { findRoleByIdentifier } = require('~/models');
const { SharedLink, AclEntry } = require('~/db/models');

/**
 * String literals matching `librechat-data-provider` enums so this script
 * runs standalone without requiring a built data-provider package.
 */
const RESOURCE_TYPE_SHARED_LINK = 'sharedLink';
const ROLE_ID_OWNER = 'sharedLink_owner';
const ROLE_ID_VIEWER = 'sharedLink_viewer';
const PRINCIPAL_USER = 'user';
const PRINCIPAL_PUBLIC = 'public';

async function migrateSharedLinkPermissions({
  dryRun = true,
  batchSize = 100,
  force = false,
} = {}) {
  await connect();

  logger.info('Starting SharedLink Permissions Migration', { dryRun, batchSize, force });

  const mongoose = require('mongoose');
  /** @type {import('mongoose').mongo.Db | undefined} */
  const db = mongoose.connection.db;
  if (db) {
    await ensureRequiredCollectionsExist(db);
  }

  const ownerRole = await findRoleByIdentifier(ROLE_ID_OWNER);
  const viewerRole = await findRoleByIdentifier(ROLE_ID_VIEWER);

  if (!ownerRole || !viewerRole) {
    throw new Error(
      'Required sharedLink roles not found (sharedLink_owner, sharedLink_viewer). Run role seeding first.',
    );
  }

  logger.info('Roles resolved', {
    owner: { id: ownerRole._id, permBits: ownerRole.permBits },
    viewer: { id: viewerRole._id, permBits: viewerRole.permBits },
  });

  // --- Safety check: abort if isPublic: false documents exist (unless --force) ---
  const isPublicFalseCount = await SharedLink.countDocuments({ isPublic: false });
  if (isPublicFalseCount > 0 && !force) {
    const sample = await SharedLink.find({ isPublic: false })
      .select('_id shareId user')
      .limit(20)
      .lean();

    const sampleIds = sample.map((doc) => doc._id.toString());
    logger.error(
      `Found ${isPublicFalseCount} SharedLink documents with isPublic: false. ` +
        'These may have been intentionally marked non-public. ' +
        'Use --force to proceed anyway (they will NOT receive a PUBLIC VIEWER grant).',
      { sampleIds },
    );
    return {
      aborted: true,
      reason: 'isPublic: false documents found',
      isPublicFalseCount,
      sampleIds,
    };
  }

  // --- Count totals for progress reporting ---
  const totalLinks = await SharedLink.countDocuments({});
  logger.info(`Found ${totalLinks} SharedLink documents total`);

  if (totalLinks === 0) {
    logger.info('No SharedLink documents to migrate');
    return { migrated: 0, errors: 0, skipped: 0, dryRun };
  }

  // --- Dry run: scan and categorize ---
  if (dryRun) {
    const withUser = await SharedLink.countDocuments({ user: { $exists: true, $ne: null } });
    const withoutUser = await SharedLink.countDocuments({
      $or: [{ user: { $exists: false } }, { user: null }],
    });
    const withIsPublicTrue = await SharedLink.countDocuments({ isPublic: true });
    const withIsPublicFalse = isPublicFalseCount;
    const withIsPublicField = await SharedLink.countDocuments({ isPublic: { $exists: true } });

    const alreadyMigratedOwner = await AclEntry.countDocuments({
      resourceType: RESOURCE_TYPE_SHARED_LINK,
      principalType: PRINCIPAL_USER,
    });
    const alreadyMigratedPublic = await AclEntry.countDocuments({
      resourceType: RESOURCE_TYPE_SHARED_LINK,
      principalType: PRINCIPAL_PUBLIC,
    });

    return {
      migrated: 0,
      errors: 0,
      dryRun: true,
      summary: {
        totalLinks,
        withUser,
        withoutUser,
        withIsPublicTrue,
        withIsPublicFalse,
        withIsPublicField,
        alreadyMigratedOwner,
        alreadyMigratedPublic,
      },
    };
  }

  // --- Live migration: cursor-based batch processing ---
  const results = {
    migrated: 0,
    errors: 0,
    skipped: 0,
    ownerGrants: 0,
    ownerSkipped: 0,
    publicViewerGrants: 0,
    publicViewerSkipped: 0,
    missingUserWarnings: 0,
  };

  const cursor = SharedLink.find({}).select('_id user isPublic tenantId').lean().cursor();

  let batch = [];
  let batchIndex = 0;

  /**
   * Process a single batch of SharedLink documents.
   * Uses findOneAndUpdate with upsert for idempotent re-runs.
   */
  async function processBatch(links) {
    for (const link of links) {
      try {
        const linkId = link._id;
        const userId = link.user;
        const tenantId = link.tenantId;

        // --- OWNER grant ---
        if (userId) {
          const existingOwner = await AclEntry.findOne({
            resourceType: RESOURCE_TYPE_SHARED_LINK,
            resourceId: linkId,
            principalType: PRINCIPAL_USER,
            principalId: new mongoose.Types.ObjectId(userId),
          })
            .select('_id')
            .lean();

          if (!existingOwner) {
            await AclEntry.findOneAndUpdate(
              {
                resourceType: RESOURCE_TYPE_SHARED_LINK,
                resourceId: linkId,
                principalType: PRINCIPAL_USER,
                principalId: new mongoose.Types.ObjectId(userId),
              },
              {
                $set: {
                  permBits: ownerRole.permBits,
                  roleId: ownerRole._id,
                  grantedBy: new mongoose.Types.ObjectId(userId),
                  grantedAt: new Date(),
                },
                $setOnInsert: {
                  principalModel: 'User',
                  ...(tenantId && { tenantId }),
                },
              },
              { upsert: true },
            );
            results.ownerGrants++;
          } else {
            results.ownerSkipped++;
          }
        } else {
          results.missingUserWarnings++;
          logger.warn('SharedLink has no user field, skipping OWNER grant', {
            linkId: linkId.toString(),
          });
        }

        // --- PUBLIC VIEWER grant ---
        const hasIsPublic = link.isPublic !== undefined;
        if (hasIsPublic) {
          if (link.isPublic === false && !force) {
            results.publicViewerSkipped++;
          } else {
            const existingPublic = await AclEntry.findOne({
              resourceType: RESOURCE_TYPE_SHARED_LINK,
              resourceId: linkId,
              principalType: PRINCIPAL_PUBLIC,
            })
              .select('_id')
              .lean();

            if (!existingPublic) {
              await AclEntry.findOneAndUpdate(
                {
                  resourceType: RESOURCE_TYPE_SHARED_LINK,
                  resourceId: linkId,
                  principalType: PRINCIPAL_PUBLIC,
                },
                {
                  $set: {
                    permBits: viewerRole.permBits,
                    roleId: viewerRole._id,
                    grantedBy: userId ? new mongoose.Types.ObjectId(userId) : undefined,
                    grantedAt: new Date(),
                  },
                  $setOnInsert: {
                    ...(tenantId && { tenantId }),
                  },
                },
                { upsert: true },
              );
              results.publicViewerGrants++;
            } else {
              results.publicViewerSkipped++;
            }
          }
        }

        results.migrated++;
      } catch (error) {
        results.errors++;
        logger.error('Failed to migrate SharedLink', {
          linkId: link._id.toString(),
          user: link.user,
          error: error.message,
        });
      }
    }
  }

  for await (const doc of cursor) {
    batch.push(doc);

    if (batch.length >= batchSize) {
      batchIndex++;
      const totalBatches = Math.ceil(totalLinks / batchSize);

      if (batchIndex % 5 === 0 || batchIndex === 1) {
        logger.info(`Processing batch ${batchIndex}/${totalBatches}`, {
          migrated: results.migrated,
          errors: results.errors,
        });
      }

      await processBatch(batch);
      batch = [];
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // Process remaining documents
  if (batch.length > 0) {
    batchIndex++;
    const totalBatches = Math.ceil(totalLinks / batchSize);
    logger.info(`Processing final batch ${batchIndex}/${totalBatches}`, {
      remaining: batch.length,
    });
    await processBatch(batch);
  }

  // --- $unset isPublic from all SharedLink documents ---
  logger.info('Removing isPublic field from all SharedLink documents...');
  const unsetResult = await SharedLink.updateMany(
    { isPublic: { $exists: true } },
    { $unset: { isPublic: 1 } },
  );
  logger.info(`Removed isPublic field from ${unsetResult.modifiedCount} documents`);

  results.isPublicFieldsRemoved = unsetResult.modifiedCount;

  logger.info('SharedLink migration completed', results);
  return results;
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const batchSize =
    parseInt(process.argv.find((arg) => arg.startsWith('--batch-size='))?.split('=')[1]) || 100;

  migrateSharedLinkPermissions({ dryRun, batchSize, force })
    .then((result) => {
      if (result.aborted) {
        console.log('\n=== MIGRATION ABORTED ===');
        console.log(`Reason: ${result.reason}`);
        console.log(`Documents with isPublic: false: ${result.isPublicFalseCount}`);
        console.log(`Sample IDs: ${result.sampleIds.join(', ')}`);
        console.log('\nUse --force to proceed anyway');
        process.exit(1);
      }

      if (dryRun) {
        console.log('\n=== DRY RUN RESULTS ===');
        console.log(`Total SharedLink documents: ${result.summary.totalLinks}`);
        console.log(`- With user field: ${result.summary.withUser}`);
        console.log(`- Without user field: ${result.summary.withoutUser}`);
        console.log(`- With isPublic: true: ${result.summary.withIsPublicTrue}`);
        console.log(`- With isPublic: false: ${result.summary.withIsPublicFalse}`);
        console.log(`- With isPublic field present: ${result.summary.withIsPublicField}`);
        console.log(
          `\nAlready migrated (OWNER AclEntries): ${result.summary.alreadyMigratedOwner}`,
        );
        console.log(
          `Already migrated (PUBLIC AclEntries): ${result.summary.alreadyMigratedPublic}`,
        );
        console.log('\nTo run the actual migration, remove the --dry-run flag');
      } else {
        console.log('\n=== MIGRATION RESULTS ===');
        console.log(JSON.stringify(result, null, 2));
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error('SharedLink migration failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateSharedLinkPermissions };
