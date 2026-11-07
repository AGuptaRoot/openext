'use strict';

const { Schema } = require('mongoose');

const ContractProductItemSchema = new Schema(
  {
    productId: { type: String, trim: true, default: '' },
    sku: { type: String, trim: true, default: '' },
    productName: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    unitPrice: { type: Number, required: true, default: 0, min: 0 },
    quantity: { type: Number, required: true, default: 1, min: 1 },
    totalValue: { type: Number, required: true, default: 0, min: 0 }
  },
  { _id: true }
);

/**
 * Contract & Agreement Model
 */
const ContractSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    contractNumber: { type: String, required: true, trim: true, uppercase: true },
    leadId: { type: String, trim: true, default: null, index: true },
    clientId: { type: String, trim: true, default: null, index: true },
    clientName: { type: String, required: true, trim: true, maxlength: 200 },
    contactPerson: { type: String, trim: true, default: '', maxlength: 120 },
    contactEmail: { type: String, trim: true, default: '', maxlength: 120 },
    contactPhone: { type: String, trim: true, default: '', maxlength: 20 },
    subject: { type: String, required: true, trim: true, maxlength: 250 },
    contractType: {
      type: String,
      trim: true,
      default: 'Master Services Agreement',
      maxlength: 120
    },
    value: { type: Number, required: true, default: 0, min: 0 },
    currency: { type: String, trim: true, default: 'USD', uppercase: true, maxlength: 10 },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    renewalDate: { type: Date, default: null },
    status: {
      type: String,
      enum: ['Draft', 'Sent', 'Under Review', 'Accepted', 'Declined', 'Active', 'Expired'],
      default: 'Draft'
    },
    terms: { type: String, trim: true, default: '', maxlength: 10000 },
    products: { type: [ContractProductItemSchema], default: [] },
    notes: { type: String, trim: true, default: '', maxlength: 3000 },
    
    // E-signature fields
    signerName: { type: String, trim: true, default: '', maxlength: 120 },
    signerEmail: { type: String, trim: true, default: '', maxlength: 120 },
    signedAt: { type: Date, default: null },
    signerIp: { type: String, trim: true, default: '', maxlength: 60 },
    signatureData: { type: String, default: null }, // Base64 or hash of signature

    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_contracts',
    timestamps: true
  }
);

ContractSchema.index({ tenantId: 1, contractNumber: 1 }, { name: 'contracts_tenant_number' });
ContractSchema.index({ tenantId: 1, leadId: 1 }, { name: 'contracts_tenant_lead' });
ContractSchema.index({ tenantId: 1, clientId: 1 }, { name: 'contracts_tenant_client' });
ContractSchema.index({ tenantId: 1, status: 1 }, { name: 'contracts_tenant_status' });

module.exports = {
  name: 'Contract',
  schema: ContractSchema
};
