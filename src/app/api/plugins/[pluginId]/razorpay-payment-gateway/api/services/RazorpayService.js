const SettingsService = require('./SettingsService');

module.exports = {
  async createOrder(cms, {
    amount,
    currency,
    receipt,
    notes = {},
    partialPayment = false,
  }) {
    const creds = await SettingsService.getCredentials(cms);
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      throw new Error('amount must be a positive number (in paise for INR)');
    }

    const orderCurrency = String(currency || creds.currency || 'INR')
      .trim()
      .toUpperCase();

    const body = {
      amount: Math.round(parsedAmount),
      currency: orderCurrency,
      receipt: receipt ? String(receipt).slice(0, 40) : `rcpt_${Date.now()}`,
      notes: notes && typeof notes === 'object' ? notes : {},
      partial_payment: Boolean(partialPayment),
    };

    const order = await SettingsService.razorpayRequest(
      creds.keyId,
      creds.keySecret,
      '/orders',
      { method: 'POST', body }
    );

    return {
      order,
      keyId: creds.keyId,
      currency: orderCurrency,
      businessName: creds.businessName,
    };
  },

  async verifyPayment(cms, {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  }) {
    const creds = await SettingsService.getCredentials(cms);
    const orderId = String(razorpay_order_id || '').trim();
    const paymentId = String(razorpay_payment_id || '').trim();
    const signature = String(razorpay_signature || '').trim();

    if (!orderId || !paymentId || !signature) {
      throw new Error(
        'razorpay_order_id, razorpay_payment_id, and razorpay_signature are required'
      );
    }

    const crypto = require('crypto');
    const payload = `${orderId}|${paymentId}`;
    const expected = crypto
      .createHmac('sha256', creds.keySecret)
      .update(payload)
      .digest('hex');

    const valid = expected === signature;

    return {
      valid,
      orderId,
      paymentId,
      message: valid ? 'Payment verified successfully.' : 'Invalid payment signature.',
    };
  },

  async fetchPayment(cms, paymentId) {
    const creds = await SettingsService.getCredentials(cms);
    const id = String(paymentId || '').trim();
    if (!id) throw new Error('paymentId is required');
    return SettingsService.razorpayRequest(creds.keyId, creds.keySecret, `/payments/${id}`);
  },
};
