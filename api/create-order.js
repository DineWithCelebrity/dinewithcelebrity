// api/create-order.js — Creates a Razorpay order server-side
const https = require('https');

// Tier → amount in paise (server-side truth, never trust frontend)
const TIER_PRICES = {
  gold: 249900,       // ₹2,499
  platinum: 699900,   // ₹6,999
  dwcpurple: 1499900  // ₹14,999
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.dinewithcelebrity.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { tier } = req.body || {};

  if (!tier || !TIER_PRICES[tier]) {
    return res.status(400).json({ error: 'Invalid tier' });
  }

  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (!key_id || !key_secret) {
    return res.status(500).json({ error: 'Payment config missing' });
  }

  const amount = TIER_PRICES[tier];
  const orderData = JSON.stringify({
    amount,
    currency: 'INR',
    receipt: `dwc_${tier}_${Date.now()}`,
    notes: { tier }
  });

  const auth = Buffer.from(`${key_id}:${key_secret}`).toString('base64');

  try {
    const order = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.razorpay.com',
        path: '/v1/orders',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${auth}`,
          'Content-Length': Buffer.byteLength(orderData)
        }
      };
      const request = https.request(options, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Bad Razorpay response')); }
        });
      });
      request.on('error', reject);
      request.write(orderData);
      request.end();
    });

    if (order.error) return res.status(400).json({ error: order.error.description });

    return res.status(200).json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      tier
    });
  } catch (err) {
    console.error('create-order error:', err);
    return res.status(500).json({ error: 'Failed to create order' });
  }
};
