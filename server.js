// server.js - FINAL, COMPLETE, UNABRIDGED VERSION

// Load environment variables from .env file
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const http = require('http'); // <-- ADD THIS
const { Server } = require("socket.io"); // <-- ADD THIS
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const authenticateToken = require('./middleware/authenticateToken');
const { applyOutcome } = require('./gameLogic');

const app = express();
const server = http.createServer(app); // <-- CREATE HTTP SERVER
const io = new Server(server, { // <-- INITIALIZE SOCKET.IO
  cors: {
    origin: ["http://localhost:5173", "https://willowy-griffin-457413.netlify.app"],
    methods: ["GET", "POST"]
  }
});
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
// CREATE A NEW ROSTER (Protected Route with validation)
// CREATE A NEW ROSTER (with advanced validation)
app.post('/api/rosters', authenticateToken, async (req, res) => {
    const { roster_name, card_ids } = req.body;
    const userId = req.user.userId;

    if (!roster_name || !card_ids || card_ids.length !== 20) {
        return res.status(400).json({ message: 'Roster must have a name and exactly 20 cards.' });
    }

    const client = await pool.connect();
    try {
        const cardsQuery = await client.query('SELECT card_id, points, positions, ip FROM cards_player WHERE card_id = ANY($1::int[])', [card_ids]);
        const cards = cardsQuery.rows;

        if (cards.length !== 20) {
            return res.status(400).json({ message: 'One or more invalid card IDs were provided.' });
        }

        // --- NEW, ADVANCED POSITION VALIDATION LOGIC ---
        const startingPitchers = cards.filter(c => c.ip > 3);
        const positionPlayers = cards.filter(c => c.ip <= 3);

        const positionCounts = { C: 0, '2B': 0, SS: 0, '3B': 0, CF: 0, LFRF: 0 };
        positionPlayers.forEach(card => {
            if (card.positions.includes('C')) positionCounts.C++;
            if (card.positions.includes('2B')) positionCounts['2B']++;
            if (card.positions.includes('SS')) positionCounts.SS++;
            if (card.positions.includes('3B')) positionCounts['3B']++;
            if (card.positions.includes('CF')) positionCounts.CF++;
            if (card.positions.includes('LF') || card.positions.includes('RF')) positionCounts.LFRF++;
        });

        const errors = [];
        if (startingPitchers.length < 4) errors.push('You need at least 4 Starting Pitchers (IP > 3).');
        if (positionPlayers.length < 9) errors.push('You need at least 9 position players for a valid lineup.');
        if (positionCounts.C < 1) errors.push('You need at least 1 Catcher.');
        if (positionCounts['2B'] < 1) errors.push('You need at least 1 Second Baseman.');
        if (positionCounts.SS < 1) errors.push('You need at least 1 Shortstop.');
        if (positionCounts['3B'] < 1) errors.push('You need at least 1 Third Baseman.');
        if (positionCounts.CF < 1) errors.push('You need at least 1 Center Fielder.');
        if (positionCounts.LFRF < 2) errors.push('You need at least 2 LF/RF.');

        if (errors.length > 0) {
            return res.status(400).json({ message: 'Invalid roster composition.', errors: errors });
        }

        // Point validation remains the same
        const totalPoints = cards.reduce((sum, card) => sum + card.points, 0);
        if (totalPoints > 5000) {
            return res.status(400).json({ message: `Roster is over the 5000 point limit. Total: ${totalPoints}` });
        }

        // --- SAVE TO DATABASE ---
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

// SET A PLAYER'S LINEUP FOR A GAME (Protected Route)
app.post('/api/games/:gameId/lineup', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const userId = req.user.userId;
  const { battingOrder, startingPitcher } = req.body; // Expecting { battingOrder: [card_id, ...], startingPitcher: card_id }

  // Basic Validation
  if (!battingOrder || battingOrder.length !== 9 || !startingPitcher) {
    return res.status(400).json({ message: 'A valid lineup requires 9 batters and 1 starting pitcher.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update the lineup for this participant
    await client.query(
      `UPDATE game_participants SET lineup = $1 WHERE game_id = $2 AND user_id = $3`,
      [{ battingOrder, startingPitcher }, gameId, userId]
    );

    // Check if both players have now submitted lineups
    const lineupCheck = await client.query('SELECT lineup FROM game_participants WHERE game_id = $1', [gameId]);
    if (lineupCheck.rows.length === 2 && lineupCheck.rows.every(p => p.lineup !== null)) {
      // Both players have set lineups, start the game!

      const participants = await client.query('SELECT user_id, home_or_away FROM game_participants WHERE game_id = $1', [gameId]);
      const awayPlayer = participants.rows.find(p => p.home_or_away === 'away');

      await client.query(
        `UPDATE games SET status = 'in_progress', current_turn_user_id = $1 WHERE game_id = $2`,
        [awayPlayer.user_id, gameId]
      );

      // You could also create the initial game state here as we did in the 'join' endpoint before
    }

    await client.query('COMMIT');
    res.status(200).json({ message: 'Lineup saved successfully.' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error setting lineup:', error);
    res.status(500).json({ message: 'Server error while setting lineup.' });
  } finally {
    client.release();
  }
});

// GET A SPECIFIC ROSTER AND ITS CARDS (Protected Route)
app.get('/api/rosters/:rosterId', authenticateToken, async (req, res) => {
  const { rosterId } = req.params;
  try {
    const rosterCards = await pool.query(
      `SELECT cp.* FROM cards_player cp 
       JOIN roster_cards rc ON cp.card_id = rc.card_id 
       WHERE rc.roster_id = $1`,
      [rosterId]
    );
    res.json(rosterCards.rows);
  } catch (error) {
    console.error(`Error fetching roster ${rosterId}:`, error);
    res.status(500).json({ message: 'Server error fetching roster details.' });
  }
});

// GET ALL PENDING GAMES (Protected Route)
app.get('/api/games/open', authenticateToken, async (req, res) => {
  try {
    // We also fetch the username of the player who created the game
    // In GET /api/games/open
const openGames = await pool.query(
  `SELECT g.game_id, u.username as host_username FROM games g 
   JOIN game_participants gp ON g.game_id = gp.game_id
   JOIN users u ON gp.user_id = u.user_id
   WHERE g.status = 'pending' AND 
   (SELECT COUNT(*) FROM game_participants WHERE game_id = g.game_id) = 1`
);
    res.json(openGames.rows);
  } catch (error) {
    console.error('Error fetching open games:', error);
    res.status(500).json({ message: 'Server error while fetching open games.' });
  }
});

// GET ALL GAMES FOR A USER (Protected Route)
app.get('/api/games', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  try {
    const gamesResult = await pool.query(
      `SELECT g.game_id, g.status, g.current_turn_user_id, gp.roster_id
       FROM games g JOIN game_participants gp ON g.game_id = gp.game_id 
       WHERE gp.user_id = $1 ORDER BY g.created_at DESC`,
      [userId]
    );
    res.json(gamesResult.rows);
  } catch (error) {
    console.error('Error fetching user games:', error);
    res.status(500).json({ message: 'Server error while fetching games.' });
  }
});

app.get('/api/cards/player', authenticateToken, async (req, res) => {
    try {
        const allCards = await pool.query(
  'SELECT card_id, name, team, positions, points, speed, ip, control FROM cards_player ORDER BY name'
);
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
        io.emit('games-updated'); // <-- ADD THIS LINE
        res.status(201).json({ message: 'Game created and waiting for an opponent.', gameId: gameId });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Game creation error:', error);
        res.status(500).json({ message: 'Server error during game creation.' });
    } finally {
        client.release();
    }
});

// SET UP GAME DETAILS (HOME TEAM, DH RULE)
app.post('/api/games/:gameId/setup', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const { homeTeamUserId, useDh } = req.body;

  try {
    await pool.query(
      `UPDATE games SET home_team_user_id = $1, use_dh = $2 WHERE game_id = $3`,
      [homeTeamUserId, useDh, gameId]
    );
    // ADD THIS LINE to notify clients
  io.to(gameId).emit('setup-updated');
    res.status(200).json({ message: 'Game setup complete.' });
  } catch (error) {
    console.error('Error in game setup:', error);
    res.status(500).json({ message: 'Server error during game setup.' });
  }
});

// GET SETUP STATE FOR A SPECIFIC GAME (PARTICIPANTS AND ROLLS)
app.get('/api/games/:gameId/setup', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  try {
    const gameQuery = await pool.query('SELECT setup_rolls FROM games WHERE game_id = $1', [gameId]);
    const participantsQuery = await pool.query(
      `SELECT gp.user_id, u.username FROM game_participants gp
       JOIN users u ON gp.user_id = u.user_id
       WHERE gp.game_id = $1`,
      [gameId]
    );
    res.json({
        rolls: gameQuery.rows[0].setup_rolls || {},
        participants: participantsQuery.rows
    });
  } catch (error) {
    console.error(`Error fetching setup for game ${gameId}:`, error);
    res.status(500).json({ message: 'Server error while fetching setup data.' });
  }
});

// ROLL FOR HOME TEAM CHOICE
app.post('/api/games/:gameId/roll', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const userId = req.user.userId;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const gameQuery = await client.query('SELECT setup_rolls FROM games WHERE game_id = $1', [gameId]);
    let rolls = gameQuery.rows[0].setup_rolls || {};

    // Generate and store the roll if the user hasn't rolled yet
    if (!rolls[userId]) {
        rolls[userId] = Math.floor(Math.random() * 20) + 1;
    }

    await client.query('UPDATE games SET setup_rolls = $1 WHERE game_id = $2', [rolls, gameId]);
    await client.query('COMMIT');

    // Notify the room that the setup state has changed
    io.to(gameId).emit('setup-updated');
    res.sendStatus(200);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error during roll:', error);
    res.status(500).json({ message: 'Server error during roll.' });
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
        const initialGameState = { inning: 1, isTopInning: true, awayScore: 0, homeScore: 0, outs: 0, bases: { first: null, second: null, third: null }, awayTeam: { rosterId: awayPlayer.roster_id, userId: awayPlayer.user_id, battingOrderPosition: 0 }, homeTeam: { rosterId: homePlayer.roster_id, userId: homePlayer.user_id, battingOrderPosition: 0 }};
        await client.query(`INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)`, [gameId, 1, initialGameState]);
        await client.query('COMMIT');
        io.emit('games-updated');
        res.json({ message: 'Successfully joined game. The game is now in progress!' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Game join error:', error);
        res.status(500).json({ message: 'Server error while joining game.' });
    } finally {
        client.release();
    }
});

// GET A SPECIFIC GAME'S STATE AND EVENTS (Now includes active players)
app.get('/api/games/:gameId', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  try {
    const gameResult = await pool.query('SELECT * FROM games WHERE game_id = $1', [gameId]);
    if (gameResult.rows.length === 0) {
      return res.status(404).json({ message: 'Game not found.' });
    }
    const game = gameResult.rows[0];

    const stateResult = await pool.query(
      'SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1',
      [gameId]
    );
    const eventsResult = await pool.query(
      'SELECT * FROM game_events WHERE game_id = $1 ORDER BY "timestamp" ASC',
      [gameId]
    );

    if (stateResult.rows.length === 0) {
      return res.status(404).json({ message: 'Game state not found.' });
    }
    
    const currentState = stateResult.rows[0].state_data;

    // --- NEW LOGIC TO FIND AND ATTACH PLAYER CARDS ---
    const offensiveTeam = currentState.isTopInning ? currentState.awayTeam : currentState.homeTeam;
    const defensiveTeam = currentState.isTopInning ? currentState.homeTeam : currentState.awayTeam;
    
    const batterQuery = await pool.query('SELECT * FROM cards_player WHERE card_id = (SELECT card_id FROM roster_cards WHERE roster_id = $1 ORDER BY card_id LIMIT 1 OFFSET $2)', [offensiveTeam.rosterId, offensiveTeam.battingOrderPosition]);
    const pitcherQuery = await pool.query(`SELECT * FROM cards_player WHERE card_id = (SELECT (lineup ->> 'startingPitcher')::integer FROM game_participants WHERE game_id = $1 AND user_id = $2)`, [gameId, defensiveTeam.userId]);

    res.json({
      game: game,
      gameState: stateResult.rows[0],
      gameEvents: eventsResult.rows,
      batter: batterQuery.rows[0] || null,
      pitcher: pitcherQuery.rows[0] || null,
    });

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
        const newState = applyOutcome(currentState, outcome);
        await client.query(`INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)`, [gameId, currentTurn + 1, newState]);
        await client.query(`INSERT INTO game_events (game_id, user_id, turn_number, event_type, log_message) VALUES ($1, $2, $3, $4, $5)`, [gameId, userId, currentTurn + 1, 'at_bat', logMessage]);
        const nextTurnUserId = defensiveTeam.userId;
        await client.query('UPDATE games SET current_turn_user_id = $1 WHERE game_id = $2', [nextTurnUserId, gameId]);
        await client.query('COMMIT');
        io.to(gameId).emit('game-updated');
        res.json({ message: 'Turn played', newGameState: newState, log: logMessage });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Error playing turn for game ${gameId}:`, error);
        res.status(500).json({ message: 'Server error while playing turn.' });
    } finally {
        client.release();
    }
});

// GET A USER'S PARTICIPANT INFO FOR A SPECIFIC GAME
app.get('/api/games/:gameId/my-roster', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const userId = req.user.userId;
  try {
    const result = await pool.query(
      `SELECT roster_id FROM game_participants WHERE game_id = $1 AND user_id = $2`,
      [gameId, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Participant not found in this game.' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching participant data.' });
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


// --- Socket.io Connection Logic ---
io.on('connection', (socket) => {
  console.log('A user connected');

  socket.on('join-game-room', (gameId) => {
    console.log(`User ${socket.id} is joining game room ${gameId}`);
    socket.join(gameId);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
  socket.on('choice-made', (data) => {
    // Broadcast the choice to others in the room
    socket.to(data.gameId).emit('choice-updated', { homeTeamUserId: data.homeTeamUserId });
});

socket.on('dh-rule-changed', (data) => {
    // Broadcast the DH rule change
    socket.to(data.gameId).emit('dh-rule-updated', { useDh: data.useDh });
});

});


// --- Server Startup Function (Updated) ---
async function startServer() {
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Database connection successful!');
    
    // Use server.listen instead of app.listen
    server.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });

  } catch (error) {
    console.error('❌ DATABASE CONNECTION FAILED:', error);
    process.exit(1);
  }
}

startServer();