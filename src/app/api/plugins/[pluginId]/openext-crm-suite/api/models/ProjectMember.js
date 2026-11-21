'use strict';

const { Schema } = require('mongoose');

const ProjectMemberSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    projectId: { type: String, required: true, trim: true, index: true },
    userId: { type: String, required: true, trim: true },
    role: { type: String, trim: true, default: 'member' },
    hourlyRate: { type: Number, default: 0, min: 0 },
    /** CRM 3.63.0: the member's shift on this project — start "HH:mm", length in hours, week days (0 = Sunday). */
    shiftStart: { type: String, trim: true, default: '' },
    shiftHours: { type: Number, default: 0, min: 0, max: 16 },
    shiftDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_project_members',
    timestamps: true
  }
);

ProjectMemberSchema.index(
  { tenantId: 1, projectId: 1, userId: 1 },
  { unique: true, name: 'project_members_unique' }
);

module.exports = {
  name: 'ProjectMember',
  schema: ProjectMemberSchema
};
