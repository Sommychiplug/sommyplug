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
        console.error('API processing failed:', apiError.message);
        return res.json({ success: true, id: orderId, apiProcessed: false });
      }
    }
    
    res.json({ success: true, id: orderId, apiProcessed: false });
    
  } catch (error) {
    console.error('Order creation error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// ========== KORAPAY INTEGRATION – FIXED 404 ERROR ==========
app.post('/api/korapay/generate', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    console.log('Korapay generate request:', { userId, amount });
    
    if (!userId || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const user = await getUser(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get Korapay settings from Firebase
    const paymentMethodsSnapshot = await db.ref('paymentMethods/korapay').once('value');
    const korapaySettings = paymentMethodsSnapshot.val() || {};
    
    if (!korapaySettings.enabled || !korapaySettings.secretKey) {
      return res.status(400).json({ error: 'Korapay not configured' });
    }
    
    // Generate unique reference
    const reference = `DB_${userId}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    // ✅ FIXED: Corrected API endpoint URL
    const KORAPAY_ENDPOINT = 'https://api.korapay.com/merchant/api/v1/virtual-bank-account';
    
    // Call Korapay API to create virtual account
    const response = await axios.post(KORAPAY_ENDPOINT, {
      reference: reference,
      account_name: user.username.replace(/[^a-zA-Z0-9]/g, ' ').substring(0, 50),
      customer: {
        name: user.username,
        email: user.email
      },
      permanent: false,
      bank_code: "035", // ✅ Standard Wema Bank code
      amount: amount,
      currency: "NGN", // Ensure currency is specified
      metadata: {
        userId: userId,
        source: 'DebbyBooster'
      }
    }, {
      headers: {
        'Authorization': `Bearer ${korapaySettings.secretKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    // 🔍 Log the full Korapay response for debugging
    console.log('Korapay API response:', response.data);
    
    // ✅ FIXED: Updated success check for status (API returns boolean true or "true")
    if ((response.data.status === true || response.data.status === 'success') && response.data.data) {
      const accountData = response.data.data;
      
      const depositRef = db.ref('deposits').push();
      const depositId = depositRef.key;
      
      const deposit = {
        id: depositId,
        userId,
        username: user.username,
        amount: amount,
        netAmount: amount - (korapaySettings.fee || 0),
        fee: korapaySettings.fee || 0,
        method: 'korapay',
        reference: reference,
        status: 'pending',
        date: new Date().toISOString(),
        accountNumber: accountData.account_number,
        bankName: accountData.bank_name,
        accountName: accountData.account_name,
        expiryTime: new Date(Date.now() + 30 * 60000).toISOString()
      };
      
      await depositRef.set(deposit);
      
      // Return account details to frontend
      res.json({
        accountNumber: accountData.account_number,
        bankName: accountData.bank_name,
        accountName: accountData.account_name,
        reference: reference,
        depositId: depositId,
        expiryTime: deposit.expiryTime
      });
    } else {
      console.error('Korapay returned non-success status or missing data:', response.data);
      throw new Error('Failed to create virtual account: ' + JSON.stringify(response.data));
    }
    
  } catch (error) {
    console.error('🔥 Korapay generation error details:', {
      message: error.message,
      responseData: error.response?.data,
      status: error.response?.status,
      headers: error.response?.headers
    });
    res.status(500).json({ 
      error: 'Failed to generate payment account',
      details: error.response?.data || error.message 
    });
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
        const netAmount = deposit.netAmount || (deposit.amount - (deposit.fee || 0));
        await updateUserBalance(deposit.userId, user.balance + netAmount);
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
