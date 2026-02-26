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

// ==================== EXOSUPPLIER CONFIG ====================
const EXOSUPPLIER_API_KEY = process.env.EXOSUPPLIER_API_KEY;
const EXOSUPPLIER_API_URL = process.env.EXOSUPPLIER_API_URL; // e.g., https://exosupplier.com/api/v2

// ==================== KORAPAY ENDPOINTS ====================

// 1. Generate Korapay virtual account
app.post('/api/korapay/generate', async (req, res) => {
    const { userId, amount } = req.body;
    if (!userId || !amount || amount < 100) {
        return res.status(400).json({ error: 'Invalid amount or user' });
    }

    // Get user email from Firebase (you need to implement this)
    const userSnapshot = await db.ref(`users/${userId}`).once('value');
    const user = userSnapshot.val();
    if (!user) return res.status(404).json({ error: 'User not found' });

    try {
       // 1. Generate Korapay virtual account
app.post('/api/korapay/generate', async (req, res) => {
    const { userId, amount } = req.body;
    if (!userId || !amount || amount < 100) {
        return res.status(400).json({ error: 'Invalid amount or user' });
    }

    // Get user from Firebase to get email/name
    const userSnapshot = await db.ref(`users/${userId}`).once('value');
    const user = userSnapshot.val();
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Generate a unique reference
    const uniqueReference = `DEP_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;

    try {
        const response = await axios.post('https://api.korapay.com/v1/merchant/api/v1/virtual-accounts', {
            amount,
            currency: 'NGN',
            reference: uniqueReference,          // now defined!
            redirect_url: 'https://fastplug.netlify.app/',
            customer: {
                name: user.username || 'User',
                email: user.email || 'user@example.com'
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

// ==================== ORDER ENDPOINT WITH EXOSUPPLIER ====================

app.post('/api/orders', async (req, res) => {
    const { userId, serviceId, quantity, details } = req.body;
    if (!userId || !serviceId || !quantity || !details) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    // 1. Get user from Firebase
    const userSnapshot = await db.ref(`users/${userId}`).once('value');
    const user = userSnapshot.val();
    if (!user) return res.status(404).json({ error: 'User not found' });

    // 2. Get service from Firebase
    const serviceSnapshot = await db.ref('services').orderByChild('id').equalTo(serviceId).once('value');
    if (!serviceSnapshot.exists()) return res.status(404).json({ error: 'Service not found' });
    const service = Object.values(serviceSnapshot.val())[0];

    // 3. Calculate cost
    const serviceCost = quantity * service.pricePerUnit;
    const total = serviceCost + 100; // platform fee

    // 4. Check balance
    if (user.balance < total) {
        return res.status(400).json({ error: 'Insufficient balance' });
    }

    // 5. Deduct balance FIRST (atomic operation)
    await userSnapshot.ref.transaction(u => {
        if (u) u.balance -= total;
        return u;
    });

    // 6. Prepare Exosupplier order
    // IMPORTANT: Your service must have a field 'exosupplierServiceId' stored in Firebase.
    // If not, you need to add it manually.
    const exosupplierServiceId = service.exosupplierServiceId;
    if (!exosupplierServiceId) {
        // No mapping – refund user and exit
        await userSnapshot.ref.transaction(u => {
            if (u) u.balance += total;
            return u;
        });
        return res.status(500).json({ error: 'Service not mapped to provider' });
    }

    // Build form data for Exosupplier
    const formBody = new URLSearchParams();
    formBody.append('key', EXOSUPPLIER_API_KEY);
    formBody.append('action', 'add');
    formBody.append('service', exosupplierServiceId);
    formBody.append('link', details);
    formBody.append('quantity', quantity);

    try {
        const exoResponse = await axios.post(EXOSUPPLIER_API_URL, formBody.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 30000 // 30 seconds
        });

        const exoData = exoResponse.data;

        // Check if Exosupplier returned an order ID
        if (exoData.order) {
            // Success – save order with external ID
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
                status: 'processing', // Exosupplier accepted it
                externalOrderId: exoData.order, // Store Exosupplier's order ID
                date: new Date().toISOString(),
                apiProcessed: true
            };
            await orderRef.set(order);

            return res.json({ success: true, orderId: order.id, total });
        } else {
            // Exosupplier returned an error – refund user
            await userSnapshot.ref.transaction(u => {
                if (u) u.balance += total;
                return u;
            });
            console.error('Exosupplier error:', exoData);
            return res.status(500).json({ error: 'Provider error – your funds have been refunded' });
        }
    } catch (error) {
        // Network error or exception – refund user
        await userSnapshot.ref.transaction(u => {
            if (u) u.balance += total;
            return u;
        });
        console.error('Error calling Exosupplier:', error.message);
        return res.status(500).json({ error: 'System error – your funds have been refunded' });
    }
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));