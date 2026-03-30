// ============================================================
// /api/verify-payment.js — DWC Payment Verification
// Expiry preserved on upgrade (not reset to today+365)
// ============================================================

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const TIER_PRICES = { gold: 249900, platinum: 699900, dwcpurple: 1499900 };
const TIER_RANK   = { free: 0, gold: 1, platinum: 2, dwcpurple: 3 };

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  'https://www.dinewithcelebrity.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized.' });

  const sbAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authError } = await sbAdmin.auth.getUser(
    authHeader.replace('Bearer ', '').trim()
  );
  if (authError || !user) return res.status(401).json({ error: 'Invalid session.' });

  const { razorpay_payment_id, razorpay_order_id, razorpay_signature, tier } = req.body || {};
  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature || !tier) {
    return res.status(400).json({ error: 'Missing payment details.' });
  }
  if (!TIER_PRICES[tier]) return res.status(400).json({ error: 'Invalid tier.' });

  // ── HMAC-SHA256 signature verification ──
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expected !== razorpay_signature) {
    return res.status(400).json({ error: 'Signature verification failed.' });
  }

  // ── Idempotency check ──
  const { data: existing } = await sbAdmin
    .from('payment_logs').select('id').eq('payment_id', razorpay_payment_id).single();
  if (existing) {
    return res.status(200).json({ success: true, already_processed: true, tier });
  }

  // ── Get current member data ──
  const { data: member } = await sbAdmin
    .from('members').select('tier, expires_at, member_id, city').eq('id', user.id).single();

  const currentTier  = (member?.tier || 'free').toLowerCase();
  const currentRank  = TIER_RANK[currentTier] || 0;
  const newRank      = TIER_RANK[tier] || 0;

  // ── Calculate new expiry ──
  // Rule: If upgrading from paid tier with future expiry → KEEP original expiry
  //       If from free or expired → set new 1 year from today
  let newExpiry;
  const now          = new Date();
  const currentExpiry = member?.expires_at ? new Date(member.expires_at) : null;

  if (currentRank > 0 && currentExpiry && currentExpiry > now) {
    // Paid upgrade — preserve original expiry (no extension)
    newExpiry = currentExpiry.toISOString();
  } else {
    // Free or expired — fresh 1 year from today
    const expiry = new Date();
    expiry.setFullYear(expiry.getFullYear() + 1);
    newExpiry = expiry.toISOString();
  }

  // ── Update member tier ──
  const { error: updateError } = await sbAdmin
    .from('members')
    .update({
      tier,
      upgraded_at:      now.toISOString(),
      expires_at:       newExpiry,
      payment_id:       razorpay_payment_id,
      payment_order_id: razorpay_order_id,
    })
    .eq('id', user.id);

  if (updateError) {
    return res.status(500).json({
      error: `Payment verified but tier update failed. Contact support. Payment ID: ${razorpay_payment_id}`,
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
    source:     'frontend',
    created_at: now.toISOString(),
  });

  // ── Activity log ──
  if (member?.member_id) {
    await sbAdmin.from('member_activity').insert({
      member_id:     member.member_id,
      member_uuid:   user.id,
      activity_type: 'upgrade',
      activity_data: {
        from_tier:   currentTier,
        to_tier:     tier,
        amount:      TIER_PRICES[tier] / 100,
        payment_id:  razorpay_payment_id,
        expiry:      newExpiry,
        is_pro_rata: currentRank > 0,
      },
      city: member.city || null,
    });
  }

  return res.status(200).json({
    success:    true,
    tier,
    expires_at: newExpiry,
    payment_id: razorpay_payment_id,
  });
}
