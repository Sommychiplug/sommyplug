// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

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

// ========== ADMIN DATA ENDPOINTS ==========

// Get all users (admin only)
app.get('/api/admin/users', async (req, res) => {
  try {
    const snapshot = await db.ref('users').once('value');
    const usersData = snapshot.val() || {};
    const users = Object.values(usersData);
    res.json({ users, count: users.length });
  } catch (error) {
    console.error('Failed to load users:', error);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// Get all orders (admin only)
app.get('/api/admin/orders', async (req, res) => {
  try {
    const snapshot = await db.ref('orders').once('value');
    const ordersData = snapshot.val() || {};
    const orders = Object.values(ordersData);
    res.json({ orders, count: orders.length });
  } catch (error) {
    console.error('Failed to load orders:', error);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// Get all deposits (admin only)
app.get('/api/admin/deposits', async (req, res) => {
  try {
    const snapshot = await db.ref('deposits').once('value');
    const depositsData = snapshot.val() || {};
    const deposits = Object.values(depositsData);
    res.json({ deposits, count: deposits.length });
  } catch (error) {
    console.error('Failed to load deposits:', error);
    res.status(500).json({ error: 'Failed to load deposits' });
  }
});

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
        console.log('Calling Exosupplier with:', {
          key: apiSettings.apiKey,
          action: "add",
          service: service.apiServiceId,
          link: details,
          quantity: parseInt(quantity)
        });

        const apiResponse = await axios.post(apiSettings.endpoint, {
          key: apiSettings.apiKey,
          action: "add",
          service: service.apiServiceId,
          link: details,
          quantity: parseInt(quantity)
        }, {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: (apiSettings.timeout || 30) * 1000
        });

        console.log('Exosupplier FULL response:', JSON.stringify(apiResponse.data, null, 2));

        // Try different possible response formats
        const providerOrderId = apiResponse.data.order || 
                               apiResponse.data.id || 
                               apiResponse.data.order_id ||
                               apiResponse.data.provider_order ||
                               apiResponse.data.data?.order;

        if (!providerOrderId) {
          console.error('No providerOrderId found in response');
          throw new Error('Invalid response format: ' + JSON.stringify(apiResponse.data));
        }

        await db.ref(`orders/${orderId}`).update({
          apiProcessed: true,
          providerOrderId: providerOrderId,
          apiResponse: apiResponse.data,
          status: "completed"
        });
        
        return res.json({ success: true, id: orderId, apiProcessed: true });
      } catch (apiError) {
        console.error('API processing failed:', apiError.message, apiError.response?.data || '');
        return res.json({ success: true, id: orderId, apiProcessed: false, error: apiError.message });
      }
    }
    
    res.json({ success: true, id: orderId, apiProcessed: false });
    
  } catch (error) {
    console.error('Order creation error:', error);
    res.status(500).json({ error: 'Failed to create order', details: error.message });
  }
});

// ========== KORAPAY STANDARD CHECKOUT ==========
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

    let reference;
    if (userId && typeof userId === 'string') {
      const shortUserId = userId.slice(-8);
      const timestamp = Date.now().toString().slice(-8);
      const random = Math.random().toString(36).substring(2, 6);
      reference = `DB${shortUserId}${timestamp}${random}`;
    } else {
      reference = `DB${Date.now()}${Math.random().toString(36).substring(2, 8)}`;
    }
    if (!reference) reference = `DB${Date.now()}`;

    console.log('Generated Korapay reference:', reference);

    const response = await axios.post(
      'https://api.korapay.com/merchant/api/v1/charges/initialize',
      {
        amount,
        currency: 'NGN',
        redirect_url: `https://fastplug.netlify.app/?payment=success`,
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

    // Check BOTH processing AND pending orders that have providerOrderId
    const ordersSnapshot = await db.ref('orders').once('value');
    const allOrders = ordersSnapshot.val() || {};
    
    const ordersToCheck = Object.entries(allOrders).filter(([id, order]) => {
      // Check if order has providerOrderId and status is pending/processing
      return order.providerOrderId && 
             (order.status === 'processing' || order.status === 'pending');
    });

    if (ordersToCheck.length === 0) {
      console.log("No orders to check");
      return;
    }

    console.log(`Checking ${ordersToCheck.length} orders`);

    for (const [orderId, order] of ordersToCheck) {
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
        console.log(`Order ${orderId} status: ${providerStatus}`);

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
          console.log(`Updated order ${orderId} to ${statusMap[providerStatus]}`);
        }

      } catch (orderError) {
        console.error("Order check failed:", orderError.response?.data || orderError.message);
      }
    }
  } catch (error) {
    console.error("Status checker error:", error);
  }
});
// ========== IMPORT SERVICES FROM EXOSUPPLIER ==========
app.post('/api/admin/import-services', async (req, res) => {
  try {
    const apiSettingsSnapshot = await db.ref('apiSettings').once('value');
    const apiSettings = apiSettingsSnapshot.val();

    if (!apiSettings?.endpoint || !apiSettings?.apiKey) {
      return res.status(400).json({ error: 'API not configured' });
    }

    // Fetch services from Exosupplier
    const response = await axios.post(apiSettings.endpoint, {
      key: apiSettings.apiKey,
      action: "services"
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    });

    console.log('Exosupplier raw response sample:', JSON.stringify(response.data[0], null, 2));

    if (!Array.isArray(response.data)) {
      return res.status(500).json({ error: 'Invalid response format', data: response.data });
    }

    // Map services with CORRECT apiServiceId field
    const importedServices = response.data.map(svc => {
      const apiServiceId = svc.service || svc.id || svc.service_id || svc.serviceId || svc.serviceID;
      
      console.log(`Mapping service: ${svc.name}, ID found: ${apiServiceId}`);
      
      return {
        id: 'SVC_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        name: svc.name,
        category: svc.category || 'Other',
        subcategory: svc.type || 'Custom',
        minQuantity: parseInt(svc.min) || 50,
        maxQuantity: parseInt(svc.max) || 5000,
        pricePerUnit: (parseFloat(svc.rate) * 1.3) / 1000,
        description: svc.desc || svc.name,
        apiServiceId: apiServiceId
      };
    });

    // Filter out services without apiServiceId
    const validServices = importedServices.filter(s => {
      if (!s.apiServiceId) {
        console.warn(`Skipping service ${s.name} - no apiServiceId found`);
        return false;
      }
      return true;
    });

    if (validServices.length === 0) {
      return res.status(400).json({ 
        error: 'No valid services found. Check Exosupplier response format.',
        sample: response.data[0]
      });
    }

    console.log(`Importing ${validServices.length} valid services`);

    // Save to database
    const servicesRef = db.ref('services');
    const updates = {};
    validServices.forEach(s => {
      updates[s.id] = s;
    });
    
    await servicesRef.update(updates);

    res.json({ 
      success: true, 
      imported: validServices.length,
      skipped: importedServices.length - validServices.length,
      services: validServices 
    });

  } catch (error) {
    console.error('Import failed:', error);
    res.status(500).json({ 
      error: 'Import failed', 
      details: error.message 
    });
  }
});

// ========== HEALTH CHECK ==========
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});
// ========== TEST API CONNECTION ==========
app.post('/api/test-connection', async (req, res) => {
  console.log('Test connection called with body:', req.body);
  
  try {
    const { endpoint, key } = req.body;
    
    if (!endpoint || !key) {
      console.log('Missing fields:', { endpoint: !!endpoint, key: !!key });
      return res.status(400).json({ error: 'Missing endpoint or key' });
    }

    console.log('Testing connection to:', endpoint);

    const response = await axios.post(endpoint, {
      key: key,
      action: "services"
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    console.log('Provider response:', response.data);

    if (Array.isArray(response.data)) {
      res.json({ success: true, serviceCount: response.data.length });
    } else {
      res.json({ success: false, error: 'Invalid response format', data: response.data });
    }
  } catch (error) {
    console.error('API test failed details:', error.message);
    console.error('Error response:', error.response?.data);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: error.response?.data || 'No additional details'
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on port ${PORT}`);
});