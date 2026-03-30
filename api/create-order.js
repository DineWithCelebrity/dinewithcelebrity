import Razorpay from 'razorpay';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  console.log('KEY_ID:', process.env.RAZORPAY_KEY_ID ? process.env.RAZORPAY_KEY_ID.substring(0,15) + '...' : 'MISSING');
  console.log('KEY_SECRET:', process.env.RAZORPAY_KEY_SECRET ? 'SET (' + process.env.RAZORPAY_KEY_SECRET.length + ' chars)' : 'MISSING');

  try {
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    const order = await razorpay.orders.create({ amount: 100, currency: 'INR', receipt: 'test_' + Date.now() });
    console.log('ORDER OK:', order.id);
    return res.status(200).json({ order_id: order.id, amount: order.amount, key_id: process.env.RAZORPAY_KEY_ID });
  } catch(err) {
    console.error('RAZORPAY ERROR:', JSON.stringify(err));
    return res.status(500).json({ error: err.message, detail: JSON.stringify(err) });
  }
}
