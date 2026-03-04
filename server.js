// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ========== CORS – Allow all origins (for development) ==========
app.use(cors({ origin: true, credentials: true }));
app.options('*', cors({ origin: true, credentials: true })); // preflight

app.use(express.json());

// ========== Firebase Admin Setup ==========
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();

// ========== Helper Functions ==========
async function getUser(userId) {
  const snapshot = await db.ref(`users/${userId}`).once('value');
  return snapshot.val();
}

async function updateUserBalance(userId, newBalance) {
  await db.ref(`users/${userId}/balance`).set(newBalance);
}

// ========== ORDER API ENDPOINT ==========
app.post('/api/orders', async (req, res) => {
  try {
    const { userId, serviceId, quantity, details } = req.body;
    
    const user = await getUser(userId);
    const servicesSnapshot = await db.ref('services').once('value');
    const services = servicesSnapshot.val();
    const service = Object.values(services).find(s => s.id === serviceId);
    
    if (!user || !service) {
      return res.status(404).json({ error: 'User or service not found' });
    }

    // 🔧 PLATFORM FEE SET TO 0 (removed ₦100 fee)
    const PLATFORM_FEE = 0;
    const totalCost = (service.pricePerUnit * quantity) + PLATFORM_FEE;
    
    if (user.balance < totalCost) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const orderRef = db.ref('orders').push();
    const orderId = orderRef.key;
    
    const order = {
      id: orderId,
      userId,
      username: user.username,
      serviceId: service.id,
      serviceName: service.name,
      quantity,
      pricePerUnit: service.pricePerUnit,
      serviceCost: service.pricePerUnit * quantity,
      platformFee: PLATFORM_FEE,
      total: totalCost,
      details,
      status: 'pending',
      date: new Date().toISOString(),
      apiProcessed: false
    };
    
    await orderRef.set(order);
    await updateUserBalance(userId, user.balance - totalCost);
    
    // Auto-process if enabled
    const apiSettingsSnapshot = await db.ref('apiSettings').once('value');
    const apiSettings = apiSettingsSnapshot.val() || {};
    
    if (apiSettings.autoProcess && apiSettings.endpoint) {
      try {
        const apiResponse = await axios.post(apiSettings.endpoint, {
          service: service.name,
          quantity,
          details,
          reference: orderId
        }, {
          headers: { 'Authorization': `Bearer ${apiSettings.apiKey}` },
          timeout: (apiSettings.timeout || 30) * 1000
        });
        
        await db.ref(`orders/${orderId}`).update({
          apiProcessed: true,
          apiResponse: apiResponse.data,
          status: 'processing'
        });
        
        return res.json({ success: true, id: orderId, apiProcessed: true });
      } catch (apiError) {
        console.error('API processing failed:', apiError.message, apiError.response?.data);
        return res.json({ success: true, id: orderId, apiProcessed: false });
      }
    }
    
    res.json({ success: true, id: orderId, apiProcessed: false });
    
  } catch (error) {
    console.error('Order creation error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// ========== KORAPAY STANDARD CHECKOUT (no virtual account) ==========
app.post('/api/korapay/pay', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    if (!userId || !amount) return res.status(400).json({ error: 'Missing fields' });

    const user = await getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Get Korapay settings from Firebase
    const paymentMethodsSnapshot = await db.ref('paymentMethods/korapay').once('value');
    const korapaySettings = paymentMethodsSnapshot.val() || {};
    if (!korapaySettings.enabled || !korapaySettings.secretKey) {
      return res.status(400).json({ error: 'Korapay not configured' });
    }

    // Generate unique reference
    const reference = `DB_${userId}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // Initialize checkout (standard payment)
    const response = await axios.post(
      'https://api.korapay.com/merchant/api/v1/charges/initialize',
      {
        amount,
        currency: 'NGN',
        redirect_url: `${req.protocol}://${req.get('host')}/payment-success`, // optional – you can change this
        reference,
        customer: {
          name: user.username,
          email: user.email
        },
        metadata: { userId }
      },
      {
        headers: {
          Authorization: `Bearer ${korapaySettings.secretKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Save deposit record (pending)
    const depositRef = db.ref('deposits').push();
    const depositId = depositRef.key;
    const deposit = {
      id: depositId,
      userId,
      username: user.username,
      amount,
      netAmount: amount,
      fee: 0,
      method: 'korapay',
      reference,
      status: 'pending',
      date: new Date().toISOString(),
      checkoutUrl: response.data.data.checkout_url
    };
    await depositRef.set(deposit);

    res.json({
      checkout_url: response.data.data.checkout_url,
      reference
    });

  } catch (error) {
    console.error('Korapay initialization error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to initialize payment', details: error.response?.data || error.message });
  }
});

// ========== KORAPAY WEBHOOK ==========
app.post('/api/korapay/webhook', async (req, res) => {
  try {
    const payload = req.body;
    console.log('Korapay webhook received:', payload);
    
    const reference = payload.data?.reference || payload.reference;
    if (!reference) return res.status(400).send('Missing reference');
    
    const depositsSnapshot = await db.ref('deposits').orderByChild('reference').equalTo(reference).once('value');
    const deposits = depositsSnapshot.val();
    if (!deposits) return res.status(404).send('Deposit not found');
    
    const depositId = Object.keys(deposits)[0];
    const deposit = deposits[depositId];
    
    if (deposit.status === 'approved') return res.status(200).send('Already processed');
    
    if (payload.event === 'charge.success' || payload.data?.status === 'success') {
      await db.ref(`deposits/${depositId}`).update({
        status: 'approved',
        confirmedAt: new Date().toISOString(),
        korapayResponse: payload
      });
      
      const user = await getUser(deposit.userId);
      if (user) {
        await updateUserBalance(deposit.userId, user.balance + deposit.netAmount);
      }
      
      res.status(200).send('Webhook processed successfully');
    } else if (payload.event === 'charge.failed') {
      await db.ref(`deposits/${depositId}`).update({ status: 'failed' });
      res.status(200).send('Failed recorded');
    } else {
      res.status(200).send('Received');
    }
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Webhook processing failed');
  }
});

// ========== HEALTH CHECK ==========
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});