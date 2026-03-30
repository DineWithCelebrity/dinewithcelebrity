// ============================================================
// /api/verify-payment.js — DWC Razorpay Payment Verification
// Security: HMAC-SHA256 signature check, idempotency, audit log
// Tier update by user.id (never by email)
// ============================================================

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const TIER_PRICES = {
  gold:      249900,
  platinum:  699900,
  dwcpurple: 1499900,
};

const TIER_EXPIRY_DAYS = 365;

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.dinewithcelebrity.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req, res) {
  setCORS(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  const token = authHeader.replace('Bearer ', '').trim();

  const sbAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: { user }, error: authError } = await sbAdmin.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid session. Please log in again.' });
  }

  const { razorpay_payment_id, razorpay_order_id, razorpay_signature, tier } = req.body || {};

  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature || !tier) {
    return res.status(400).json({ error: 'Missing payment details.' });
  }
  if (!TIER_PRICES[tier]) {
    return res.status(400).json({ error: 'Invalid tier.' });
  }

  // ── HMAC-SHA256 signature verification ──
  const body        = razorpay_order_id + '|' + razorpay_payment_id;
  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  if (expectedSig !== razorpay_signature) {
    console.warn('[verify-payment] Signature mismatch for user:', user.id);
    return res.status(400).json({ error: 'Payment signature verification failed. Contact support.' });
  }

  // ── Idempotency check ──
  const { data: existingLog } = await sbAdmin
    .from('payment_logs')
    .select('id, status')
    .eq('payment_id', razorpay_payment_id)
    .single();

  if (existingLog) {
    return res.status(200).json({ success: true, message: 'Payment already processed.', tier, already_processed: true });
  }

  // ── Calculate expiry ──
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + TIER_EXPIRY_DAYS);

  // ── Update member tier by user.id ──
  const { error: updateError } = await sbAdmin
    .from('members')
    .update({
      tier,
      upgraded_at:      new Date().toISOString(),
      expires_at:       expiresAt.toISOString(),
      payment_id:       razorpay_payment_id,
      payment_order_id: razorpay_order_id,
    })
    .eq('id', user.id);

  if (updateError) {
    console.error('[verify-payment] Tier update error:', updateError);
    return res.status(500).json({
      error: 'Payment verified but tier update failed. Contact support with Payment ID: ' + razorpay_payment_id,
    });
  }

  // ── Audit log ──
  await sbAdmin.from('payment_logs').insert({
    member_id:  user.id,
    payment_id: razorpay_payment_id,
    order_id:   razorpay_order_id,
    tier,
    amount:     TIER_PRICES[tier],
    status:     'success',
    created_at: new Date().toISOString(),
  });

  // ── Activity tracking ──
  const { data: memberData } = await sbAdmin
    .from('members')
    .select('member_id, city')
    .eq('id', user.id)
    .single();

  if (memberData?.member_id) {
    await sbAdmin.from('member_activity').insert({
      member_id:     memberData.member_id,
      member_uuid:   user.id,
      activity_type: 'upgrade',
      activity_data: { tier, amount: TIER_PRICES[tier] / 100, payment_id: razorpay_payment_id, order_id: razorpay_order_id },
      city: memberData.city || null,
    });
  }

  console.log(`[verify-payment] ✅ Tier upgraded: user=${user.id} tier=${tier} payment=${razorpay_payment_id}`);

  return res.status(200).json({ success: true, tier, expires_at: expiresAt.toISOString(), payment_id: razorpay_payment_id });
}
