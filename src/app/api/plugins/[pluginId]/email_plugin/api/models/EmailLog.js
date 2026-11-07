const { Schema } = require('mongoose');
const EmailLogSchema = new Schema({
    to: { type: String, required: true, trim: true },
    subject: { type: String, default: '', trim: true },
    status: { type: String, enum: ['sent', 'failed'], required: true },
    error: { type: String, default: '' },
    bodyPreview: { type: String, default: '' },
    sentBy: { type: String, default: '' },
}, { timestamps: true });
EmailLogSchema.index({ createdAt: -1 });
module.exports = {
    name: 'EmailLog',
    schema: EmailLogSchema,
};
