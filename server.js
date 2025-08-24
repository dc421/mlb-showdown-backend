// server.js - FINAL, COMPLETE, UNABRIDGED VERSION

// Load environment variables from .env file
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const authenticateToken = require('./middleware/authenticateToken');

const app = express();
const PORT = process.env.PORT || 3001;

// --- Database Connection ---
const dbConfig = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
};

if (process.env.NODE_ENV === 'production') {
  dbConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(dbConfig);

// --- Middleware ---
app.use(express.json());

app.use((req, res, next) => {
  const allowedOrigins = [
    'https://willowy-griffin-457413.netlify.app',
    'http://localhost:5173'
  ];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// --- API Routes ---

// USER REGISTRATION
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ message: 'Username, email, and password are required.' });
  }
  try {
    const userCheck = await pool.query('SELECT * FROM users WHERE username = $1 OR email = $2', [username, email]);
    if (userCheck.rows.length > 0) {
      return res.status(409).json({ message: 'Username or email already exists.' });
    }
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const newUser = await pool.query(
      'INSERT INTO users (username, email, hashed_password) VALUES ($1, $2, $3) RETURNING user_id, username, email',
      [username, email, hashedPassword]
    );
    res.status(201).json({
      message: 'User registered successfully!',
      user: newUser.rows[0],
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'An error occurred on the server.' });
  }
});

// USER LOGIN
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
    }
    try {
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(401).json({ message: 'Invalid credentials.' });
        }
        const user = userResult.rows[0];
        const isMatch = await bcrypt.compare(password, user.hashed_password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials.' });
        }
        const payload = { userId: user.user_id, username: user.username };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '3h' });
        res.json({ message: 'Logged in successfully!', token: token });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'An error occurred on the server.' });
    }
});

// ROSTERS & CARDS
app.post('/api/rosters', authenticateToken, async (req, res) => {
    const { roster_name, card_ids } = req.body;
    const userId = req.user.userId;
    if (!roster_name || !card_ids || card_ids.length !== 20) {
        return res.status(400).json({ message: 'Roster must have a name and exactly 20 cards.' });
    }
    const client = await pool.connect();
    try {
        const cardsQuery = await client.query('SELECT card_id, points FROM cards_player WHERE card_id = ANY($1::int[])', [card_ids]);
        if (cardsQuery.rows.length !== 20) {
            return res.status(400).json({ message: 'One or more invalid card IDs were provided.' });
        }
        const totalPoints = cardsQuery.rows.reduce((sum, card) => sum + card.points, 0);
        if (totalPoints > 5000) {
            return res.status(400).json({ message: `Roster is over the 5000 point limit. Total: ${totalPoints}` });
        }
        await client.query('BEGIN');
        const newRoster = await client.query('INSERT INTO rosters (user_id, roster_name) VALUES ($1, $2) RETURNING roster_id', [userId, roster_name]);
        const rosterId = newRoster.rows[0].roster_id;
        for (const cardId of card_ids) {
            await client.query('INSERT INTO roster_cards (roster_id, card_id) VALUES ($1, $2)', [rosterId, cardId]);
        }
        await client.query('COMMIT');
        res.status(201).json({ message: 'Roster created successfully!', rosterId: rosterId });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Roster creation error:', error);
        res.status(500).json({ message: 'An error occurred on the server.' });
    } finally {
        client.release();
    }
});

app.get('/api/rosters', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    try {
        const rosters = await pool.query('SELECT roster_id, roster_name FROM rosters WHERE user_id = $1 ORDER BY roster_name', [userId]);
        res.json(rosters.rows);
    } catch (error) {
        console.error('Error fetching rosters:', error);
        res.status(500).json({ message: 'Server error while fetching rosters.' });
    }
});

app.get('/api/cards/player', authenticateToken, async (req, res) => {
    try {
        const allCards = await pool.query('SELECT card_id, name, team, positions, points, speed FROM cards_player ORDER BY name');
        res.json(allCards.rows);
    } catch (error) {
        console.error('Error fetching all player cards:', error);
        res.status(500).json({ message: 'Server error while fetching player cards.' });
    }
});

// GAME SETUP & PLAY
app.post('/api/games', authenticateToken, async (req, res) => {
    const { roster_id, home_or_away, league_designation } = req.body;
    const userId = req.user.userId;
    if (!roster_id || !home_or_away || !league_designation) {
        return res.status(400).json({ message: 'roster_id, home_or_away, and league_designation are required.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const newGame = await client.query(`INSERT INTO games (status) VALUES ('pending') RETURNING game_id`);
        const gameId = newGame.rows[0].game_id;
        await client.query(`INSERT INTO game_participants (game_id, user_id, roster_id, home_or_away, league_designation) VALUES ($1, $2, $3, $4, $5)`, [gameId, userId, roster_id, home_or_away, league_designation]);
        await client.query('COMMIT');
        res.status(201).json({ message: 'Game created and waiting for an opponent.', gameId: gameId });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Game creation error:', error);
        res.status(500).json({ message: 'Server error during game creation.' });
    } finally {
        client.release();
    }
});

app.post('/api/games/:gameId/join', authenticateToken, async (req, res) => {
    const { gameId } = req.params;
    const { roster_id } = req.body;
    const joiningUserId = req.user.userId;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const gameResult = await client.query('SELECT * FROM games WHERE game_id = $1', [gameId]);
        if (gameResult.rows.length === 0) return res.status(404).json({ message: 'Game not found.' });
        if (gameResult.rows[0].status !== 'pending') return res.status(400).json({ message: 'This game is not available to join.' });
        const participantsResult = await client.query('SELECT * FROM game_participants WHERE game_id = $1', [gameId]);
        if (participantsResult.rows.length >= 2) return res.status(400).json({ message: 'This game is already full.' });
        if (participantsResult.rows[0].user_id === joiningUserId) return res.status(400).json({ message: 'You cannot join your own game.' });
        const hostPlayerParticipant = participantsResult.rows[0];
        let homePlayer, awayPlayer;
        const joiningPlayerHomeOrAway = hostPlayerParticipant.home_or_away === 'home' ? 'away' : 'home';
        const joiningPlayerLeague = hostPlayerParticipant.league_designation === 'AL' ? 'NL' : 'AL';
        const joiningPlayerParticipant = { user_id: joiningUserId, roster_id: roster_id, home_or_away: joiningPlayerHomeOrAway, league_designation: joiningPlayerLeague };
        if (hostPlayerParticipant.home_or_away === 'home') {
            homePlayer = hostPlayerParticipant;
            awayPlayer = joiningPlayerParticipant;
        } else {
            homePlayer = joiningPlayerParticipant;
            awayPlayer = hostPlayerParticipant;
        }
        await client.query(`INSERT INTO game_participants (game_id, user_id, roster_id, home_or_away, league_designation) VALUES ($1, $2, $3, $4, $5)`, [gameId, joiningUserId, roster_id, joiningPlayerHomeOrAway, joiningPlayerLeague]);
        await client.query(`UPDATE games SET status = 'in_progress', current_turn_user_id = $1 WHERE game_id = $2`, [awayPlayer.user_id, gameId]);
        const initialGameState = { inning: 1, isTopInning: true, awayScore: 0, homeScore: 0, outs: 0, bases: { first: null, second: null, third: null }, awayTeam: { rosterId: awayPlayer.roster_id, userId: awayPlayer.user_id, battingOrderPosition: 0 }, homeTeam: { rosterId: homePlayer.roster_id, userId: homePlayer.user_id, battingOrderPosition: 0 }};
        await client.query(`INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)`, [gameId, 1, initialGameState]);
        await client.query('COMMIT');
        res.json({ message: 'Successfully joined game. The game is now in progress!' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Game join error:', error);
        res.status(500).json({ message: 'Server error while joining game.' });
    } finally {
        client.release();
    }
});

app.get('/api/games/:gameId', authenticateToken, async (req, res) => {
    const { gameId } = req.params;
    try {
        const stateResult = await pool.query('SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1', [gameId]);
        const eventsResult = await pool.query('SELECT * FROM game_events WHERE game_id = $1 ORDER BY "timestamp" ASC', [gameId]);
        if (stateResult.rows.length === 0) {
            return res.status(404).json({ message: 'Game state not found.' });
        }
        res.json({ gameState: stateResult.rows[0], gameEvents: eventsResult.rows });
    } catch (error) {
        console.error(`Error fetching game data for game ${gameId}:`, error);
        res.status(500).json({ message: 'Server error while fetching game data.' });
    }
});

app.post('/api/games/:gameId/play', authenticateToken, async (req, res) => {
    const { gameId } = req.params;
    const userId = req.user.userId;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const stateResult = await client.query('SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1', [gameId]);
        const currentState = stateResult.rows[0].state_data;
        const currentTurn = stateResult.rows[0].turn_number;
        const game = await client.query('SELECT * FROM games WHERE game_id = $1', [gameId]);
        if (game.rows[0].current_turn_user_id !== userId) {
            throw new Error("It's not your turn.");
        }
        const offensiveTeam = currentState.isTopInning ? currentState.awayTeam : currentState.homeTeam;
        const defensiveTeam = currentState.isTopInning ? currentState.homeTeam : currentState.awayTeam;
        const batterQuery = await client.query('SELECT cp.* FROM roster_cards rc JOIN cards_player cp ON rc.card_id = cp.card_id WHERE rc.roster_id = $1 AND cp.on_base IS NOT NULL LIMIT 1 OFFSET $2', [offensiveTeam.rosterId, offensiveTeam.battingOrderPosition]);
        const pitcherQuery = await client.query('SELECT cp.* FROM roster_cards rc JOIN cards_player cp ON rc.card_id = cp.card_id WHERE rc.roster_id = $1 AND cp.control IS NOT NULL LIMIT 1', [defensiveTeam.rosterId]);
        const batter = batterQuery.rows[0];
        const pitcher = pitcherQuery.rows[0];
        const pitchRoll = Math.floor(Math.random() * 20) + 1;
        const advantageCheck = pitchRoll + pitcher.control;
        const hasAdvantage = advantageCheck >= batter.on_base ? 'pitcher' : 'batter';
        const swingRoll = Math.floor(Math.random() * 20) + 1;
        const chartHolder = hasAdvantage === 'pitcher' ? pitcher : batter;
        let outcome = 'OUT';
        for (const range in chartHolder.chart_data) {
            const [min, max] = range.split('-').map(Number);
            if (swingRoll >= min && swingRoll <= max) {
                outcome = chartHolder.chart_data[range];
                break;
            }
        }
        const logMessage = `${batter.name} gets a ${outcome}!`;
        const newState = JSON.parse(JSON.stringify(currentState));
        newState.outs++;
        offensiveTeam.battingOrderPosition++;
        if (newState.outs >= 3) {
            newState.isTopInning = !newState.isTopInning;
            if (newState.isTopInning) newState.inning++;
            newState.outs = 0;
        }
        await client.query(`INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)`, [gameId, currentTurn + 1, newState]);
        await client.query(`INSERT INTO game_events (game_id, user_id, turn_number, event_type, log_message) VALUES ($1, $2, $3, $4, $5)`, [gameId, userId, currentTurn + 1, 'at_bat', logMessage]);
        const nextTurnUserId = defensiveTeam.userId;
        await client.query('UPDATE games SET current_turn_user_id = $1 WHERE game_id = $2', [nextTurnUserId, gameId]);
        await client.query('COMMIT');
        res.json({ message: 'Turn played', newGameState: newState, log: logMessage });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Error playing turn for game ${gameId}:`, error);
        res.status(500).json({ message: 'Server error while playing turn.' });
    } finally {
        client.release();
    }
});

// TEST ROUTE
app.get('/api/test', async (req, res) => {
    try {
        const dbTime = await pool.query('SELECT NOW()');
        res.json({ message: 'API server is running and connected to the database!', dbTime: dbTime.rows[0].now });
    } catch (error) {
        console.error('Database connection test failed:', error);
        res.status(500).json({ message: 'Error connecting to the database.' });
    }
});


// --- Server Startup Function ---
async function startServer() {
  try {
    // Wait for the database connection to be established
    await pool.query('SELECT NOW()');
    console.log('✅ Database connection successful!');

    // Only start listening for requests AFTER the database is ready
    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });

  } catch (error) {
    console.error('❌ DATABASE CONNECTION FAILED:', error);
    process.exit(1);
  }
}

// --- Run the Server ---
startServer();