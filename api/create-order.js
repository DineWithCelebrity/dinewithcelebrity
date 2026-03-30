import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';

const TIER_PRICES = { gold: 249900, platinum: 699900, dwcpurple: 1499900 };
const TIER_LABELS = { gold: 'DWC Gold', platinum: 'DWC Platinum', dwcpurple: 'DWC Purple' };
const TIER_RANK = { free: 0, gold: 1, platinum: 2, dwcpurple: 3 };

const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  if (!rateLimitMap.has(ip)) { rateLimitMap.set(ip, { count: 1, start: now }); return false; }
  const e = rateLimitMap.get(ip);
  if (now - e.start > 60000) { rateLimitMap.set(ip, { count: 1, start: now }); return false; }
  if (e.count >= 5) return true;
  e.count++; return false;
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.dinewithcelebrity.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function calculateAmount(currentTier, newTier, expiresAt) {
  const now = new Date();
  if (!expiresAt || new Date(expiresAt) <= now || TIER_RANK[currentTier] === 0) {
    return { amount: TIER_PRICES[newTier], isProRata: false, keepExpiry: false };
  }
  const remainingDays = Math.max(1, Math.ceil((new Date(expiresAt) - now) / 86400000));
  const currentDaily = TIER_PRICES[currentTier] / 365;
  const newDaily = TIER_PRICES[newTier] / 365;
  const proRata = Math.ceil((newDaily - currentDaily) * remainingDays);
  return { amount: Math.max(proRata, 10000), isProRata: true, keepExpiry: true, remainingDays, originalExpiry: expiresAt };
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests.' });

  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized.' });

  try {
    const sbAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user }, error } = await sbAdmin.auth.getUser(authHeader.replace('Bearer ', '').trim());
    if (error || !user) return res.status(401).json({ error: 'Invalid session.' });

    const { tier } = req.body || {};
    if (!tier || !TIER_PRICES[tier]) return res.status(400).json({ error: 'Invalid tier.' });

    const { data: member } = await sbAdmin.from('members').select('tier, expires_at').eq('id', user.id).single();
    const currentTier = (member?.tier || 'free').toLowerCase();
    if (TIER_RANK[tier] <= TIER_RANK[currentTier]) return res.status(400).json({ error: 'Cannot downgrade membership.' });

    const pricing = calculateAmount(currentTier, tier, member?.expires_at);

    const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    const order = await razorpay.orders.create({
      amount: pricing.amount,
      currency: 'INR',
      receipt: 'dwc_' + user.id.substring(0, 8) + '_' + Date.now(),
      notes: { user_id: user.id, user_email: user.email, tier, current_tier: currentTier, is_pro_rata: String(pricing.isProRata), keep_expiry: String(pricing.keepExpiry), original_expiry: pricing.originalExpiry || '' }
    });

    return res.status(200).json({
      order_id: order.id, amount: order.amount, currency: order.currency,
      tier, label: TIER_LABELS[tier], key_id: process.env.RAZORPAY_KEY_ID,
      user_name: user.user_metadata?.full_name || user.email, user_email: user.email,
      is_pro_rata: pricing.isProRata, remaining_days: pricing.remainingDays || null, original_expiry: pricing.originalExpiry || null
    });
  } catch (err) {
    console.error('[create-order] error:', err.message, JSON.stringify(err));
    return res.status(500).json({ error: 'Failed to create order.', detail: err.message });
  }
}
