const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// ==========================================
// FIREBASE ADMIN SETUP (Render Environment se)
// ==========================================
try {
  let serviceAccount;
  const envKey = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!envKey) {
    console.error("❌ ERROR: FIREBASE_SERVICE_ACCOUNT environment variable missing!");
  } else {
    // Render mein JSON string ke roop mein hota hai, usko parse karo
    serviceAccount = JSON.parse(envKey);
    
    // Sabse bada error yahan hota hai: private_key mein \n ki jagah \\n hota hai
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://notes-69142-default-rtdb.firebaseio.com"
  });
  console.log("✅ Firebase Admin Initialized Successfully");
} catch (error) {
  console.error("❌ Firebase Init Error:", error.message);
}

const app = express();
app.use(cors());
app.use(express.json());

// In-memory users store (Render restart hone par clear ho jayega, isliye Firebase DB mein save kar rahe hain)
const users = {};

// ==========================================
// REGISTER API
// ==========================================
app.post('/register', async (req, res) => {
  const { username, password, deviceId, deviceName } = req.body;
  
  if (!username || !password || !deviceId) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  
  if (users[username]) {
    return res.status(400).json({ error: 'Username already taken' });
  }
  
  try {
    const uid = 'user_' + username + '_' + Date.now();
    const customToken = await admin.auth().createCustomToken(uid);
    
    const recoveryCode = Math.floor(100000000000 + Math.random() * 900000000000).toString();
    
    users[username] = {
      password: password,
      uid: uid,
      boundDeviceId: deviceId,
      boundDeviceName: deviceName,
      recoveryCode: recoveryCode
    };
    
    // Firebase Realtime Database mein save karo
    await admin.database().ref('users/' + username).set({
      uid: uid,
      boundDeviceId: deviceId,
      boundDeviceName: deviceName,
      recoveryCode: recoveryCode,
      password: password, // Note: Production mein hash karna!
      createdAt: Date.now()
    });
    
    res.json({
      success: true,
      token: customToken,
      uid: uid,
      recoveryCode: recoveryCode
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// LOGIN API
// ==========================================
app.post('/login', async (req, res) => {
  const { username, password, deviceId, deviceName } = req.body;
  
  if (!username || !password || !deviceId) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  
  try {
    // Agar memory mein nahi hai, Firebase se fetch karo
    if (!users[username]) {
      const snap = await admin.database().ref('users/' + username).once('value');
      if (snap.exists()) {
        users[username] = snap.val();
      }
    }

    const user = users[username];
    
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Check device binding
    if (user.boundDeviceId === deviceId) {
      const token = await admin.auth().createCustomToken(user.uid);
      return res.json({ success: true, token: token, uid: user.uid });
    } else {
      // Naya device - approval generate karo
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
        securityCode: securityCode,
        message: 'New device approval required.'
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// VERIFY APPROVAL API
// ==========================================
app.post('/verify-approval', async (req, res) => {
  const { username, deviceId, deviceName, code } = req.body;
  
  try {
    if (!users[username]) {
      const snap = await admin.database().ref('users/' + username).once('value');
      if (snap.exists()) users[username] = snap.val();
    }

    const user = users[username];
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const approvalSnap = await admin.database().ref('device_approval/' + user.uid).once('value');
    const approval = approvalSnap.val();
    
    if (!approval || approval.securityCode !== code) {
      return res.status(401).json({ error: 'Invalid code' });
    }
    
    user.boundDeviceId = deviceId;
    user.boundDeviceName = deviceName;
    
    await admin.database().ref('users/' + username).update({
      boundDeviceId: deviceId,
      boundDeviceName: deviceName
    });
    
    await admin.database().ref('device_approval/' + user.uid + '/status').set('approved');
    
    const token = await admin.auth().createCustomToken(user.uid);
    res.json({ success: true, token: token, uid: user.uid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// APPROVAL STATUS API
// ==========================================
app.get('/approval-status/:username', async (req, res) => {
  const { username } = req.params;
  try {
    if (!users[username]) {
      const snap = await admin.database().ref('users/' + username).once('value');
      if (snap.exists()) users[username] = snap.val();
    }

    const user = users[username];
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const approvalSnap = await admin.database().ref('device_approval/' + user.uid + '/status').once('value');
    res.json({ status: approvalSnap.val() || 'pending' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 XIT backend running on port ${PORT}`));
