// ============================================================
// /api/razorpay-webhook.js — DWC Razorpay Webhook Handler
// Backup safety net: fires if user closes tab before callback
// Security: Webhook signature verification, idempotency
// ============================================================

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { buffer } from 'micro';

export const config = { api: { bodyParser: false } };

const TIER_PRICES = {
  gold:      249900,
  platinum:  699900,
  dwcpurple: 1499900,
};

const TIER_EXPIRY_DAYS = 365;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let rawBody;
  try {
    rawBody = (await buffer(req)).toString('utf8');
  } catch (err) {
    console.error('[webhook] Failed to read body:', err);
    return res.status(400).json({ error: 'Failed to read body' });
  }

  const webhookSignature = req.headers['x-razorpay-signature'];
  if (!webhookSignature) {
    console.warn('[webhook] Missing signature header');
    return res.status(400).json({ error: 'Missing signature' });
  }

  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  if (expectedSig !== webhookSignature) {
    console.warn('[webhook] Signature mismatch — possible fake webhook');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (event.event !== 'payment.captured') {
    return res.status(200).json({ received: true, action: 'ignored', event: event.event });
  }

  const payment   = event.payload?.payment?.entity;
  const orderId   = payment?.order_id;
  const paymentId = payment?.id;
  const notes     = payment?.notes || {};
  const tier      = notes.tier;
  const userId    = notes.user_id;

  if (!orderId || !paymentId || !tier || !userId) {
    console.error('[webhook] Missing required fields:', { orderId, paymentId, tier, userId });
    return res.status(400).json({ error: 'Missing payment fields' });
  }

  if (!TIER_PRICES[tier]) {
    console.error('[webhook] Invalid tier from webhook:', tier);
    return res.status(400).json({ error: 'Invalid tier' });
  }

  const sbAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: existingLog } = await sbAdmin
    .from('payment_logs')
    .select('id, status')
    .eq('payment_id', paymentId)
    .single();

  if (existingLog) {
    console.log('[webhook] Already processed, skipping:', paymentId);
    return res.status(200).json({ received: true, action: 'already_processed' });
  }

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + TIER_EXPIRY_DAYS);

  const { error: updateError } = await sbAdmin
    .from('members')
    .update({
      tier,
      upgraded_at:      new Date().toISOString(),
      expires_at:       expiresAt.toISOString(),
      payment_id:       paymentId,
      payment_order_id: orderId,
    })
    .eq('id', userId);

  if (updateError) {
    console.error('[webhook] Tier update failed:', updateError);
    return res.status(500).json({ error: 'Tier update failed' });
  }

  await sbAdmin.from('payment_logs').insert({
    member_id:  userId,
    payment_id: paymentId,
    order_id:   orderId,
    tier,
    amount:     TIER_PRICES[tier],
    status:     'success',
    source:     'webhook',
    created_at: new Date().toISOString(),
  });

  const { data: memberData } = await sbAdmin
    .from('members')
    .select('member_id, city')
    .eq('id', userId)
    .single();

  if (memberData?.member_id) {
    await sbAdmin.from('member_activity').insert({
      member_id:     memberData.member_id,
      member_uuid:   userId,
      activity_type: 'upgrade',
      activity_data: { tier, amount: TIER_PRICES[tier] / 100, payment_id: paymentId, order_id: orderId, source: 'webhook' },
      city: memberData.city || null,
    });
  }

  console.log('[webhook] Tier upgraded via webhook: user=' + userId + ' tier=' + tier + ' payment=' + paymentId);

  return res.status(200).json({ received: true, action: 'tier_updated', tier });
}
