const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
require('dotenv').config();

// Initialize Firebase Admin SDK
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
});
const db = admin.database();

const app = express();
app.use(cors());
app.use(express.json());

// ==================== KORAPAY CONFIG ====================
const KORAPAY_SECRET_KEY = process.env.KORAPAY_SECRET_KEY;
const KORAPAY_PUBLIC_KEY = process.env.KORAPAY_PUBLIC_KEY;
const KORAPAY_WEBHOOK_SECRET = process.env.KORAPAY_WEBHOOK_SECRET;

// ==================== ORDER API CONFIG ====================
let orderApiSettings = {
    enabled: true,
    endpoint: process.env.ORDER_API_ENDPOINT || 'https://api.example.com/v1/orders',
    apiKey: process.env.ORDER_API_KEY || 'sk_live_abc123',
    timeout: 30
};

// Load settings from Firebase on startup
async function loadApiSettings() {
    const snapshot = await db.ref('apiSettings').once('value');
    if (snapshot.exists()) {
        orderApiSettings = { ...orderApiSettings, ...snapshot.val() };
    }
}
loadApiSettings();

// ==================== ENDPOINTS ====================

// 1. Generate Korapay virtual account
app.post('/api/korapay/generate', async (req, res) => {
    const { userId, amount } = req.body;
    if (!userId || !amount || amount < 100) {
        return res.status(400).json({ error: 'Invalid amount or user' });
    }

    try {
        const response = await axios.post('https://api.korapay.com/v1/merchant/api/v1/virtual-accounts', {
            amount,
            currency: 'NGN',
            reference: 'DB' + Date.now() + Math.random().toString(36).substring(7),
            customer: {
                name: 'User Name',
                email: 'user@email.com'
            }
        }, {
            headers: { Authorization: `Bearer ${KORAPAY_SECRET_KEY}` }
        });

        const korapayData = response.data.data;
        const expiryMinutes = 30;
        const expiryTime = Date.now() + expiryMinutes * 60 * 1000;

        const depositRef = db.ref('deposits').push();
        const deposit = {
            id: depositRef.key,
            userId,
            amount,
            netAmount: amount - 1.68,
            fee: 1.68,
            method: 'korapay',
            reference: korapayData.reference,
            accountNumber: korapayData.account_number,
            bankName: korapayData.bank_name,
            accountName: korapayData.account_name,
            status: 'pending',
            date: new Date().toISOString(),
            expiryTime
        };
        await depositRef.set(deposit);

        res.json({
            depositId: deposit.id,
            accountNumber: deposit.accountNumber,
            bankName: deposit.bankName,
            accountName: deposit.accountName,
            reference: deposit.reference,
            expiryTime
        });
    } catch (error) {
        console.error('Korapay error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Payment initiation failed' });
    }
});

// 2. Korapay webhook (called when payment is received)
app.post('/api/korapay-webhook', async (req, res) => {
    const event = req.body;
    if (event.event === 'charge.success') {
        const reference = event.data.reference;
        const snapshot = await db.ref('deposits').orderByChild('reference').equalTo(reference).once('value');
        if (!snapshot.exists()) return res.status(404).send('Deposit not found');

        const depositKey = Object.keys(snapshot.val())[0];
        const deposit = snapshot.val()[depositKey];

        if (deposit.status === 'pending' && deposit.expiryTime > Date.now()) {
            await db.ref(`deposits/${depositKey}`).update({ status: 'approved' });
            const userRef = db.ref(`users/${deposit.userId}`);
            await userRef.transaction(user => {
                if (user) {
                    user.balance = (user.balance || 0) + deposit.netAmount;
                }
                return user;
            });
        }
    }
    res.sendStatus(200);
});

// 3. Place order
app.post('/api/orders', async (req, res) => {
    const { userId, serviceId, quantity, details } = req.body;
    if (!userId || !serviceId || !quantity || !details) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    const userSnapshot = await db.ref(`users/${userId}`).once('value');
    const user = userSnapshot.val();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const serviceSnapshot = await db.ref('services').orderByChild('id').equalTo(serviceId).once('value');
    if (!serviceSnapshot.exists()) return res.status(404).json({ error: 'Service not found' });
    const service = Object.values(serviceSnapshot.val())[0];

    const serviceCost = quantity * service.pricePerUnit;
    const total = serviceCost + 100; // platform fee

    if (user.balance < total) {
        return res.status(400).json({ error: 'Insufficient balance' });
    }

    await userSnapshot.ref.transaction(u => {
        if (u) u.balance -= total;
        return u;
    });

    const orderRef = db.ref('orders').push();
    const order = {
        id: orderRef.key,
        userId,
        username: user.username,
        serviceId,
        serviceName: service.name,
        quantity,
        pricePerUnit: service.pricePerUnit,
        serviceCost,
        platformFee: 100,
        total,
        details,
        status: 'pending',
        date: new Date().toISOString(),
        apiProcessed: false
    };
    await orderRef.set(order);

    if (orderApiSettings.enabled) {
        try {
            const apiResponse = await axios.post(orderApiSettings.endpoint, {
                orderId: order.id,
                service: service.name,
                quantity,
                details,
                username: user.username
            }, {
                headers: { Authorization: `Bearer ${orderApiSettings.apiKey}` },
                timeout: orderApiSettings.timeout * 1000
            });
            order.status = 'processing';
            order.apiProcessed = true;
            order.apiResponse = apiResponse.data;
        } catch (error) {
            console.error('Order API error:', error.message);
            order.apiResponse = { error: error.message };
        }
        await orderRef.update({ status: order.status, apiProcessed: order.apiProcessed, apiResponse: order.apiResponse });
    }

    res.json({ success: true, orderId: order.id, total });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));