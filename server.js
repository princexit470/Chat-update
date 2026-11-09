const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// Firebase Admin SDK initialize (service account key se)
// Render pe environment variable use karo, local pe file path
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://notes-69142-default-rtdb.firebaseio.com"
});

const app = express();
app.use(cors());
app.use(express.json());

// Simple in-memory user store (production mein database use karo)
// Demo ke liye username -> { password, uid, boundDeviceId }
const users = {};

// Register endpoint
app.post('/register', async (req, res) => {
  const { username, password, deviceId, deviceName } = req.body;
  
  if (!username || !password || !deviceId) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  
  if (users[username]) {
    return res.status(400).json({ error: 'Username already taken' });
  }
  
  // Create Firebase user with custom UID
  const uid = 'user_' + username + '_' + Date.now();
  
  try {
    // Create custom token
    const customToken = await admin.auth().createCustomToken(uid);
    
    // Save user data
    users[username] = {
      password: password, // Production mein hash karo!
      uid: uid,
      boundDeviceId: deviceId,
      boundDeviceName: deviceName,
      recoveryCode: Math.floor(100000000000 + Math.random() * 900000000000).toString()
    };
    
    // Also save to Firebase Database for persistence
    await admin.database().ref('users/' + username).set({
      uid: uid,
      boundDeviceId: deviceId,
      boundDeviceName: deviceName,
      recoveryCode: users[username].recoveryCode,
      createdAt: Date.now()
    });
    
    res.json({
      success: true,
      token: customToken,
      uid: uid,
      recoveryCode: users[username].recoveryCode
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Login endpoint
app.post('/login', async (req, res) => {
  const { username, password, deviceId, deviceName } = req.body;
  
  if (!username || !password || !deviceId) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  
  const user = users[username];
  
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  // Check device binding
  if (user.boundDeviceId === deviceId) {
    // Same device - allow
    const token = await admin.auth().createCustomToken(user.uid);
    return res.json({ success: true, token: token, uid: user.uid });
  } else {
    // Different device - need approval
    // Generate security code and save to Firebase
    const securityCode = Math.floor(100000 + Math.random() * 900000).toString();
    
    await admin.database().ref('device_approval/' + user.uid).set({
      pendingDeviceId: deviceId,
      pendingDeviceName: deviceName,
      securityCode: securityCode,
      requestedAt: Date.now(),
      status: 'pending'
    });
    
    return res.json({
      requiresApproval: true,
      securityCode: securityCode, // Old device ko dikhana hai
      message: 'New device approval required. Check your old device for security code.'
    });
  }
});

// Verify approval code (new device)
app.post('/verify-approval', async (req, res) => {
  const { username, deviceId, deviceName, code } = req.body;
  
  const user = users[username];
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const approvalSnap = await admin.database().ref('device_approval/' + user.uid).once('value');
  const approval = approvalSnap.val();
  
  if (!approval || approval.securityCode !== code) {
    return res.status(401).json({ error: 'Invalid code' });
  }
  
  // Approve - update bound device
  user.boundDeviceId = deviceId;
  user.boundDeviceName = deviceName;
  
  await admin.database().ref('users/' + username).update({
    boundDeviceId: deviceId,
    boundDeviceName: deviceName
  });
  
  await admin.database().ref('device_approval/' + user.uid + '/status').set('approved');
  
  const token = await admin.auth().createCustomToken(user.uid);
  res.json({ success: true, token: token, uid: user.uid });
});

// Check approval status (new device polls this)
app.get('/approval-status/:username', async (req, res) => {
  const { username } = req.params;
  const user = users[username];
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const approvalSnap = await admin.database().ref('device_approval/' + user.uid + '/status').once('value');
  res.json({ status: approvalSnap.val() || 'pending' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`XIT backend running on port ${PORT}`));
