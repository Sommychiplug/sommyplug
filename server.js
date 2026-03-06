// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const cron = require('node-cron');
// ========== CORS ==========
app.use(cors({ origin: true, credentials: true }));
app.options('*', cors({ origin: true, credentials: true }));

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
    
    // Auto-process if enabled - SINGLE KEY AUTHENTICATION
    const apiSettingsSnapshot = await db.ref('apiSettings').once('value');
    const apiSettings = apiSettingsSnapshot.val() || {};
    
    if (apiSettings.autoProcess && apiSettings.endpoint && apiSettings.apiKey) {
      try { 
        // SINGLE KEY in request body (standard SMM panel format)
        const apiResponse = await axios.post(apiSettings.endpoint, {
          key: apiSettings.apiKey,
          action: "add",
          service: service.apiServiceId || service.id,
          link: details,
          quantity: parseInt(quantity)
        }, {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: (apiSettings.timeout || 30) * 1000
        });

        await db.ref(`orders/${orderId}`).update({
          apiProcessed: true,
          providerOrderId: apiResponse.data.order,
          apiResponse: apiResponse.data,
          status: "processing"
        });
        
        return res.json({ success: true, id: orderId, apiProcessed: true });
      } catch (apiError) {
        console.error('API processing failed:', apiError.message, apiResponse?.data || '');
        return res.json({ success: true, id: orderId, apiProcessed: false, error: apiError.message });
      }
    }
    
    res.json({ success: true, id: orderId, apiProcessed: false });
    
  } catch (error) {
    console.error('Order creation error:', error);
    res.status(500).json({ error: 'Failed to create order', details: error.message });
  }
});
// ========== AUTO ORDER STATUS CHECKER ==========
cron.schedule('*/5 * * * *', async () => {
  console.log("Checking provider order statuses...");

  try {
    const apiSettingsSnapshot = await db.ref('apiSettings').once('value');
    const apiSettings = apiSettingsSnapshot.val();

    if (!apiSettings || !apiSettings.endpoint || !apiSettings.apiKey) {
      console.log("API settings not configured");
      return;
    }

    const ordersSnapshot = await db.ref('orders')
      .orderByChild('status')
      .equalTo('processing')
      .once('value');

    const orders = ordersSnapshot.val();

    if (!orders) {
      console.log("No processing orders");
      return;
    }

    for (const orderId in orders) {
      const order = orders[orderId];

      if (!order.providerOrderId) continue;

      try {
        // SINGLE KEY AUTHENTICATION for status check
        const response = await axios.post(apiSettings.endpoint, {
          key: apiSettings.apiKey,
          action: "status",
          order: order.providerOrderId
        }, {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 10000
        });

        const providerStatus = response.data.status;

        await db.ref(`orders/${orderId}`).update({
          providerStatus: providerStatus,
          lastChecked: new Date().toISOString()
        });

        // Map provider status to your status
        const statusMap = {
          "Completed": "completed",
          "Processing": "processing", 
          "Pending": "pending",
          "Partial": "partial",
          "Canceled": "cancelled",
          "In progress": "processing"
        };

        if (statusMap[providerStatus]) {
          await db.ref(`orders/${orderId}`).update({ status: statusMap[providerStatus] });
        }

      } catch (orderError) {
        console.error("Order check failed:", orderError.response?.data || orderError.message);
      }
    }
  } catch (error) {
    console.error("Status checker error:", error);
  }
});

// ========== KORAPAY STANDARD CHECKOUT – WITH FIXED REFERENCE ==========
app.post('/api/korapay/pay', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    if (!userId || !amount) return res.status(400).json({ error: 'Missing fields' });

    const user = await getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const paymentMethodsSnapshot = await db.ref('paymentMethods/korapay').once('value');
    const korapaySettings = paymentMethodsSnapshot.val() || {};
    if (!korapaySettings.enabled || !korapaySettings.secretKey) {
      return res.status(400).json({ error: 'Korapay not configured' });
    }

    // ---- Generate a robust reference ----
    let reference;
    if (userId && typeof userId === 'string') {
      // Use last 8 chars of userId + timestamp + random
      const shortUserId = userId.slice(-8);
      const timestamp = Date.now().toString().slice(-8);
      const random = Math.random().toString(36).substring(2, 6);
      reference = `DB${shortUserId}${timestamp}${random}`; // ~22 chars
    } else {
      // Fallback if userId is invalid
      reference = `DB${Date.now()}${Math.random().toString(36).substring(2, 8)}`;
    }
    // Ensure reference is not empty (ultimate fallback)
    if (!reference) reference = `DB${Date.now()}`;

    console.log('✅ Generated Korapay reference:', reference); // Log it for debugging

    // Your frontend URL – replace with your actual Netlify URL
    const frontendUrl = 'https://fastplug.netlify.app'; // ⚠️ CHANGE THIS

    const response = await axios.post(
      'https://api.korapay.com/merchant/api/v1/charges/initialize',
      {
        amount,
        currency: 'NGN',
        redirect_url: `https://fastplug.netlify.app/?deposit?success=true`,
        reference,  // now guaranteed to be a non-empty string
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
    console.error('🔥 Korapay initialization error:', error.response?.data || error.message);
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
   
// ========== AUTO ORDER STATUS CHECKER ==========
cron.schedule('*/5 * * * *', async () => {
  console.log("Checking provider order statuses...");

  try {
    const apiSettingsSnapshot = await db.ref('apiSettings').once('value');
    const apiSettings = apiSettingsSnapshot.val();

    if (!apiSettings || !apiSettings.endpoint || !apiSettings.apiKey) {
      console.log("API settings not configured");
      return;
    }

    const ordersSnapshot = await db.ref('orders')
      .orderByChild('status')
      .equalTo('processing')
      .once('value');

    const orders = ordersSnapshot.val();
    if (!orders) {
      console.log("No processing orders");
      return;
    }

    for (const orderId in orders) {
      const order = orders[orderId];
      if (!order.providerOrderId) continue;

      try {
        const response = await axios.post(apiSettings.endpoint, {
          key: apiSettings.apiKey,
          action: "status",
          order: order.providerOrderId
        }, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        });

        const providerStatus = response.data.status;
        await db.ref(`orders/${orderId}`).update({
          providerStatus: providerStatus,
          lastChecked: new Date().toISOString()
        });

        // Map status
        const statusMap = {
          "Completed": "completed",
          "Processing": "processing", 
          "Pending": "pending",
          "Partial": "partial",
          "Canceled": "cancelled",
          "In progress": "processing"
        };

        if (statusMap[providerStatus]) {
          await db.ref(`orders/${orderId}`).update({ status: statusMap[providerStatus] });
        }

      } catch (orderError) {
        console.error("Order check failed:", orderError.response?.data || orderError.message);
      }
    }
  } catch (error) {
    console.error("Status checker error:", error);
  }
});
// ========== TEST API CONNECTION ==========
app.post('/api/test-connection', async (req, res) => {
  try {
    const { endpoint, key } = req.body;
    
    if (!endpoint || !key) {
      return res.status(400).json({ error: 'Missing endpoint or key' });
    }

    const response = await axios.post(endpoint, {
      key: key,
      action: "services"
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    if (Array.isArray(response.data)) {
      res.json({ success: true, serviceCount: response.data.length });
    } else {
      res.json({ success: false, error: 'Invalid response format' });
    }
  } catch (error) {
    console.error('API test failed:', error.response?.data || error.message);
    res.status(500).json({ 
      success: false, 
      error: error.response?.data?.error || error.message 
    });
  }
});
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on port ${PORT}`);
});
app.get('/api/exo/import-services', async (req, res) => {
  try {

    const apiSettingsSnapshot = await db.ref('apiSettings').once('value');
    const apiSettings = apiSettingsSnapshot.val();

    if (!apiSettings || !apiSettings.endpoint || !apiSettings.apiKey) {
      return res.status(400).json({ error: "API settings missing" });
    }

    // Get services from ExoSupplier
    const response = await axios.post(apiSettings.endpoint, {
      key: apiSettings.apiKey,
      action: "services"
    });

    const services = response.data;

    if (!Array.isArray(services)) {
      return res.status(500).json({ error: "Invalid services response" });
    }

    let imported = 0;

    for (const service of services) {

      const providerRate = parseFloat(service.rate);

      // Auto profit (30%)
      const profitPercent = apiSettings.profitPercent || 30;
      const sellingPrice = providerRate + (providerRate * profitPercent / 100);

      const newServiceRef = db.ref('services').push();

      await newServiceRef.set({
        id: newServiceRef.key,
        name: service.name,
        category: service.category,
        pricePerUnit: sellingPrice * 1000,
        providerPrice: providerRate * 1000,
        apiServiceId: service.service,
        min: service.min,
        max: service.max
      });

      imported++;

    }

    res.json({
      success: true,
      imported: imported
    });

  } catch (error) {

    console.error("Service import failed:", error.response?.data || error.message);

    res.status(500).json({
      error: "Failed to import services",
      details: error.response?.data || error.message
    });

  }
});