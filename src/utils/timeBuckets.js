'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * Timestamp coarsening.
 *
 * An exact submission time is an identifier in disguise: "the report arrived
 * at 14:32:07" can be matched against badge swipes, VPN logs or who left a
 * meeting early. Rounding every reporter-originated timestamp down to a bucket
 * (15 minutes by default) means a report can only be placed in a window that
 * many people share.
 */

/** Rounds `date` down to the start of its `bucketMinutes` window. 0 = exact. */
function coarsenDate(date, bucketMinutes) {
  const time = new Date(date).getTime();
  if (!bucketMinutes) return new Date(time);

  const bucketMs = bucketMinutes * 60 * 1000;
  return new Date(Math.floor(time / bucketMs) * bucketMs);
}

/**
 * A MongoDB ObjectId whose embedded timestamp is the coarsened time.
 *
 * A default ObjectId stores its creation time to the second in its first four
 * bytes, so coarsening `createdAt` alone would leave the exact time readable
 * from the report's `_id`. Here the timestamp is the bucket start and the
 * remaining eight bytes are random (64 bits — collisions are not a practical
 * concern, and the unique `_id` index would reject one anyway).
 */
function coarseObjectId(coarseDate) {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt32BE(Math.floor(new Date(coarseDate).getTime() / 1000), 0);
  crypto.randomBytes(8).copy(bytes, 4);
  return new mongoose.Types.ObjectId(bytes);
}

module.exports = { coarsenDate, coarseObjectId };
