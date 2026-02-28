require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const JWT_SECRET = process.env.JWT_SECRET || 'tkclub_secret_2024';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const PORT = process.env.PORT || 3000;

// ─── DATABASE SETUP ───────────────────────────────────────────
const db = new Database('./tkclub.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    mobile TEXT,
    password TEXT NOT NULL,
    balance REAL DEFAULT 100.0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS game_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT NOT NULL,
    number INTEGER NOT NULL,
    size TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    period TEXT NOT NULL,
    bet TEXT NOT NULL,
    amount REAL NOT NULL,
    result INTEGER,
    status TEXT DEFAULT 'pending',
    payout REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ─── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── AUTH MIDDLEWARE ───────────────────────────────────────────
function authUser(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function authAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Not admin' });
    req.admin = decoded;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── GAME ENGINE ───────────────────────────────────────────────
let currentPeriod = Date.now();
let timeLeft = 30;
let nextForcedResult = null;

function getColor(n) {
  if (n === 0) return 'red_violet';
  if (n === 5) return 'green_violet';
  return n % 2 === 0 ? 'red' : 'green';
}

function checkWin(bet, result) {
  const color = getColor(result);
  if (bet === String(result)) return true;
  if (bet === 'Green' && (result % 2 !== 0)) return true;
  if (bet === 'Red' && (result % 2 === 0)) return true;
  if (bet === 'Violet' && (result === 0 || result === 5)) return true;
  if (bet === 'Big' && result >= 5) return true;
  if (bet === 'Small' && result < 5) return true;
  return false;
}

function getMultiplier(bet) {
  if (['Green', 'Red', 'Big', 'Small'].includes(bet)) return 2;
  if (bet === 'Violet') return 4.5;
  return 9; // number bet
}

function resolvePeriod(period, result) {
  const pendingBets = db.prepare("SELECT * FROM bets WHERE period = ? AND status = 'pending'").all(period);
  const updateBet = db.prepare("UPDATE bets SET status=?, result=?, payout=? WHERE id=?");
  const updateBalance = db.prepare("UPDATE users SET balance = balance + ? WHERE id=?");

  const resolveTx = db.transaction(() => {
    for (const bet of pendingBets) {
      const won = checkWin(bet.bet, result);
      const payout = won ? bet.amount * getMultiplier(bet.bet) : 0;
      updateBet.run(won ? 'win' : 'lose', result, payout, bet.id);
      if (won) updateBalance.run(payout, bet.user_id);
    }
  });
  resolveTx();
}

// ─── GAME TIMER ────────────────────────────────────────────────
function startGameTimer() {
  setInterval(() => {
    timeLeft--;

    if (timeLeft <= 0) {
      // Check for admin-forced result
      const forced = db.prepare("SELECT value FROM settings WHERE key='next_result'").get();
      let result;
      if (forced && forced.value !== null) {
        result = parseInt(forced.value);
        db.prepare("DELETE FROM settings WHERE key='next_result'").run();
        nextForcedResult = null;
      } else {
        result = Math.floor(Math.random() * 10);
      }

      const size = result >= 5 ? 'Big' : 'Small';
      const color = getColor(result);
      const periodStr = String(currentPeriod);

      // Save to history
      db.prepare("INSERT INTO game_history (period, number, size, color) VALUES (?,?,?,?)").run(periodStr, result, size, color);

      // Resolve bets
      resolvePeriod(periodStr, result);

      // Broadcast result to all connected clients
      broadcast({
        type: 'ROUND_RESULT',
        period: periodStr,
        number: result,
        size,
        color,
        nextPeriod: currentPeriod + 1
      });

      currentPeriod++;
      timeLeft = 30;
    }

    // Broadcast timer every second
    broadcast({ type: 'TIMER', timeLeft, period: String(currentPeriod) });

  }, 1000);
}

// ─── WEBSOCKET ─────────────────────────────────────────────────
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);

  // Send current state immediately
  ws.send(JSON.stringify({
    type: 'INIT',
    timeLeft,
    period: String(currentPeriod),
    history: db.prepare("SELECT * FROM game_history ORDER BY id DESC LIMIT 20").all()
  }));

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// ─── USER ROUTES ───────────────────────────────────────────────

// Register
app.post('/api/register', async (req, res) => {
  const { username, mobile, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const stmt = db.prepare("INSERT INTO users (username, mobile, password, balance) VALUES (?,?,?,?)");
    const info = stmt.run(username, mobile || '', hash, 100.0);
    const token = jwt.sign({ id: info.lastInsertRowid, username, role: 'user' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: info.lastInsertRowid, username, balance: 100.0 } });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username=?").get(username);
  if (!user) return res.status(400).json({ error: 'User not found' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).json({ error: 'Wrong password' });

  const token = jwt.sign({ id: user.id, username: user.username, role: 'user' }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ success: true, token, user: { id: user.id, username: user.username, balance: user.balance } });
});

// Get my balance
app.get('/api/me', authUser, (req, res) => {
  const user = db.prepare("SELECT id, username, mobile, balance, created_at FROM users WHERE id=?").get(req.user.id);
  res.json(user);
});

// Place bet
app.post('/api/bet', authUser, (req, res) => {
  const { bet, amount } = req.body;
  if (!bet || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid bet' });
  if (timeLeft <= 3) return res.status(400).json({ error: 'Betting closed! Round ending...' });

  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if (!user || user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  db.prepare("UPDATE users SET balance = balance - ? WHERE id=?").run(amount, user.id);
  db.prepare("INSERT INTO bets (user_id, username, period, bet, amount) VALUES (?,?,?,?,?)").run(
    user.id, user.username, String(currentPeriod), bet, amount
  );

  const newBal = db.prepare("SELECT balance FROM users WHERE id=?").get(user.id);
  res.json({ success: true, balance: newBal.balance });
});

// My bet history
app.get('/api/my-bets', authUser, (req, res) => {
  const bets = db.prepare("SELECT * FROM bets WHERE user_id=? ORDER BY id DESC LIMIT 30").all(req.user.id);
  res.json(bets);
});

// Game history (public)
app.get('/api/history', (req, res) => {
  const history = db.prepare("SELECT * FROM game_history ORDER BY id DESC LIMIT 30").all();
  res.json(history);
});

// ─── ADMIN ROUTES ──────────────────────────────────────────────

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS || 'admin123';
  if (username !== adminUser || password !== adminPass) return res.status(401).json({ error: 'Wrong credentials' });
  const token = jwt.sign({ role: 'admin', username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, token });
});

// Set next result
app.post('/api/admin/set-result', authAdmin, (req, res) => {
  const { number } = req.body;
  if (number === undefined || number < 0 || number > 9) return res.status(400).json({ error: 'Invalid number' });
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('next_result', ?)").run(String(number));
  broadcast({ type: 'ADMIN_LOCKED', number });
  res.json({ success: true, message: `Next result locked: ${number}` });
});

// Clear forced result
app.delete('/api/admin/set-result', authAdmin, (req, res) => {
  db.prepare("DELETE FROM settings WHERE key='next_result'").run();
  broadcast({ type: 'ADMIN_CLEARED' });
  res.json({ success: true });
});

// Get all users
app.get('/api/admin/users', authAdmin, (req, res) => {
  const users = db.prepare("SELECT id, username, mobile, balance, created_at FROM users ORDER BY id DESC").all();
  res.json(users);
});

// Update user balance
app.post('/api/admin/users/:id/balance', authAdmin, (req, res) => {
  const { action, amount } = req.body;
  const userId = req.params.id;
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let newBalance;
  if (action === 'add') newBalance = user.balance + parseFloat(amount);
  else if (action === 'sub') newBalance = Math.max(0, user.balance - parseFloat(amount));
  else if (action === 'set') newBalance = parseFloat(amount);
  else return res.status(400).json({ error: 'Invalid action' });

  db.prepare("UPDATE users SET balance=? WHERE id=?").run(newBalance, userId);
  res.json({ success: true, balance: newBalance });
});

// Delete user
app.delete('/api/admin/users/:id', authAdmin, (req, res) => {
  db.prepare("DELETE FROM users WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// Get all bets
app.get('/api/admin/bets', authAdmin, (req, res) => {
  const { status, username } = req.query;
  let query = "SELECT * FROM bets WHERE 1=1";
  const params = [];
  if (status) { query += " AND status=?"; params.push(status); }
  if (username) { query += " AND username LIKE ?"; params.push('%' + username + '%'); }
  query += " ORDER BY id DESC LIMIT 100";
  const bets = db.prepare(query).all(...params);
  res.json(bets);
});

// Get game history (admin)
app.get('/api/admin/history', authAdmin, (req, res) => {
  const history = db.prepare("SELECT * FROM game_history ORDER BY id DESC LIMIT 100").all();
  res.json(history);
});

// Get stats
app.get('/api/admin/stats', authAdmin, (req, res) => {
  const totalUsers = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  const totalBets = db.prepare("SELECT COUNT(*) as c FROM bets").get().c;
  const totalRounds = db.prepare("SELECT COUNT(*) as c FROM game_history").get().c;
  const totalBetAmount = db.prepare("SELECT SUM(amount) as s FROM bets").get().s || 0;
  const wins = db.prepare("SELECT COUNT(*) as c FROM bets WHERE status='win'").get().c;
  const losses = db.prepare("SELECT COUNT(*) as c FROM bets WHERE status='lose'").get().c;
  const pending = db.prepare("SELECT COUNT(*) as c FROM bets WHERE status='pending'").get().c;
  const nextResult = db.prepare("SELECT value FROM settings WHERE key='next_result'").get();

  res.json({ totalUsers, totalBets, totalRounds, totalBetAmount, wins, losses, pending, nextResult: nextResult?.value ?? null });
});

// Clear history
app.delete('/api/admin/history', authAdmin, (req, res) => {
  db.prepare("DELETE FROM game_history").run();
  res.json({ success: true });
});

// ─── START ─────────────────────────────────────────────────────
startGameTimer();

server.listen(PORT, () => {
  console.log(`✅ TKCLUB Server running on port ${PORT}`);
  console.log(`🌐 Open: http://localhost:${PORT}`);
  console.log(`🔐 Admin: http://localhost:${PORT}/admin.html`);
});
