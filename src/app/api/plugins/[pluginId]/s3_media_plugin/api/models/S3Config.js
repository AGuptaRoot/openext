const { Schema } = require('mongoose');

const S3ConfigSchema = new Schema(
  {
    bucket: { type: String, default: '', trim: true },
    /** S3 Access Point ARN, e.g. arn:aws:s3:us-east-1:123456789012:accesspoint/my-ap */
    accessPointArn: { type: String, default: '', trim: true },
    /** Optional custom endpoint (Access Point alias hostname or VPC endpoint). */
    endpoint: { type: String, default: '', trim: true },
    region: { type: String, default: 'us-east-1', trim: true },
    prefix: { type: String, default: 'nextcms-media', trim: true },
    accessKeyId: { type: String, default: '', trim: true },
    secretAccessKey: { type: String, default: '', trim: true },
    publicUrlBase: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

module.exports = {
  name: 'S3Config',
  schema: S3ConfigSchema,
};
