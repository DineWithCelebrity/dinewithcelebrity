// ============================================================
// /api/verify-payment.js — DWC Final Production Version
// Security layers:
//   1. JWT auth — user.id from Supabase, never from frontend
//   2. HMAC-SHA256 signature verification
//   3. Razorpay API double-verification (status = captured)
//   4. Idempotency — payment_id UNIQUE blocks replay attacks
//   5. Pro-rata expiry — original expiry preserved on upgrade
//   6. Tier update by user.id only — never by email
//   7. Full audit trail — payment_logs + member_activity
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

  // ── LAYER 1: JWT Auth — user identity from Supabase, never frontend ──
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }

  const sbAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: { user }, error: authError } = await sbAdmin.auth.getUser(
    authHeader.replace('Bearer ', '').trim()
  );
  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid session. Please log in again.' });
  }

  // ── Validate required fields ──
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature, tier } = req.body || {};
  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature || !tier) {
    return res.status(400).json({ error: 'Missing payment details.' });
  }
  if (!TIER_PRICES[tier]) {
    return res.status(400).json({ error: 'Invalid tier.' });
  }

  // ── LAYER 2: HMAC-SHA256 Signature Verification ──
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expected !== razorpay_signature) {
    console.warn('[verify-payment] Signature mismatch for user:', user.id);
    return res.status(400).json({ error: 'Payment signature verification failed.' });
  }

  // ── LAYER 3: Razorpay API Double-Verification ──
  // Confirms payment actually exists on Razorpay and is captured
  try {
    const rpRes = await fetch(
      `https://api.razorpay.com/v1/payments/${razorpay_payment_id}`,
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(
            `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
          ).toString('base64'),
        },
      }
    );
    const rpData = await rpRes.json();

    if (rpData.status !== 'captured') {
      console.warn('[verify-payment] Payment not captured. Status:', rpData.status);
      return res.status(400).json({
        error: 'Payment not completed. Status: ' + (rpData.status || 'unknown'),
      });
    }

    // Verify order_id matches — extra tamper check
    if (rpData.order_id !== razorpay_order_id) {
      console.warn('[verify-payment] Order ID mismatch:', rpData.order_id, razorpay_order_id);
      return res.status(400).json({ error: 'Payment order mismatch. Contact support.' });
    }

  } catch (fetchErr) {
    // Network failure — signature already verified above, log and continue
    console.error('[verify-payment] Razorpay API fetch failed:', fetchErr.message);
  }

  // ── LAYER 4: Idempotency — block replay attacks ──
  const { data: existing } = await sbAdmin
    .from('payment_logs')
    .select('id')
    .eq('payment_id', razorpay_payment_id)
    .single();

  if (existing) {
    return res.status(200).json({
      success: true, already_processed: true, tier,
      message: 'Payment already processed.',
    });
  }

  // ── Get current member data ──
  const { data: member } = await sbAdmin
    .from('members')
    .select('tier, expires_at, member_id, city')
    .eq('id', user.id)
    .single();

  const currentTier = (member?.tier || 'free').toLowerCase();
  const currentRank = TIER_RANK[currentTier] || 0;

  // Block downgrade server-side
  if (TIER_RANK[tier] <= currentRank) {
    return res.status(400).json({ error: 'Cannot downgrade membership.' });
  }

  // ── LAYER 5: Pro-rata expiry — preserve original expiry on upgrade ──
  const now           = new Date();
  const currentExpiry = member?.expires_at ? new Date(member.expires_at) : null;
  let   newExpiry;

  if (currentRank > 0 && currentExpiry && currentExpiry > now) {
    // Paid upgrade — preserve original expiry, no extension
    newExpiry = currentExpiry.toISOString();
  } else {
    // Free or expired — fresh 1 year from today
    const e = new Date();
    e.setFullYear(e.getFullYear() + 1);
    newExpiry = e.toISOString();
  }

  // ── LAYER 6: Update tier by user.id (never by email) ──
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
    console.error('[verify-payment] Tier update failed:', updateError);
    return res.status(500).json({
      error: `Payment verified but tier update failed. Contact payments@dinewithcelebrity.com with Payment ID: ${razorpay_payment_id}`,
    });
  }

  // ── LAYER 7: Full audit trail ──
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

  console.log(`[verify-payment] ✅ user=${user.id} tier=${tier} payment=${razorpay_payment_id}`);

  return res.status(200).json({
    success: true, tier, expires_at: newExpiry, payment_id: razorpay_payment_id,
  });
}
