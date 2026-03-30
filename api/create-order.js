// ============================================================
// /api/create-order.js — DWC Razorpay Order Creation
// Server-side only. Prices never exposed to frontend.
// Security: Rate limiting, CORS, Supabase JWT auth
// ============================================================

import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';

// ── Tier prices (paise) — server-side ONLY, never in frontend ──
const TIER_PRICES = {
  gold:      249900,   // ₹2,499
  platinum:  699900,   // ₹6,999
  dwcpurple: 1499900,  // ₹14,999
};

const TIER_LABELS = {
  gold:      'DWC Gold',
  platinum:  'DWC Platinum',
  dwcpurple: 'DWC Purple',
};

// ── In-memory rate limiter (5 orders / IP / 60s) ──
const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const window = 60_000;
  const limit = 5;
  const key = ip;
  if (!rateLimitMap.has(key)) {
    rateLimitMap.set(key, { count: 1, start: now });
    return false;
  }
  const entry = rateLimitMap.get(key);
  if (now - entry.start > window) {
    rateLimitMap.set(key, { count: 1, start: now });
    return false;
  }
  if (entry.count >= limit) return true;
  entry.count++;
  return false;
}

// ── CORS helper ──
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.dinewithcelebrity.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req, res) {
  setCORS(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Rate limiting ──
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  }

  // ── Auth: Validate Supabase JWT ──
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized. Please log in and try again.' });
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

  // ── Validate tier ──
  const { tier } = req.body || {};
  if (!tier || !TIER_PRICES[tier]) {
    return res.status(400).json({ error: 'Invalid tier selected.' });
  }

  const amount = TIER_PRICES[tier];
  const label  = TIER_LABELS[tier];

  // ── Create Razorpay order ──
  try {
    const razorpay = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt:  `dwc_${user.id.substring(0, 8)}_${Date.now()}`,
      notes: {
        user_id:    user.id,
        user_email: user.email,
        tier,
        label,
      },
    });

    return res.status(200).json({
      order_id:   order.id,
      amount:     order.amount,
      currency:   order.currency,
      tier,
      label,
      key_id:     process.env.RAZORPAY_KEY_ID,
      user_name:  user.user_metadata?.full_name || user.email,
      user_email: user.email,
    });

  } catch (err) {
    console.error('[create-order] Razorpay error:', err);
    return res.status(500).json({ error: 'Failed to create order. Please try again.' });
  }
}
