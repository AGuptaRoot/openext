const { Schema } = require('mongoose');
const EmailConfigSchema = new Schema({
    host: { type: String, default: '', trim: true },
    port: { type: Number, default: 587 },
    secure: { type: Boolean, default: false },
    user: { type: String, default: '', trim: true },
    password: { type: String, default: '', trim: true },
    fromName: { type: String, default: '', trim: true },
    fromEmail: { type: String, default: '', trim: true },
    recipientEmail: { type: String, default: '', trim: true },
    replyTo: { type: String, default: '', trim: true },
}, { timestamps: true });
module.exports = {
    name: 'EmailConfig',
    schema: EmailConfigSchema,
};
