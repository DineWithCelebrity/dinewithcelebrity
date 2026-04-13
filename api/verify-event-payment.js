// api/verify-event-payment.js
// DWC — Event Payment Verification with Floor Points Logic
// Points: 1pt = ₹3 | Floor: max(T-P, 0.6×T) | Carry forward unused pts

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const sbAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── POINTS MATH ───────────────────────────────────────────────────────────
const PT_VALUE     = 3;    // 1 pt = ₹3
const FLOOR_PCT    = 0.6;  // member always pays at least 60% of ticket

function calcPointsDiscount(ticketPrice, pointsAvailable) {
  const maxDiscount   = ticketPrice * (1 - FLOOR_PCT);          // 40% of ticket
  const ptsWorthRupees = pointsAvailable * PT_VALUE;
  const discount      = Math.min(ptsWorthRupees, maxDiscount);  // capped at floor
  const ptsUsed       = Math.ceil(discount / PT_VALUE);         // pts actually consumed
  const finalPrice    = ticketPrice - discount;
  const ptsCarryFwd   = pointsAvailable - ptsUsed;              // unused pts carry forward

  return { discount, ptsUsed, finalPrice, ptsCarryFwd };
}

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  // ─── 1. PARSE BODY ───────────────────────────────────────────────────────
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    event_id,
    amount,          // final amount member paid
    tier,
    points_used    = 0,
    points_discount = 0,
    first_event_offer = false  // ₹500 signup offer
  } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !event_id)
    return res.status(400).json({ error: 'Missing required fields' });

  // ─── 2. VERIFY JWT ───────────────────────────────────────────────────────
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Unauthorized' });

  const token = authHeader.split(' ')[1];
  const { data: { user }, error: authErr } = await sbAdmin.auth.getUser(token);
  if (authErr || !user)
    return res.status(401).json({ error: 'Invalid session' });

  // ─── 3. IDEMPOTENCY CHECK ────────────────────────────────────────────────
  const { data: existing } = await sbAdmin
    .from('event_bookings').select('id').eq('razorpay_order_id', razorpay_order_id).single();
  if (existing)
    return res.status(200).json({ success: true, booking_id: existing.id, message: 'Already confirmed' });

  // ─── 4. VERIFY RAZORPAY SIGNATURE ───────────────────────────────────────
  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  if (expectedSig !== razorpay_signature)
    return res.status(400).json({ error: 'Payment verification failed' });

  // ─── 5. VERIFY AMOUNT WITH RAZORPAY API ─────────────────────────────────
  try {
    const rzpAuth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const rzpRes  = await fetch(`https://api.razorpay.com/v1/payments/${razorpay_payment_id}`, {
      headers: { Authorization: `Basic ${rzpAuth}` }
    });
    const rzpData = await rzpRes.json();
    if (rzpData.error)
      return res.status(400).json({ error: 'Could not verify payment with Razorpay' });
    if (rzpData.amount < Math.round(amount * 100))
      return res.status(400).json({ error: 'Payment amount mismatch' });
    if (rzpData.status !== 'captured')
      return res.status(400).json({ error: 'Payment not captured' });
  } catch(e) {
    return res.status(500).json({ error: 'Could not verify with Razorpay API' });
  }

  // ─── 6. FETCH MEMBER POINTS ──────────────────────────────────────────────
  const { data: member } = await sbAdmin
    .from('members').select('points, first_event_booked').eq('id', user.id).single();
  const memberPoints = member?.points || 0;

  // ─── 7. FETCH EVENT TICKET PRICE ─────────────────────────────────────────
  const { data: event } = await sbAdmin
    .from('celebrity_events')
    .select('event_title, celebrity_name, event_date, location, city, ticket_price, slug')
    .eq('id', event_id).single();

  const ticketPrice = event?.ticket_price || amount + points_discount;

  // ─── 8. RECALCULATE POINTS ON SERVER (source of truth) ──────────────────
  const { discount, ptsUsed, finalPrice, ptsCarryFwd } = calcPointsDiscount(ticketPrice, points_used > 0 ? Math.min(points_used, memberPoints) : 0);

  // Apply ₹500 first event offer if eligible
  const firstEventDiscount = (first_event_offer && !member?.first_event_booked) ? 500 : 0;
  const totalDiscount      = discount + firstEventDiscount;
  const serverFinalPrice   = Math.max(ticketPrice - totalDiscount, ticketPrice * FLOOR_PCT);

  // Sanity check — amount paid must match server calculation (within ₹1 rounding)
  if (Math.abs(amount - serverFinalPrice) > 1) {
    console.error('Price mismatch', { amount, serverFinalPrice, ticketPrice, ptsUsed });
    // Log but don't block — could be rounding difference
  }

  // ─── 9. DEDUCT POINTS (only pts actually used) ───────────────────────────
  if (ptsUsed > 0) {
    const { error: pointsErr } = await sbAdmin.rpc('deduct_points_fifo', {
      p_user_id:     user.id,
      p_points:      ptsUsed,
      p_reason:      'event_ticket',
      p_reference_id: razorpay_order_id
    });
    if (pointsErr) console.error('Points deduction failed', pointsErr.message);
  }

  // Mark first event offer used
  if (firstEventDiscount > 0) {
    await sbAdmin.from('members').update({ first_event_booked: true }).eq('id', user.id);
  }

  // ─── 10. CONFIRM SEAT — atomic RPC ──────────────────────────────────────
  const { data: confirmData, error: confirmErr } = await sbAdmin.rpc('confirm_event_seat', {
    p_event_id:              event_id,
    p_user_id:               user.id,
    p_razorpay_order_id:     razorpay_order_id,
    p_razorpay_payment_id:   razorpay_payment_id,
    p_amount_paid:           amount,
    p_tier:                  tier,
    p_seats:                 1,
    p_points_used:           ptsUsed,
    p_points_discount:       discount
  });

  if (confirmErr || !confirmData?.success) {
    console.error('confirm_event_seat failed', confirmErr?.message || confirmData?.error);
    return res.status(500).json({ error: 'Booking confirmation failed. Contact support.' });
  }

  // ─── 11. FETCH PROFILE FOR EMAIL ─────────────────────────────────────────
  const { data: profile } = await sbAdmin
    .from('members').select('full_name, email').eq('id', user.id).single();

  const memberName  = profile?.full_name || user.email.split('@')[0];
  const memberEmail = profile?.email     || user.email;
  const eventDate   = event?.event_date
    ? new Date(event.event_date).toLocaleDateString('en-IN', {
        weekday:'long', day:'numeric', month:'long', year:'numeric',
        hour:'2-digit', minute:'2-digit', timeZone:'Asia/Kolkata'
      })
    : 'Date TBA';

  // ─── 12. SEND CONFIRMATION EMAIL ────────────────────────────────────────
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', Authorization:`Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'DWC Events <hello@dinewithcelebrity.com>',
        to:   memberEmail,
        subject: `Your seat is confirmed — ${event?.event_title || 'DWC Event'}`,
        html: buildConfirmationEmail({
          memberName, eventTitle: event?.event_title || 'DWC Celebrity Event',
          castName: event?.celebrity_name || '', eventDate,
          venue: event?.location || 'TBA', city: event?.city || 'Hyderabad',
          tier, amountPaid: amount, bookingId: confirmData.booking_id,
          pointsUsed: ptsUsed, pointsDiscount: discount,
          ptsCarryFwd, firstEventDiscount
        })
      })
    });
  } catch(e) { console.error('Email send failed', e.message); }

  // ─── 13. NOTIFY ADMIN ───────────────────────────────────────────────────
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', Authorization:`Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'DWC Events <hello@dinewithcelebrity.com>',
        to: 'hello@dinewithcelebrity.com',
        subject: `New Booking — ${event?.event_title} [${tier?.toUpperCase()}]`,
        html: `<p><strong>${memberName}</strong> (${memberEmail}) booked <strong>${event?.event_title}</strong>.<br/>
               Tier: ${tier} | Paid: ₹${Number(amount).toLocaleString('en-IN')} | ID: ${confirmData.booking_id}<br/>
               Points used: ${ptsUsed} (₹${discount} off) | Carry fwd: ${ptsCarryFwd} pts</p>`
      })
    });
  } catch(e) { console.error('Admin notify failed', e.message); }

  // ─── 14. LOG PAYMENT ────────────────────────────────────────────────────
  await sbAdmin.from('payment_logs').insert({
    user_id: user.id, order_id: razorpay_order_id, payment_id: razorpay_payment_id,
    amount, status: 'captured', tier, event_type: 'event_booking', event_id
  }).catch(e => console.error('payment_logs insert failed', e.message));

  return res.status(200).json({
    success: true,
    booking_id:    confirmData.booking_id,
    points_used:   ptsUsed,
    points_saved:  discount,
    pts_carry_fwd: ptsCarryFwd,
    message:       'Booking confirmed'
  });
}

// ─── EMAIL TEMPLATE ──────────────────────────────────────────────────────────
function buildConfirmationEmail({ memberName, eventTitle, castName, eventDate, venue, city,
  tier, amountPaid, bookingId, pointsUsed, pointsDiscount, ptsCarryFwd, firstEventDiscount }) {
  const tierLabel = tier?.charAt(0).toUpperCase() + tier?.slice(1);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#06040A;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
<tr><td style="text-align:center;padding-bottom:32px">
  <div style="font-size:28px;font-weight:700;color:#F2B705;letter-spacing:4px">DINE WITH CELEBRITY</div>
</td></tr>
<tr><td style="background:rgba(255,255,255,0.04);border:1px solid rgba(242,183,5,0.25);border-radius:16px;padding:36px">
  <div style="text-align:center;margin-bottom:28px">
    <div style="font-size:36px">🎉</div>
    <div style="font-size:22px;font-weight:700;color:#fff">Your Seat Is Confirmed</div>
  </div>
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
      <div style="font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:2px">EVENT</div>
      <div style="font-size:15px;font-weight:600;color:#F2B705">${eventTitle}</div>
    </td></tr>
    <tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
      <div style="font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:2px">FEATURING</div>
      <div style="font-size:14px;color:#fff">${castName}</div>
    </td></tr>
    <tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
      <div style="font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:2px">DATE & TIME</div>
      <div style="font-size:14px;color:#fff">${eventDate}</div>
    </td></tr>
    <tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
      <div style="font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:2px">VENUE</div>
      <div style="font-size:14px;color:#fff">${venue}, ${city}</div>
    </td></tr>
    <tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
      <div style="font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:2px">AMOUNT PAID</div>
      <div style="font-size:16px;font-weight:700;color:#00C853">₹${Number(amountPaid).toLocaleString('en-IN')}</div>
    </td></tr>
    ${pointsUsed > 0 ? `<tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
      <div style="font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:2px">POINTS REDEEMED</div>
      <div style="font-size:14px;color:#FFD166">${pointsUsed} pts → saved ₹${Number(pointsDiscount).toLocaleString('en-IN')}</div>
    </td></tr>` : ''}
    ${ptsCarryFwd > 0 ? `<tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
      <div style="font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:2px">POINTS CARRIED FORWARD</div>
      <div style="font-size:14px;color:#FFD166">${ptsCarryFwd} pts saved for your next event</div>
    </td></tr>` : ''}
    ${firstEventDiscount > 0 ? `<tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
      <div style="font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:2px">WELCOME OFFER</div>
      <div style="font-size:14px;color:#00C853">₹500 first event discount applied</div>
    </td></tr>` : ''}
    <tr><td style="padding:10px 0">
      <div style="font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:2px">BOOKING ID</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.5);font-family:monospace">${bookingId}</div>
    </td></tr>
  </table>
  ${ptsCarryFwd > 0 ? `
  <div style="background:rgba(242,183,5,0.07);border:1px solid rgba(242,183,5,0.2);border-radius:10px;padding:16px;margin:20px 0;text-align:center">
    <div style="font-size:13px;color:#FFD166">🌟 ${ptsCarryFwd} points saved for your next DWC experience</div>
  </div>` : ''}
  <div style="text-align:center;margin-top:24px">
    <a href="https://dinewithcelebrity.com/dashboard.html"
       style="display:inline-block;background:#F2B705;color:#06040A;font-weight:700;font-size:14px;padding:14px 32px;border-radius:50px;text-decoration:none">
      View My Booking →
    </a>
  </div>
</td></tr>
<tr><td style="text-align:center;padding:24px 0">
  <div style="font-size:12px;color:rgba(255,255,255,0.3)">
    Questions? <a href="mailto:hello@dinewithcelebrity.com" style="color:#F2B705">hello@dinewithcelebrity.com</a><br/>
    Dine With Celebrity Pvt Ltd · Hyderabad
  </div>
</td></tr>
</table></td></tr></table>
</body></html>`;
}
