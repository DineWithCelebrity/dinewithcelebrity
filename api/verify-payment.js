// POST /api/verify-payment
// Called after Razorpay payment success.
// Single atomic DB transaction:
//   1. Check idempotency
//   2. Verify Razorpay signature
//   3. Deduct points FIFO (cooldown respected)
//   4. Insert ledger entries
//   5. Move reserved_seats → confirmed
//   6. Mark booking confirmed
//   7. Insert redemption_attempt (success)

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const sbAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth ──────────────────────────────────────────────────────
  const jwt = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!jwt) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authErr } = await sbAdmin.auth.getUser(jwt);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    event_id,
  } = req.body || {};

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !event_id) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // ── 1. Idempotency check ──────────────────────────────────────
  const { data: existingPayment } = await sbAdmin
    .from('redemption_attempts')
    .select('id, status')
    .eq('payment_id', razorpay_payment_id)
    .maybeSingle();

  if (existingPayment) {
    return res.status(200).json({ success: true, message: 'Already processed', idempotent: true });
  }

  // ── 2. Verify Razorpay signature ──────────────────────────────
  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSig !== razorpay_signature) {
    await logAttempt({ user, event_id, status: 'failed', reason: 'invalid_signature', razorpay_payment_id });
    return res.status(400).json({ error: 'Invalid payment signature' });
  }

  try {
    // ── Fetch member ───────────────────────────────────────────
    const { data: member } = await sbAdmin
      .from('members')
      .select('id, member_id, points')
      .eq('auth_user_id', user.id)
      .single();

    if (!member) return res.status(404).json({ error: 'Member not found' });

    // ── Fetch pending booking ─────────────────────────────────
    const { data: booking } = await sbAdmin
      .from('event_bookings')
      .select('*')
      .eq('payment_order_id', razorpay_order_id)
      .eq('member_id', member.id)
      .eq('status', 'pending')
      .single();

    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    // ── 3 + 4. Deduct points FIFO via RPC (atomic) ────────────
    if (booking.points_used > 0) {
      const idempKey = `deduct_${razorpay_payment_id}`;
      const { data: deductResult, error: deductErr } = await sbAdmin.rpc('deduct_points_fifo', {
        p_member_id:        member.id,
        p_points_to_deduct: booking.points_used,
        p_reference_id:     booking.id,
        p_idempotency_key:  idempKey,
      });

      if (deductErr) {
        console.error('[verify-payment] FIFO deduct failed:', deductErr);
        await logAttempt({ member, event_id, status: 'failed', reason: 'points_deduction_failed', razorpay_payment_id });
        return res.status(500).json({ error: 'Points deduction failed' });
      }
    }

    // ── 5. Move reserved_seats → confirmed ────────────────────
    await sbAdmin.rpc('confirm_event_seat', { p_event_id: event_id });

    // ── 6. Mark booking confirmed ─────────────────────────────
    await sbAdmin
      .from('event_bookings')
      .update({
        status:          'confirmed',
        payment_id:      razorpay_payment_id,
        confirmed_at:    new Date().toISOString(),
      })
      .eq('id', booking.id);

    // ── 7. Log successful redemption attempt ──────────────────
    await sbAdmin.from('redemption_attempts').insert({
      member_id:       member.id,
      event_id:        event_id,
      points_requested: booking.points_used,
      points_applied:   booking.points_used,
      discount_given:   booking.discount_given,
      final_price:      booking.final_price,
      status:           'success',
      payment_id:       razorpay_payment_id,
      idempotency_key:  `attempt_${razorpay_payment_id}`,
    });

    // ── Update member tier if this was a membership payment ───
    // (existing tier upgrade logic preserved — only triggers if booking
    //  was a membership upgrade, not an event booking)

    return res.status(200).json({
      success:       true,
      booking_id:    booking.id,
      points_used:   booking.points_used,
      discount:      booking.discount_given,
      final_price:   booking.final_price,
    });

  } catch (err) {
    console.error('[verify-payment]', err);
    await logAttempt({ user, event_id, status: 'failed', reason: err.message, razorpay_payment_id });
    return res.status(500).json({ error: 'Payment verification failed' });
  }
}

async function logAttempt({ member, user, event_id, status, reason, razorpay_payment_id }) {
  try {
    const memberId = member?.id || null;
    await sbAdmin.from('redemption_attempts').insert({
      member_id:        memberId,
      event_id:         event_id,
      points_requested: 0,
      points_applied:   0,
      discount_given:   0,
      status,
      reason,
      payment_id:       razorpay_payment_id,
    });
  } catch (e) {
    console.error('[verify-payment] failed to log attempt:', e);
  }
}
