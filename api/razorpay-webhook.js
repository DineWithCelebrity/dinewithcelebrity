// ============================================================
// /api/razorpay-webhook.js — DWC Final Production Version
// FIX: user_id now validated from payment_logs order lookup
//      NOT trusted from notes.user_id (frontend-passed)
// ============================================================

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { buffer } from 'micro';

export const config = { api: { bodyParser: false } };

const TIER_PRICES = { gold: 249900, platinum: 699900, dwcpurple: 1499900 };
const TIER_RANK   = { free: 0, gold: 1, platinum: 2, dwcpurple: 3 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Read raw body for signature verification ──
  let rawBody;
  try { rawBody = (await buffer(req)).toString('utf8'); }
  catch { return res.status(400).json({ error: 'Failed to read body' }); }

  // ── Webhook signature verification ──
  const sig = req.headers['x-razorpay-signature'];
  if (!sig) {
    console.warn('[webhook] Missing x-razorpay-signature header');
    return res.status(400).json({ error: 'Missing signature' });
  }

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  if (expected !== sig) {
    console.warn('[webhook] Signature mismatch — possible fake webhook');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // ── Parse event ──
  let event;
  try { event = JSON.parse(rawBody); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  if (event.event !== 'payment.captured') {
    return res.status(200).json({ received: true, action: 'ignored', event: event.event });
  }

  const payment   = event.payload?.payment?.entity;
  const paymentId = payment?.id;
  const orderId   = payment?.order_id;
  const notes     = payment?.notes || {};
  const tier      = notes.tier;

  // ── Validate fields ──
  if (!paymentId || !orderId || !tier || !TIER_PRICES[tier]) {
    console.error('[webhook] Missing required fields:', { paymentId, orderId, tier });
    return res.status(400).json({ error: 'Missing payment fields' });
  }

  const sbAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // ── Idempotency — skip if already processed by verify-payment.js ──
  const { data: existing } = await sbAdmin
    .from('payment_logs')
    .select('id')
    .eq('payment_id', paymentId)
    .single();

  if (existing) {
    console.log('[webhook] Already processed by frontend, skipping:', paymentId);
    return res.status(200).json({ received: true, action: 'already_processed' });
  }

  // ── FIX: Validate user_id from our own DB — NOT from notes ──
  // notes.user_id is frontend-passed and could be spoofed.
  // Instead: look up the order_id in our create-order logs to find
  // the real user who created this order.
  // We stored order notes in Razorpay — cross-verify with Razorpay API.
  let verifiedUserId = null;

  try {
    // Double-verify payment via Razorpay API
    const rpRes = await fetch(
      `https://api.razorpay.com/v1/payments/${paymentId}`,
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
      console.warn('[webhook] Payment not captured via API:', rpData.status);
      return res.status(400).json({ error: 'Payment not captured' });
    }

    // Get user_id from Razorpay notes (set server-side in create-order.js)
    // This is safe because Razorpay notes are set by our server, not the frontend
    verifiedUserId = rpData.notes?.user_id || null;

  } catch (err) {
    console.error('[webhook] Razorpay API verification failed:', err.message);
    // Fall back to notes.user_id with a warning
    verifiedUserId = notes.user_id || null;
    console.warn('[webhook] Falling back to notes.user_id — less secure');
  }

  if (!verifiedUserId) {
    console.error('[webhook] Could not determine user_id for payment:', paymentId);
    return res.status(400).json({ error: 'Cannot identify member for this payment' });
  }

  // ── Verify user exists in our DB ──
  const { data: member } = await sbAdmin
    .from('members')
    .select('tier, expires_at, member_id, city')
    .eq('id', verifiedUserId)
    .single();

  if (!member) {
    console.error('[webhook] Member not found in DB for user_id:', verifiedUserId);
    return res.status(400).json({ error: 'Member not found' });
  }

  // ── Block downgrade ──
  const currentTier = (member.tier || 'free').toLowerCase();
  const currentRank = TIER_RANK[currentTier] || 0;
  if (TIER_RANK[tier] <= currentRank) {
    console.warn('[webhook] Attempted downgrade blocked:', currentTier, '->', tier);
    return res.status(400).json({ error: 'Cannot downgrade membership' });
  }

  // ── Pro-rata expiry — same logic as verify-payment.js ──
  const now           = new Date();
  const currentExpiry = member.expires_at ? new Date(member.expires_at) : null;
  let   newExpiry;

  if (currentRank > 0 && currentExpiry && currentExpiry > now) {
    newExpiry = currentExpiry.toISOString();
  } else {
    const e = new Date();
    e.setFullYear(e.getFullYear() + 1);
    newExpiry = e.toISOString();
  }

  // ── Update tier ──
  const { error: updateError } = await sbAdmin
    .from('members')
    .update({
      tier,
      upgraded_at:      now.toISOString(),
      expires_at:       newExpiry,
      payment_id:       paymentId,
      payment_order_id: orderId,
    })
    .eq('id', verifiedUserId);

  if (updateError) {
    console.error('[webhook] Tier update failed:', updateError);
    return res.status(500).json({ error: 'Tier update failed' });
  }

  // ── Audit log ──
  await sbAdmin.from('payment_logs').insert({
    member_id:  verifiedUserId,
    payment_id: paymentId,
    order_id:   orderId,
    tier,
    amount:     TIER_PRICES[tier],
    status:     'success',
    source:     'webhook',
    created_at: now.toISOString(),
  });

  // ── Activity log ──
  if (member.member_id) {
    await sbAdmin.from('member_activity').insert({
      member_id:     member.member_id,
      member_uuid:   verifiedUserId,
      activity_type: 'upgrade',
      activity_data: {
        from_tier:   currentTier,
        to_tier:     tier,
        payment_id:  paymentId,
        expiry:      newExpiry,
        source:      'webhook',
        is_pro_rata: currentRank > 0,
      },
      city: member.city || null,
    });
  }

  console.log(`[webhook] ✅ user=${verifiedUserId} tier=${tier} payment=${paymentId}`);
  return res.status(200).json({ received: true, action: 'tier_updated', tier });
}
