const { Schema } = require('mongoose');

const RazorpayConfigSchema = new Schema(
  {
    /** Razorpay Key ID — public at checkout; masked in admin API responses */
    keyId: { type: String, default: '', trim: true },
    /**
     * Encrypted Key Secret (AES-256-GCM). Never selected by default.
     * Legacy installs may hold plaintext until migrated on next save/boot.
     */
    keySecret: { type: String, default: '', select: false },
    /** True when a secret is stored (readable without loading keySecret). */
    secretStored: { type: Boolean, default: false },
    /** Whether keySecret uses enc:v1: prefix */
    secretEncrypted: { type: Boolean, default: false },
    businessName: { type: String, default: '', trim: true },
    defaultCurrency: { type: String, default: 'INR', trim: true },
    mode: { type: String, default: 'test', trim: true },
    credentialsUpdatedAt: { type: Date },
    credentialsUpdatedBy: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

module.exports = {
  name: 'RazorpayConfig',
  schema: RazorpayConfigSchema,
};
