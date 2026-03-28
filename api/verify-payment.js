// api/verify-payment.js — Verifies Razorpay signature, updates Supabase tier
const crypto = require('crypto');

// Server-side tier→price truth (prevents paying ₹1 and claiming Platinum)
const TIER_PRICES = {
  gold: 249900,
  platinum: 699900,
  dwcpurple: 1499900
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.dinewithcelebrity.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    razorpay_payment_id,
    razorpay_order_id,
    razorpay_signature,
    tier
  } = req.body || {};

  // Validate inputs
  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature || !tier) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!TIER_PRICES[tier]) {
    return res.status(400).json({ error: 'Invalid tier' });
  }

  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  const supabase_url = process.env.SUPABASE_URL;
  const supabase_service_key = process.env.SUPABASE_SERVICE_KEY; // service role key (not anon)

  if (!key_secret || !supabase_url || !supabase_service_key) {
    return res.status(500).json({ error: 'Server config missing' });
  }

  // ✅ STEP 1: Verify Razorpay signature
  const generated_signature = crypto
    .createHmac('sha256', key_secret)
    .update(razorpay_order_id + '|' + razorpay_payment_id)
    .digest('hex');

  if (generated_signature !== razorpay_signature) {
    console.error('Signature mismatch — possible fraud attempt');
    return res.status(400).json({ error: 'Payment verification failed' });
  }

  // ✅ STEP 2: Get user from Authorization header (JWT from Supabase session)
  // Frontend must send: Authorization: Bearer <supabase_access_token>
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized — no token' });
  }

  // Verify token and get user from Supabase
  let user_id;
  try {
    const userRes = await fetch(`${supabase_url}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': supabase_service_key
      }
    });
    const userData = await userRes.json();
    if (!userData.id) {
      return res.status(401).json({ error: 'Invalid session token' });
    }
    user_id = userData.id;
  } catch (err) {
    console.error('Auth verification error:', err);
    return res.status(401).json({ error: 'Could not verify user' });
  }

  // ✅ STEP 3: Update tier in Supabase using service role key
  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);

  try {
    const updateRes = await fetch(
      `${supabase_url}/rest/v1/members?id=eq.${user_id}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabase_service_key,
          'Authorization': `Bearer ${supabase_service_key}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          tier,
          expires_at: expiry.toISOString(),
          upgraded_at: new Date().toISOString(),
          payment_id: razorpay_payment_id,
          payment_order_id: razorpay_order_id
        })
      }
    );

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error('Supabase update failed:', errText);
      return res.status(500).json({ error: 'Tier update failed. Contact support with payment ID: ' + razorpay_payment_id });
    }

    // ✅ All done
    return res.status(200).json({ success: true, tier });

  } catch (err) {
    console.error('Supabase update error:', err);
    return res.status(500).json({ error: 'Internal error. Contact support with payment ID: ' + razorpay_payment_id });
  }
};
